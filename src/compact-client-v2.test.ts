import { afterEach, describe, expect, mock, test } from "bun:test";
import { executeV2Compaction, type V2CompactionResult } from "./compact-client-v2";
import { buildResponsesUrl } from "./runtime";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXTENSION_CONFIG } from "./types";

// ── Helpers ────────────────────────────────────────────────────────────

const baseModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	name: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

function createRuntime(overrides: Record<string, unknown> = {}) {
	return {
		provider: "openai",
		api: "openai-responses",
		model: "gpt-5-mini",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "sk-test",
		compactPath: "responses/compact",
		compactUrl: "https://api.openai.com/v1/responses/compact",
		responsesUrl: buildResponsesUrl("https://api.openai.com/v1", "openai-responses"),
		currentModel: baseModel,
		...overrides,
	} as never;
}

function createRequest(inputItems: unknown[] = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]) {
	return {
		model: "gpt-5-mini",
		instructions: "compact this",
		input: inputItems,
	};
}

/**
 * Build an SSE response body string from a list of events.
 * Each event is `data: <json>\n\n`.
 */
function sseBody(events: Array<{ type: string; [key: string]: unknown }>): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function sseResponse(events: Array<{ type: string; [key: string]: unknown }>, status = 200): Response {
	return new Response(sseBody(events), {
		status,
		headers: { "content-type": "text/event-stream" },
	});
}

function compactionOutputItemDone(encrypted_content: string, id?: string) {
	return {
		type: "response.output_item.done",
		item: {
			type: "compaction",
			...(id ? { id } : {}),
			encrypted_content,
		},
	};
}

function responseCompleted(responseId?: string, usage?: Record<string, unknown>, createdAt?: unknown) {
	return {
		type: "response.completed",
		response: {
			...(responseId ? { id: responseId } : {}),
			...(usage ? { usage } : {}),
			...(createdAt !== undefined ? { created_at: createdAt } : {}),
		},
	};
}

