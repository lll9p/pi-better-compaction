import { afterEach, describe, expect, test } from "bun:test";
import {
	ANTHROPIC_BLOCK_REJECTED_ENTRY,
	ANTHROPIC_COMPACTION_BETA,
	buildCompactionPayload,
	clearAnthropicTools,
	executeAnthropicCompaction,
	parseAnthropicCompactionResponse,
} from "./anthropic-compaction";
import { registerExtensionRuntime } from "./extension-runtime";
import {
	ANTHROPIC_COMPACTION_STRATEGY,
	DEFAULT_EXTENSION_CONFIG,
	createNativeCompactionDetails,
} from "./types";

const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const BLOCK = { type: "compaction", content: "Cat is Biscuit; codename HERON-7.", signature: "sig-abc" };

const opus = {
	provider: "cliproxyapi-anthropic",
	api: "anthropic-messages",
	id: "claude-opus-5-5",
	baseUrl: "https://dev1.example.net",
	input: ["text"],
	reasoning: true,
};
const sonnet = { ...opus, id: "claude-sonnet-5" };
const astra = {
	provider: "cliproxyapi",
	api: "openai-responses",
	id: "gpt-6-astra",
	baseUrl: "https://dev1.example.net/v1",
	input: ["text"],
	reasoning: true,
};

function sse(events: unknown[]): string {
	return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function compactionSse(block: Record<string, unknown> = BLOCK): string {
	return sse([
		{ type: "message_start", message: { id: "msg_1", content: [] } },
		{ type: "content_block_start", index: 0, content_block: block },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "compaction" } },
		{ type: "message_stop" },
	]);
}

function userEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		timestamp: "2026-09-23T08:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
}

function anthropicCompactionEntry(id: string, firstKeptEntryId: string, model = opus) {
	return {
		type: "compaction",
		id,
		timestamp: "2026-09-23T08:01:00.000Z",
		summary: BLOCK.content,
		firstKeptEntryId,
		tokensBefore: 900_000,
		details: createNativeCompactionDetails(
			{
				provider: model.provider,
				api: model.api,
				model: model.id,
				baseUrl: model.baseUrl,
				compactedWindow: [BLOCK],
			},
			ANTHROPIC_COMPACTION_STRATEGY,
		),
	};
}

