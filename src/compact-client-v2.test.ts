import { afterEach, describe, expect, mock, test } from "bun:test";
import { executeV2Compaction, type V2CompactionResult } from "./compact-client-v2";
import { buildResponsesUrl } from "./runtime";

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