afterEach(() => {
	mock.restore();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("executeV2Compaction", () => {
	test("successful compaction with single compaction item", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				compactionOutputItemDone("encrypted-blob-abc", "cmp_123"),
				responseCompleted("resp_v2", { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }, 1750000000),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.compactionItem.type).toBe("compaction");
			expect(result.compactionItem.encrypted_content).toBe("encrypted-blob-abc");
			expect(result.compactionItem.id).toBe("cmp_123");
			expect(result.responseId).toBe("resp_v2");
			expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 200, total_tokens: 1200 });
			expect(result.createdAt).toBeDefined();
		}
	});

	test("appends compaction_trigger to the request input and sets stream: true", async () => {
		let requestBody: Record<string, unknown> = {};
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			return sseResponse([
				compactionOutputItemDone("blob"),
				responseCompleted(),
			]);
		}) as typeof fetch;

		await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest([{ role: "user", content: "test" }]),
			maxRetries: 0,
		});

		expect(requestBody.stream).toBe(true);
		const input = requestBody.input as unknown[];
		expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" });
		expect(input.length).toBe(2); // original + compaction_trigger
	});

	test("sends request to responsesUrl, not compactUrl", async () => {
		let fetchUrl = "";
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			fetchUrl = String(url);
			return sseResponse([compactionOutputItemDone("blob"), responseCompleted()]);
		}) as typeof fetch;

		await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(fetchUrl).toBe("https://api.openai.com/v1/responses");
		expect(fetchUrl).not.toContain("compact");
	});

	test("returns no-compaction-output when stream has no compaction items", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [] } },
				responseCompleted("resp_no_compaction"),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("no-compaction-output");
		}
	});

	test("returns multiple-compaction-outputs when stream has more than one compaction item", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				compactionOutputItemDone("blob-1", "cmp_1"),
				compactionOutputItemDone("blob-2", "cmp_2"),
				responseCompleted(),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("multiple-compaction-outputs");
			expect(result.errorMessage).toContain("2");
		}
	});

	test("returns non-2xx on HTTP error with error message extraction", async () => {
		globalThis.fetch = mock(async () =>
			new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non-2xx");
			expect(result.status).toBe(429);
			expect(result.errorMessage).toBe("Rate limit exceeded");
		}
	});

	test("returns network-error on fetch failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("DNS resolution failed");
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("network-error");
			expect(result.errorMessage).toBe("DNS resolution failed");
		}
	});

	test("returns aborted when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			signal: controller.signal,
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("aborted");
		}
	});

	test("returns aborted on AbortError from fetch", async () => {
		globalThis.fetch = mock(async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("aborted");
		}
	});

	test("retries on network-error and succeeds on second attempt", async () => {
		let attempt = 0;
		globalThis.fetch = mock(async () => {
			attempt++;
			if (attempt === 1) {
				throw new Error("Connection reset");
			}
			return sseResponse([
				compactionOutputItemDone("blob-retry"),
				responseCompleted("resp_retry"),
			]);
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 2,
		});

		expect(result.ok).toBe(true);
		expect(attempt).toBe(2);
	});

	test("does not retry on non-retryable errors (non-2xx)", async () => {
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 2,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non-2xx");
		}
		expect(fetchCount).toBe(1);
	});

	test("does not retry on abort", async () => {
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			throw new DOMException("aborted", "AbortError");
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 2,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("aborted");
		}
		expect(fetchCount).toBe(1);
	});

	test("returns retries-exhausted after all retry attempts fail", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("persistent network failure");
		}) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 1,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Either network-error (last failure) or retries-exhausted
			expect(["network-error", "retries-exhausted"]).toContain(result.reason);
		}
	});

	test("handles response.failed event in the stream", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				{ type: "response.failed", error: { message: "Server overloaded" } },
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("stream-parse-error");
			expect(result.errorMessage).toBe("Server overloaded");
		}
	});

	test("handles compaction_summary alias for type", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				{
					type: "response.output_item.done",
					item: {
						type: "compaction_summary",
						encrypted_content: "aliased-blob",
					},
				},
				responseCompleted("resp_alias"),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.compactionItem.encrypted_content).toBe("aliased-blob");
		}
	});

	test("handles [DONE] sentinel in the stream", async () => {
		const body = [
			`data: ${JSON.stringify(compactionOutputItemDone("blob"))}\n\n`,
			`data: ${JSON.stringify(responseCompleted("resp_done"))}\n\n`,
			"data: [DONE]\n\n",
		].join("");

		globalThis.fetch = mock(async () =>
			new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(true);
	});

	test("skips SSE comment lines and empty lines", async () => {
		const body = [
			": this is a comment\n\n",
			"\n",
			`data: ${JSON.stringify(compactionOutputItemDone("blob"))}\n\n`,
			`data: ${JSON.stringify(responseCompleted())}\n\n`,
		].join("");

		globalThis.fetch = mock(async () =>
			new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(true);
	});

	test("rejects compaction items with empty encrypted_content", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				{
					type: "response.output_item.done",
					item: { type: "compaction", encrypted_content: "" },
				},
				responseCompleted(),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("no-compaction-output");
		}
	});

	test("normalizes unix timestamp in created_at", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse([
				compactionOutputItemDone("blob"),
				responseCompleted("resp_ts", undefined, 1750000000),
			]),
		) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	test("stream with null body returns stream-parse-error", async () => {
		globalThis.fetch = mock(async () => ({
			ok: true,
			status: 200,
			body: null,
			headers: new Headers({ "content-type": "text/event-stream" }),
		})) as typeof fetch;

		const result = await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("stream-parse-error");
		}
	});

	test("uses accept: text/event-stream header", async () => {
		let fetchHeaders: Headers | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			fetchHeaders = new Headers(init?.headers);
			return sseResponse([compactionOutputItemDone("blob"), responseCompleted()]);
		}) as typeof fetch;

		await executeV2Compaction({
			runtime: createRuntime(),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(fetchHeaders?.get("accept")).toBe("text/event-stream");
		expect(fetchHeaders?.get("content-type")).toBe("application/json");
	});

	test("codex API sends codex-specific headers", async () => {
		const codexToken = (() => {
			const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct_456" },
				}),
			).toString("base64url");
			return `${header}.${payload}.signature`;
		})();

		let fetchHeaders: Headers | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			fetchHeaders = new Headers(init?.headers);
			return sseResponse([compactionOutputItemDone("blob"), responseCompleted()]);
		}) as typeof fetch;

		await executeV2Compaction({
			runtime: createRuntime({
				provider: "openai-codex",
				api: "openai-codex-responses",
				apiKey: codexToken,
				responsesUrl: buildResponsesUrl("https://chatgpt.com/backend-api", "openai-codex-responses"),
				currentModel: {
					...baseModel,
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
				},
			}),
			request: createRequest(),
			maxRetries: 0,
		});

		expect(fetchHeaders?.get("chatgpt-account-id")).toBe("acct_456");
		expect(fetchHeaders?.get("originator")).toBe("pi");
		expect(fetchHeaders?.get("openai-beta")).toBe("responses=experimental");
	});
});