/** What pi-ai sends after a compaction: Pi's summary first, then kept and new messages. */
function piPayload(model = opus, summary = BLOCK.content) {
	return {
		model: model.id,
		max_tokens: 1000,
		stream: true,
		betas: ["thinking-binding-controls-2026-08-01"],
		tools: [{ name: "read", input_schema: { type: "object" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}${summary}\n</summary>` }] },
			{ role: "user", content: [{ type: "text", text: "kept" }] },
			{ role: "user", content: [{ type: "text", text: "next question" }] },
		],
	};
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(anthropicResult: Record<string, unknown> = { ok: true, block: BLOCK, messageId: "msg_1" }) {
	const handlers = new Map<string, Handler>();
	const anthropicCalls: Array<Record<string, unknown>> = [];
	const fallbackCalls: unknown[] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	registerExtensionRuntime(
		{
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			getThinkingLevel: () => "high",
			appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		} as never,
		{
			loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG }, warnings: [] }),
			executeNativeCompaction: async () => ({ ok: false, reason: "network-error" }) as never,
			executeV2Compaction: async () => ({ ok: false, reason: "network-error" }) as never,
			runNativeFallbackCompaction: async () => {
				fallbackCalls.push(true);
				return { ok: false, reason: "no-model-configured" } as never;
			},
			executeAnthropicCompaction: async (args) => {
				anthropicCalls.push(args as never);
				return anthropicResult as never;
			},
		},
	);
	const context = (model: Record<string, unknown>, branch: unknown[]) => ({
		cwd: "/tmp/pbc-anthropic-test",
		hasUI: false,
		model,
		getSystemPrompt: () => "system prompt",
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: { "x-drop": null, "x-keep": "1" } }),
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp/pbc-anthropic-test",
			buildSessionContext: () => ({ messages: [] }),
		},
	});
	const call = (name: string, event: unknown, ctx: unknown) => handlers.get(name)!(event, ctx);
	return { call, context, anthropicCalls, fallbackCalls, appended };
}

function compactEvent(messagesToSummarize: unknown[], firstKeptEntryId = "kept") {
	return {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: { tokensBefore: 900_000, firstKeptEntryId, messagesToSummarize, turnPrefixMessages: [] },
	};
}

afterEach(() => clearAnthropicTools());

describe("buildCompactionPayload", () => {
	test("asks for a summary with the beta and drops fields the API rejects", () => {
		const payload = buildCompactionPayload(
			{
				model: "claude-opus-5-5",
				messages: [{ role: "user", content: "hi" }],
				betas: ["x"],
				context_management: { edits: [] },
				stop_sequences: ["END"],
				output_config: { effort: "high", format: { type: "json_schema" } },
				tool_choice: { type: "tool", name: "read" },
			},
			{ instructions: "  focus on files ", tools: [{ name: "read" }] },
		)!;
		expect(payload.compaction).toEqual({ type: "summarize", instructions: "focus on files" });
		expect(payload.betas).toEqual(["x", ANTHROPIC_COMPACTION_BETA]);
		expect(payload.tools).toEqual([{ name: "read" }]);
		expect(payload.output_config).toEqual({ effort: "high" });
		for (const key of ["context_management", "stop_sequences", "tool_choice"]) {
			expect(payload[key]).toBeUndefined();
		}
	});

	test("omitThinking drops thinking and keeps everything else", () => {
		const source = {
			model: "claude-opus-5-5",
			messages: [{ role: "user", content: "hi" }],
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		};
		expect(buildCompactionPayload(source, {})!.thinking).toEqual(source.thinking);
		const payload = buildCompactionPayload(source, { omitThinking: true })!;
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "high" });
		expect(payload.compaction).toEqual({ type: "summarize" });
	});

	test("puts the prior block first, verbatim, in place of Pi's summary", () => {
		const entry = anthropicCompactionEntry("c1", "kept");
		const payload = buildCompactionPayload(piPayload(), {
			priorReplay: { entry: entry as never, block: BLOCK as never },
		})!;
		expect(payload.messages[0]).toEqual({ role: "assistant", content: [BLOCK] });
		expect(payload.messages).toHaveLength(3);
	});
});

describe("parseAnthropicCompactionResponse", () => {
	test("accumulates a streamed compaction block, including deltas", () => {
		const body = sse([
			{ type: "message_start", message: { id: "msg_9" } },
			{ type: "content_block_start", index: 0, content_block: { type: "compaction", content: "Part one", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: " and two" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-9" } },
			{ type: "message_delta", delta: { stop_reason: "compaction" } },
		]);
		expect(parseAnthropicCompactionResponse(body)).toEqual({
			ok: true,
			messageId: "msg_9",
			block: { type: "compaction", content: "Part one and two", signature: "sig-9" },
		});
	});

	test("accepts a non-streamed message", () => {
		const body = JSON.stringify({ id: "msg_2", stop_reason: "compaction", content: [BLOCK] });
		expect(parseAnthropicCompactionResponse(body)).toEqual({ ok: true, messageId: "msg_2", block: BLOCK });
	});

	test("rejects errors, other stop reasons, unsigned and extra blocks", () => {
		expect(parseAnthropicCompactionResponse(sse([{ type: "error", error: { message: "overloaded" } }])))
			.toEqual({ ok: false, errorMessage: "overloaded" });
		const endTurn = sse([
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
		]);
		expect(parseAnthropicCompactionResponse(endTurn).ok).toBe(false);
		expect(parseAnthropicCompactionResponse(compactionSse({ type: "compaction", content: "x" })).ok).toBe(false);
		const two = JSON.stringify({ stop_reason: "compaction", content: [BLOCK, BLOCK] });
		expect(parseAnthropicCompactionResponse(two).ok).toBe(false);
	});
});

describe("executeAnthropicCompaction", () => {
	test("sends Pi's request with the compaction parameter and returns the raw block", async () => {
		const originalFetch = globalThis.fetch;
		let sentBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			sentBody = JSON.parse(String(init?.body));
			return new Response(compactionSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		try {
			const result = await executeAnthropicCompaction({
				model: opus as never,
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 1 }] as never,
				complete: (async (_model: unknown, _context: unknown, options: Record<string, any>) => {
					const payload = await options.onPayload({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
					const response = await options.fetch("https://dev1.example.net/v1/messages", {
						method: "POST",
						body: JSON.stringify(payload),
					});
					await response.text();
					// pi-ai does not know stop_reason "compaction" and reports an error.
					return { stopReason: "error", errorMessage: "Unhandled stop reason: compaction" };
				}) as never,
			});
			expect(result).toEqual({ ok: true, block: BLOCK, messageId: "msg_1" });
			expect(sentBody?.compaction).toEqual({ type: "summarize" });
			expect(sentBody?.betas).toEqual([ANTHROPIC_COMPACTION_BETA]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("reports provider rejection as a failure", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('{"type":"error","error":{"message":"bad"}}', { status: 400 })) as unknown as typeof fetch;
		try {
			const result = await executeAnthropicCompaction({
				model: opus as never,
				systemPrompt: "sys",
				messages: [],
				complete: (async (_model: unknown, _context: unknown, options: Record<string, any>) => {
					await options.fetch("https://dev1.example.net/v1/messages", { method: "POST", body: "{}" });
					return { stopReason: "error", errorMessage: "400 bad" };
				}) as never,
			});
			expect(result).toEqual({ ok: false, reason: "request-failed", status: 400, errorMessage: "400 bad" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("executeAnthropicCompaction with a gateway that injects context_management", () => {
	const CONFLICT =
		'{"type":"error","error":{"type":"invalid_request_error","message":"compaction and context_management cannot be used in the same request"}}';
	const THINKING = { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } };

	/** Stands in for pi-ai: builds the payload through onPayload and posts it through the wrapped fetch. */
	function fakeComplete(source: Record<string, unknown>) {
		return (async (_model: unknown, _context: unknown, options: Record<string, any>) => {
			const payload = await options.onPayload(structuredClone(source));
			const response = await options.fetch("https://dev1.example.net/v1/messages", {
				method: "POST",
				body: JSON.stringify(payload),
			});
			await response.text();
			return response.ok
				? { stopReason: "error", errorMessage: "Unhandled stop reason: compaction" }
				: { stopReason: "error", errorMessage: `${response.status} rejected` };
		}) as never;
	}

	/** Rejects any body that carries thinking the way CLIProxyAPI's injection makes Anthropic reject it. */
	async function withGateway(
		run: () => Promise<unknown>,
		respond: (body: Record<string, unknown>) => Response = (body) =>
			body.thinking
				? new Response(CONFLICT, { status: 400 })
				: new Response(compactionSse(), { status: 200, headers: { "content-type": "text/event-stream" } }),
	) {
		const originalFetch = globalThis.fetch;
		const sent: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body);
			return respond(body);
		}) as typeof fetch;
		try {
			return { result: await run(), sent };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	const base = { model: opus as never, systemPrompt: "sys", messages: [] };
	const source = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], thinking: THINKING };

	test("retries once without thinking and returns the block", async () => {
		const { result, sent } = await withGateway(() =>
			executeAnthropicCompaction({ ...base, complete: fakeComplete(source) }),
		);
		expect(result).toEqual({ ok: true, block: BLOCK, messageId: "msg_1", retriedWithoutThinking: true });
		expect(sent).toHaveLength(2);
		expect(sent[0]!.thinking).toEqual(THINKING);
		expect(sent[1]!.thinking).toBeUndefined();
		expect(sent[1]!.compaction).toEqual({ type: "summarize" });
		expect(sent[1]!.messages).toEqual(sent[0]!.messages);
	});

	test("does not retry when no thinking was sent", async () => {
		const { result, sent } = await withGateway(
			() => executeAnthropicCompaction({ ...base, complete: fakeComplete({ ...source, thinking: undefined }) }),
			() => new Response(CONFLICT, { status: 400 }),
		);
		expect(sent).toHaveLength(1);
		expect(result).toMatchObject({ ok: false, reason: "request-failed", status: 400 });
	});

	test("does not retry other 400s", async () => {
		const { result, sent } = await withGateway(
			() => executeAnthropicCompaction({ ...base, complete: fakeComplete(source) }),
			() => new Response('{"type":"error","error":{"message":"prompt is too long"}}', { status: 400 }),
		);
		expect(sent).toHaveLength(1);
		expect(result).toMatchObject({ ok: false, reason: "request-failed", status: 400 });
	});

	test("reports the retry's failure when the retry also fails", async () => {
		const { result, sent } = await withGateway(
			() => executeAnthropicCompaction({ ...base, complete: fakeComplete(source) }),
			(body) =>
				body.thinking
					? new Response(CONFLICT, { status: 400 })
					: new Response('{"type":"error","error":{"message":"overloaded"}}', { status: 529 }),
		);
		expect(sent).toHaveLength(2);
		expect(result).toMatchObject({ ok: false, reason: "request-failed", status: 529 });
	});
});

describe("runtime", () => {
	test("session_before_compact stores the signed block keyed by provider and model", async () => {
		const h = harness();
		const branch = [userEntry("u1", "old"), userEntry("kept", "kept")];
		// Remember tools from a live request first.
		await h.call("before_provider_request", { payload: { ...piPayload(), messages: [] } }, h.context(opus, branch));

		const result = (await h.call(
			"session_before_compact",
			compactEvent([branch[0]!.message]),
			h.context(opus, branch),
		)) as { compaction: Record<string, any> };

		expect(h.anthropicCalls).toHaveLength(1);
		const call = h.anthropicCalls[0]!;
		expect(call.headers).toEqual({ "x-keep": "1" });
		expect(call.reasoning).toBe("high");
		expect(call.priorReplay).toBeUndefined();
		expect(call.tools).toEqual([{ name: "read", input_schema: { type: "object" } }]);
		expect(result.compaction.summary).toBe(BLOCK.content);
		expect(result.compaction.firstKeptEntryId).toBe("kept");
		expect(result.compaction.details).toMatchObject({
			strategy: ANTHROPIC_COMPACTION_STRATEGY,
			provider: "cliproxyapi-anthropic",
			api: "anthropic-messages",
			model: "claude-opus-5-5",
			baseUrl: "https://dev1.example.net",
			compactedWindow: [BLOCK],
			compactResponseId: "msg_1",
		});
		expect(h.fallbackCalls).toHaveLength(0);
	});

	test("a second compaction summarizes the prior block plus the new messages", async () => {
		const h = harness();
		const branch = [userEntry("kept", "kept"), anthropicCompactionEntry("c1", "kept"), userEntry("u2", "new")];
		await h.call("session_before_compact", compactEvent([branch[0]!.message, branch[2]!.message], "u2"), h.context(opus, branch));
		const call = h.anthropicCalls[0]!;
		expect((call.priorReplay as { entry: { id: string } }).entry.id).toBe("c1");
		expect((call.messages as Array<{ role: string }>).map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"user",
		]);
	});

	test("replays the block through the payload rewrite", async () => {
		const h = harness();
		const branch = [userEntry("kept", "kept"), anthropicCompactionEntry("c1", "kept"), userEntry("u2", "next question")];
		const rewritten = (await h.call("before_provider_request", { payload: piPayload() }, h.context(opus, branch))) as any;
		expect(rewritten.messages[0]).toEqual({ role: "assistant", content: [BLOCK] });
		expect(rewritten.messages.slice(1)).toEqual(piPayload().messages.slice(1));
		expect(rewritten.betas).toEqual(["thinking-binding-controls-2026-08-01", ANTHROPIC_COMPACTION_BETA]);
	});

	test("keeps Pi's summary after a switch to another model or provider", async () => {
		const h = harness();
		const branch = [userEntry("kept", "kept"), anthropicCompactionEntry("c1", "kept"), userEntry("u2", "next")];
		expect(await h.call("before_provider_request", { payload: piPayload(sonnet) }, h.context(sonnet, branch))).toBeUndefined();

		const responsesPayload = { model: astra.id, input: [{ role: "user", content: "next" }] };
		expect(await h.call("before_provider_request", { payload: responsesPayload }, h.context(astra, branch))).toBeUndefined();

		// A compaction on the Responses route never receives the Anthropic block.
		await h.call("session_before_compact", compactEvent([branch[2]!.message], "u2"), h.context(astra, branch));
		expect(h.anthropicCalls).toHaveLength(0);
		expect(h.fallbackCalls).toHaveLength(1);

		// Back on Sonnet, the Opus block is not replayed into its summary request.
		await h.call("session_before_compact", compactEvent([branch[2]!.message], "u2"), h.context(sonnet, branch));
		expect(h.anthropicCalls[0]!.priorReplay).toBeUndefined();
	});

	test("a 400 on a replayed request retires the block; later requests keep Pi's summary", async () => {
		const h = harness();
		const branch: unknown[] = [userEntry("kept", "kept"), anthropicCompactionEntry("c1", "kept"), userEntry("u2", "next")];
		expect(await h.call("before_provider_request", { payload: piPayload() }, h.context(opus, branch))).toBeDefined();
		await h.call("after_provider_response", { status: 400, headers: {} }, h.context(opus, branch));
		expect(h.appended).toEqual([{ customType: ANTHROPIC_BLOCK_REJECTED_ENTRY, data: { compactionEntryId: "c1" } }]);

		branch.push({ type: "custom", id: "r1", customType: ANTHROPIC_BLOCK_REJECTED_ENTRY, data: { compactionEntryId: "c1" } });
		expect(await h.call("before_provider_request", { payload: piPayload() }, h.context(opus, branch))).toBeUndefined();
	});

	test("a 200 keeps the block, and a payload without Pi's summary first is left alone", async () => {
		const h = harness();
		const branch = [userEntry("kept", "kept"), anthropicCompactionEntry("c1", "kept")];
		await h.call("before_provider_request", { payload: piPayload() }, h.context(opus, branch));
		await h.call("after_provider_response", { status: 200, headers: {} }, h.context(opus, branch));
		expect(h.appended).toHaveLength(0);
		const other = piPayload(opus, "something else");
		expect(await h.call("before_provider_request", { payload: other }, h.context(opus, branch))).toBeUndefined();
	});

	test("a failed server compaction falls back to Pi's compaction", async () => {
		const h = harness({ ok: false, reason: "request-failed", status: 400, errorMessage: "no" });
		const result = await h.call("session_before_compact", compactEvent([userEntry("u1", "x").message]), h.context(opus, []));
		expect(h.fallbackCalls).toHaveLength(1);
		expect(result).toBeUndefined();
	});
});