describe("Copilot V2 protocol and stream safety", () => {
	test("uses Copilot ceiling and dynamic headers with resolved auth precedence", async () => {
		let body: any;
		let headers: Headers;
		globalThis.fetch = mock(async (_url, init) => {
			body = JSON.parse(String(init?.body));
			headers = new Headers(init?.headers);
			return sseResponse([compactionOutputItemDone("blob"), responseCompleted()]);
		}) as typeof fetch;
		const request = createRequest([{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test", detail: "auto" }] }]);
		await executeV2Compaction({ runtime: createRuntime({ provider: "github-copilot", headers: { "Authorization": "Bearer resolved", "X-Initiator": "agent", "x-remove": null }, currentModel: { ...baseModel, headers: { authorization: "Bearer stale", "x-remove": "stale" } } }), request, maxRetries: 0 });
		expect(body.max_output_tokens).toBe(20000);
		expect(body.store).toBe(false);
		expect(body.context_management).toBeUndefined();
		expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(headers!.get("authorization")).toBe("Bearer resolved");
		expect(headers!.get("x-remove")).toBeNull();
		expect(headers!.get("x-initiator")).toBe("agent");
		expect(headers!.get("openai-intent")).toBe("conversation-edits");
		expect(headers!.get("copilot-vision-request")).toBe("true");
		expect(request.input).toHaveLength(1);
	});

	test("does not add Copilot settings for other Responses providers", async () => {
		globalThis.fetch = mock(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body.max_output_tokens).toBeUndefined();
			expect(new Headers(init?.headers).get("x-initiator")).toBeNull();
			return sseResponse([compactionOutputItemDone("blob"), responseCompleted()]);
		}) as typeof fetch;
		expect((await executeV2Compaction({ runtime: createRuntime(), request: createRequest() })).ok).toBe(true);
	});

	for (const item of [
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "must not lose me" }] },
		{ type: "function_call", call_id: "tail", name: "read", arguments: "{}" },
		{ type: "reasoning", encrypted_content: "not-a-compaction" },
	]) {
		test(`rejects post-blob ${item.type} rather than silently dropping it`, async () => {
			globalThis.fetch = mock(async () => sseResponse([compactionOutputItemDone("blob"), { type: "response.output_item.done", item }, responseCompleted()])) as typeof fetch;
			const result = await executeV2Compaction({ runtime: createRuntime(), request: createRequest() });
			expect(result).toMatchObject({ ok: false, reason: "unexpected-output-after-compaction", status: 200 });
		});
	}

	test("encrypted reasoning alone is not native compaction", async () => {
		globalThis.fetch = mock(async () => sseResponse([{ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "reasoning-only" } }, responseCompleted()])) as typeof fetch;
		expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest() })).toMatchObject({ ok: false, reason: "no-compaction-output", outputItemTypes: ["reasoning"] });
	});

	test("requires response.completed, not EOF or DONE after blob", async () => {
		globalThis.fetch = mock(async () => new Response(sseBody([compactionOutputItemDone("blob")]) + 'data: [DONE]\n\n')) as typeof fetch;
		expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest() })).toMatchObject({ ok: false, reason: "incomplete-stream" });
	});

	test("reads chunked CRLF and final line without newline, using terminal output without duplicates", async () => {
		const terminal = { type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "blob" }] } };
		const text = sseBody([compactionOutputItemDone("blob")]).replaceAll('\n', '\r\n') + `data:${JSON.stringify(terminal)}`;
		globalThis.fetch = mock(async () => new Response(new ReadableStream({ start(controller) { for (const char of text) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } }))) as typeof fetch;
		const result = await executeV2Compaction({ runtime: createRuntime(), request: createRequest() });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.compactionItem).toEqual({ type: "compaction", encrypted_content: "blob" });
	});

	test("checks post-blob ordering in authoritative completed.output too", async () => {
		globalThis.fetch = mock(async () => sseResponse([compactionOutputItemDone("blob"), { type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "blob" }, { type: "message" }] } }])) as typeof fetch;
		expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest() })).toMatchObject({ ok: false, reason: "unexpected-output-after-compaction" });
	});

	for (const type of ["response.failed", "response.incomplete"]) {
		test(`rejects ${type} after a compaction item`, async () => {
			globalThis.fetch = mock(async () => sseResponse([compactionOutputItemDone("blob"), { type, response: { error: { message: "failure" } } }])) as typeof fetch;
			expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest(), maxRetries: 0 })).toMatchObject({ ok: false, reason: "stream-parse-error", errorMessage: "failure" });
		});
	}

	test("malformed SSE cannot be ignored before accepting a checkpoint", async () => {
		globalThis.fetch = mock(async () => new Response('data: {broken}\n\n' + sseBody([compactionOutputItemDone("blob"), responseCompleted()]))) as typeof fetch;
		expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest(), maxRetries: 0 })).toMatchObject({ ok: false, reason: "stream-parse-error" });
	});

	for (const mode of ["cancel", "timeout"]) {
		test(`${mode} unblocks a pending stream read and does not retry`, async () => {
			const controller = new AbortController();
			let calls = 0;
			let cancelled = false;
			globalThis.fetch = mock(async () => {
				calls++;
				return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sseBody([compactionOutputItemDone("blob")]))); }, cancel() { cancelled = true; } }));
			}) as typeof fetch;
			const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 10) : undefined;
			try {
				const result = await executeV2Compaction({ runtime: createRuntime(), request: createRequest(), signal: controller.signal, timeoutMs: mode === "timeout" ? 10 : 1000 });
				expect(result).toMatchObject({ ok: false, reason: mode === "timeout" ? "timeout" : "aborted" });
				expect(calls).toBe(1);
				expect(cancelled).toBe(true);
			} finally { clearTimeout(timer); }
		});
	}
});

test("V2 failure diagnostics work with raw logging off and never include credentials, state or server echoes", async () => {
	const root = mkdtempSync(join(tmpdir(), "compaction-diagnostics-"));
	try {
		globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { message: "echo private-credential private-blob private-prompt" } }), { status: 401 })) as typeof fetch;
		await executeV2Compaction({
			runtime: createRuntime({ apiKey: "private-credential", headers: { authorization: "Bearer private-credential" }, responsesUrl: "https://example.com/responses?key=private-credential" }),
			request: createRequest([{ type: "compaction", encrypted_content: "private-blob" }, { role: "user", content: "private-prompt" }]),
			settings: { ...DEFAULT_EXTENSION_CONFIG, debug: true, logCompactResponses: false, logProviderPayloads: false, redactSensitiveData: false, artifactRoot: root },
			context: { cwd: root, sessionId: "synthetic" },
		});
		const dir = join(root, "sessions", "synthetic", "compaction-events");
		const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
		const data = JSON.parse(text).data;
		expect(data).toMatchObject({ destination: "https://example.com/responses", protocol: "compaction_trigger", status: 401, reason: "non-2xx", compactionBlobPresent: false });
		for (const secret of ["private-credential", "private-blob", "private-prompt"]) expect(text).not.toContain(secret);
		expect(readdirSync(join(root, "sessions", "synthetic"))).toEqual(["compaction-events"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("V2 preserves a known transport failure code without relying on raw error logging", async () => {
	globalThis.fetch = mock(async () => { throw new Error("fetch failed", { cause: { code: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH" } }); }) as typeof fetch;
	expect(await executeV2Compaction({ runtime: createRuntime(), request: createRequest(), maxRetries: 0 })).toMatchObject({ ok: false, reason: "network-error", transportCode: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH" });
});
