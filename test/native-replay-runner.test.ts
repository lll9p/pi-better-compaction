import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerExtensionRuntime } from "../src/extension-runtime";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY_V2 } from "../src/types";
import { serializeMessagesToResponsesInput } from "../src/serializer";
import { clearRequestContextCache, rememberRequestContext } from "../src/request-context-cache";

afterEach(clearRequestContextCache);

// Use real runner/Agent/provider implementations, not the package mock in test/setup.
// PI_TEST_SDK_ROOT lets the same test also exercise the user's installed Pi version.
const sdkRoot = process.env.PI_TEST_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const sdkResolve = (name: string) => import.meta.resolve(name, join(sdkRoot, "dist/index.js"));
const aiRoot = dirname(dirname(fileURLToPath(sdkResolve("@earendil-works/pi-ai"))));
const { ExtensionRunner } = await import(join(sdkRoot, "dist/core/extensions/runner.js"));
const { SessionManager } = await import(join(sdkRoot, "dist/core/session-manager.js"));
const { convertToLlm } = await import(join(sdkRoot, "dist/core/messages.js"));
const { Agent } = await import(sdkResolve("@earendil-works/pi-agent-core"));
const { stream: responses } = await import(join(aiRoot, "dist/api/openai-responses.js"));
const { stream: anthropic } = await import(join(aiRoot, "dist/api/anthropic-messages.js"));
const { stream: google } = await import(join(aiRoot, "dist/api/google-generative-ai.js"));
const sdkVersions = `Pi ${JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version}, pi-ai ${JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")).version}`;
const { convertResponsesMessages } = await import(join(aiRoot, "dist/api/openai-responses-shared.js"));

const model: any = { provider: "github-copilot", api: "openai-responses", id: "gpt-6-astra", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 400000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const foreign = { ...model, provider: "openai", model: "other-model", api: "openai-responses" };
const assistant = (content: any[], identity = model) => ({ role: "assistant", provider: identity.provider, api: identity.api, model: identity.model ?? identity.id, content, stopReason: "stop", timestamp: 100 });
const unsigned = assistant([{ type: "text", text: "Unsigned kept text one" }, { type: "text", text: "Unsigned kept text two" }]);
const mixed = assistant([
	{ type: "text", text: "Foreign kept text", textSignature: JSON.stringify({ v: 1, id: "msg_foreign", phase: "commentary" }) },
	{ type: "thinking", thinking: "foreign thinking becomes text", thinkingSignature: JSON.stringify({ type: "reasoning", id: "foreign-rs", encrypted_content: "foreign-state" }) },
	{ type: "toolCall", id: "bad:call|foreign$item", name: "read", arguments: { path: "synthetic" } },
], foreign);

function fixture(keptAssistant = unsigned, withCheckpoint = true) {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Old question", timestamp: 1 });
	session.appendMessage(assistant([{ type: "text", text: "FACT-ONLY-BEFORE-KEPT-BOUNDARY" }]));
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "Kept user without the old fact", timestamp: 2 });
	session.appendMessage(keptAssistant);
	if (withCheckpoint) session.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, firstKeptEntryId, 500, createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, compactedWindow: [{ type: "compaction", encrypted_content: "opaque-test-fixture" }] }, NATIVE_COMPACTION_STRATEGY_V2));
	return { session, firstKeptEntryId };
}

type Options = { currentModel?: any; keptAssistant?: any; config?: any; auth?: any; checkpoint?: boolean; mutateSession?: (session: any) => void; mutatePayload?: (payload: any) => any; throwOnly?: boolean; abortThenThrow?: boolean; throwConfig?: boolean; throwNotice?: boolean; lateGuardOnly?: boolean; nativeSuccess?: boolean };
function harness(options: Options = {}) {
	const { session, firstKeptEntryId } = fixture(options.keptAssistant, options.checkpoint !== false);
	options.mutateSession?.(session);
	const currentModel = options.currentModel ?? model;
	const handlers = new Map<string, any[]>();
	let fallbackCalls = 0;
	let nativeCalls = 0;
	const nativeInputs: unknown[][] = [];
	const newCompactionItem = { type: "compaction", encrypted_content: "new-opaque-test-fixture" };
	registerExtensionRuntime({ on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) } as any, {
		loadExtensionConfig: () => { if (options.throwConfig) throw new Error("configuration unavailable"); return { config: { ...DEFAULT_EXTENSION_CONFIG, ...options.config }, warnings: [] }; },
		executeNativeCompaction: async ({ request }: any) => {
			nativeCalls++;
			nativeInputs.push(structuredClone(request.input));
			return options.nativeSuccess ? { ok: true, status: 200, compactedWindow: [newCompactionItem], response: { output: [newCompactionItem] } } : { ok: false, reason: "non-2xx", status: 404 };
		},
		executeV2Compaction: async ({ request }: any) => {
			nativeCalls++;
			nativeInputs.push(structuredClone(request.input));
			return options.nativeSuccess ? { ok: true, compactionItem: newCompactionItem } : { ok: false, reason: "no-compaction-output" };
		},
		runNativeFallbackCompaction: async () => { fallbackCalls++; return { ok: false, reason: "no-model-configured" }; },
	} as any);
	if (options.lateGuardOnly) handlers.delete("context");
	if (options.throwOnly || options.abortThenThrow) handlers.set("before_provider_request", [(_event: any, ctx: any) => { if (options.abortThenThrow) ctx.abort(); throw new Error("throw-only control"); }]);
	const registry = { getApiKeyAndHeaders: async () => { if (options.auth instanceof Error) throw options.auth; return options.auth ?? { ok: true, apiKey: "synthetic-not-a-credential" }; } };
	const runner = new ExtensionRunner([{ path: "pi-better-compaction", handlers }], { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] }, process.cwd(), session, registry);
	const notices: string[] = [];
	runner.setUIContext({ ...runner.getUIContext(), notify: (message: string) => { notices.push(message); if (options.throwNotice) throw new Error("UI unavailable"); } });
	const errors: string[] = [];
	runner.onError((error: any) => errors.push(error.error));
	const sent: any[] = [];
	let aborts = 0;
	let payloadSeen: any;
	const fakeFetch = async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response("Fake transport; no network", { status: 400 }); };
	const agent = new Agent({
		initialState: { model: currentModel, systemPrompt: "Fresh instructions", messages: session.buildSessionContext().messages },
		convertToLlm,
		transformContext: (messages: any[]) => runner.emitContext(messages),
		getApiKey: () => "synthetic-not-a-credential",
		streamFn: (m: any, c: any, opts: any) => (m.api === "google-generative-ai" ? google : m.api === "anthropic-messages" ? anthropic : responses)(m, c, { ...opts, maxTokens: 16, maxRetries: 0, fetch: m.api === "google-generative-ai" ? undefined : fakeFetch }),
		onPayload: (payload: any) => { payloadSeen = currentModel.api === "google-generative-ai" ? payload : structuredClone(payload); return runner.emitBeforeProviderRequest(options.mutatePayload?.(payload) ?? payload); },
	});
	runner.bindCore({}, { getModel: () => currentModel, getSignal: () => agent.signal, abort: () => { aborts++; agent.abort(); }, getSystemPrompt: () => "Fresh instructions" });
	return { session, runner, agent, sent, notices, errors, firstKeptEntryId, nativeInputs, fakeFetch, requiresGlobalFake: currentModel.api === "google-generative-ai", get aborts() { return aborts; }, get payloadSeen() { return payloadSeen; }, get fallbackCalls() { return fallbackCalls; }, get nativeCalls() { return nativeCalls; } };
}

async function run(h: ReturnType<typeof harness>) {
	const tail = { role: "user", content: "Follow-up after the checkpoint", timestamp: 200 };
	h.session.appendMessage(tail);
	// Google's adapter rejects custom fetch; replace global fetch for the entire
	// awaited run instead. Even the deliberately unguarded control cannot network.
	const originalFetch = globalThis.fetch;
	if (h.requiresGlobalFake) globalThis.fetch = h.fakeFetch as typeof fetch;
	try { await h.agent.prompt(tail); }
	finally { if (h.requiresGlobalFake) globalThis.fetch = originalFetch; }
}

describe(`native checkpoint cancellation through real Pi runner, Agent and provider SDK (${sdkVersions})`, () => {
	test("throw-only control really reaches fake transport; ctx.abort plus throw does not", async () => {
		const unsafe = harness({ throwOnly: true });
		await run(unsafe);
		expect(unsafe.sent).toHaveLength(1);
		expect(unsafe.errors).toHaveLength(1);
		expect(JSON.stringify(unsafe.sent[0])).not.toContain("opaque-test-fixture");
		expect(JSON.stringify(unsafe.sent[0])).not.toContain("FACT-ONLY-BEFORE-KEPT-BOUNDARY");
		const aborted = harness({ abortThenThrow: true });
		await run(aborted);
		expect(aborted.sent).toHaveLength(0);
		expect(aborted.agent.state.messages.at(-1).stopReason).toBe("aborted");
	});

	test("Gemini negative control: a late abort alone still invokes fake fetch, so the context guard is required", async () => {
		const h = harness({ lateGuardOnly: true, currentModel: { ...model, provider: "google", api: "google-generative-ai", id: "gemini-2.5-flash" } });
		await run(h);
		expect(h.aborts).toBe(1);
		expect(h.sent).toHaveLength(1);
		expect(h.agent.state.messages.at(-1).stopReason).toBe("aborted");
	});

	for (const [name, keptAssistant] of [["unsigned multiple text blocks", unsigned], ["cross-model signed text/thinking/tool call", mixed], ["signed same-model", assistant([{ type: "text", text: "Signed kept text", textSignature: "msg_signed" }])]] as const) {
		test(`same checkpoint identity replays ${name} through real provider serialization`, async () => {
			const h = harness({ keptAssistant });
			await run(h);
			expect(h.sent).toHaveLength(1);
			expect(h.aborts).toBe(0);
			expect(h.errors).toHaveLength(0);
			expect(h.sent[0].input).toContainEqual({ type: "compaction", encrypted_content: "opaque-test-fixture" });
			expect(JSON.stringify(h.sent[0])).not.toContain("FACT-ONLY-BEFORE-KEPT-BOUNDARY");
			expect(JSON.stringify(h.sent[0].input.at(-1))).toContain("Follow-up after the checkpoint");
			expect(JSON.stringify(h.payloadSeen)).not.toContain("FACT-ONLY-BEFORE-KEPT-BOUNDARY");
		});
	}

	const failures: [string, Options][] = [
		["model mismatch", { currentModel: { ...model, id: "other-model" } }],
		["OAuth endpoint mismatch", { auth: { ok: true, apiKey: "synthetic", baseUrl: "https://different.invalid" } }],
		["unsupported Anthropic provider", { currentModel: { ...model, provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-5" } }],
		["unsupported Gemini provider", { currentModel: { ...model, provider: "google", api: "google-generative-ai", id: "gemini-2.5-flash" } }],
		["extension disabled", { config: { enabled: false } }],
		["API disabled", { config: { responsesCompactApis: [] } }],
		["missing auth", { auth: { ok: false, error: "auth unavailable" } }],
		["auth exception", { auth: new Error("auth unavailable") }],
		["configuration exception", { throwConfig: true }],
		["payload model mismatch", { mutatePayload: p => ({ ...p, model: "wrong" }) }],
		["unsupported payload", { mutatePayload: () => ({ messages: [] }) }],
		["semantic parity mismatch", { mutatePayload: p => ({ ...p, input: [...p.input, { role: "user", content: "unexpected injected content" }] }) }],
		["signature/ID parity mismatch", { mutatePayload: p => ({ ...p, input: p.input.map((i: any) => i.role === "assistant" ? { ...i, id: "wrong-id" } : i) }) }],
		["damaged native details", { mutateSession: s => { s.getLeafEntry().details.compactedWindow = null; } }],
		["empty native window", { mutateSession: s => { s.getLeafEntry().details.compactedWindow = []; } }],
		["reasoning-only native window", { mutateSession: s => { s.getLeafEntry().details.compactedWindow = [{ type: "reasoning", encrypted_content: "not-a-checkpoint" }]; } }],
		["blank native blob", { mutateSession: s => { s.getLeafEntry().details.compactedWindow[0].encrypted_content = ""; } }],
		["missing native details with checkpoint placeholder", { mutateSession: s => { delete s.getLeafEntry().details; } }],
		["missing kept boundary", { mutateSession: s => { s.getLeafEntry().firstKeptEntryId = "missing-boundary"; } }],
		["notification throws", { config: { enabled: false }, throwNotice: true }],
	];
	for (const [name, options] of failures) test(`${name}: cancel rather than send the placeholder without its blob`, async () => {
		const h = harness(options);
		await run(h);
		expect(h.sent).toHaveLength(0);
		expect(h.aborts).toBe(1);
		expect(h.agent.state.messages.at(-1).stopReason).toBe("aborted");
		expect(h.notices.join(" ")).toContain("Restore the checkpoint's provider/model");
		expect(h.errors.join(" ")).toContain("/tree");
	});

	for (const currentModel of [{ ...model, provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-5" }, { ...model, provider: "google", api: "google-generative-ai", id: "gemini-2.5-flash" }]) test(`unsupported ${currentModel.provider} without a native checkpoint is not blocked`, async () => {
		const h = harness({ checkpoint: false, currentModel });
		await run(h);
		expect(h.sent).toHaveLength(1);
		expect(h.aborts).toBe(0);
	});

	for (const config of [{}, { enabled: false }]) test(`real runner cancels further compaction instead of overwriting opaque history (${JSON.stringify(config)})`, async () => {
		const h = harness({ config });
		const result = await h.runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: h.firstKeptEntryId, tokensBefore: 500 }, signal: new AbortController().signal });
		expect(result).toEqual({ cancel: true });
		expect(h.fallbackCalls).toBe(0);
		expect(h.sent).toHaveLength(0);
		expect(h.notices.join(" ")).toContain("encrypted compaction history");
	});
});

describe("continuity-break cannot bypass an existing native dependency", () => {
	const invalidCheckpoints: [string, (entry: any) => void][] = [
		["missing details", entry => { delete entry.details; }],
		["damaged identity", entry => { delete entry.details.model; }],
		["null window", entry => { entry.details.compactedWindow = null; }],
		["empty window", entry => { entry.details.compactedWindow = []; }],
		["non-object window item", entry => { entry.details.compactedWindow = ["invalid"]; }],
		["model mismatch", entry => { entry.details.model = "different-model"; }],
		["endpoint mismatch", entry => { entry.details.baseUrl = "https://different.invalid"; }],
	];
	for (const compactionVersion of ["v1", "v2"]) {
		for (const [name, damage] of invalidCheckpoints) test(`${compactionVersion}: continuity=true with ${name} cancels before generation`, async () => {
			const h = harness({ nativeSuccess: true, config: { compactionVersion, allowCompactionContinuityBreak: true }, mutateSession: session => damage(session.getLeafEntry()) });
			const before = JSON.stringify(h.session.getBranch());
			const result = await h.runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: h.firstKeptEntryId, tokensBefore: 500 }, signal: new AbortController().signal });
			expect(result).toEqual({ cancel: true });
			expect(h.nativeCalls).toBe(0);
			expect(h.fallbackCalls).toBe(0);
			expect(JSON.stringify(h.session.getBranch())).toBe(before);
		});

		for (const genuineTextCompaction of [false, true]) test(`${compactionVersion}: continuity=true preserves ${genuineTextCompaction ? "genuine text-summary restart" : "valid native re-compaction"}`, async () => {
			const h = harness({ nativeSuccess: true, config: { compactionVersion, allowCompactionContinuityBreak: true }, mutateSession: session => {
				if (genuineTextCompaction) {
					session.getLeafEntry().summary = "Genuine plaintext summary with surviving context.";
					session.getLeafEntry().details = { readFiles: [], modifiedFiles: [] };
				}
			} });
			const result = await h.runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: h.firstKeptEntryId, tokensBefore: 500 }, signal: new AbortController().signal });
			expect(result?.compaction?.details.compactedWindow).toContainEqual({ type: "compaction", encrypted_content: "new-opaque-test-fixture" });
			expect(h.nativeCalls).toBe(1);
			expect(h.fallbackCalls).toBe(0);
			if (genuineTextCompaction) {
				expect(JSON.stringify(h.nativeInputs[0])).toContain("Genuine plaintext summary with surviving context.");
				expect(JSON.stringify(h.nativeInputs[0])).not.toContain("opaque-test-fixture");
			} else {
				expect(h.nativeInputs[0]).toContainEqual({ type: "compaction", encrypted_content: "opaque-test-fixture" });
				expect(JSON.stringify(h.nativeInputs[0])).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
			}
		});
	}
});

describe("native checkpoint creation preflight", () => {
	for (const tools of [[{ type: "custom", name: "grammar" }], [{ type: "function", name: "read", defer_loading: true }]]) test(`declines ${JSON.stringify(tools)} before creating an opaque checkpoint`, async () => {
		const h = harness({ checkpoint: false });
		rememberRequestContext({ model: model.id, input: [], tools }, h.session.getSessionId());
		const result = await h.runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: h.firstKeptEntryId, tokensBefore: 500 }, signal: new AbortController().signal });
		expect(result).toBeUndefined(); // Pi text fallback is safe only before a native checkpoint.
		expect(h.nativeCalls).toBe(0);
		expect(h.fallbackCalls).toBe(1);
		expect(JSON.stringify(h.session.buildSessionContext().messages)).toContain("FACT-ONLY-BEFORE-KEPT-BOUNDARY");
	});

	test("declines a missing kept boundary before native generation", async () => {
		const h = harness({ checkpoint: false });
		await h.runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: "missing", tokensBefore: 500 }, signal: new AbortController().signal });
		expect(h.nativeCalls).toBe(0);
		expect(h.fallbackCalls).toBe(1);
	});
});

describe("public Pi Responses serializer parity", () => {
	for (const provider of ["github-copilot", "openai", "openai-codex"]) test(`${provider}: unsigned blocks, cross-model signatures/tool IDs and orphan results`, () => {
		const target = { ...model, provider, api: provider === "openai-codex" ? "openai-codex-responses" : model.api };
		const same = assistant([{ type: "text", text: "one" }, { type: "text", text: "two" }], target);
		const messages: any[] = [{ role: "user", content: "Synthetic", timestamp: 1 }, same, mixed];
		const expected = convertResponsesMessages(target, { messages }, new Set(["openai", "openai-codex", "opencode"]));
		const actual = serializeMessagesToResponsesInput(target, messages);
		expect(actual).toEqual(expected);
		expect(actual.filter((i: any) => i.type === "message").slice(0, 2).map((i: any) => i.id)).toEqual(["msg_pi_1", "msg_pi_1_1"]);
		expect(JSON.stringify(actual)).not.toContain("foreign-state");
		expect(JSON.stringify(actual)).not.toContain("msg_foreign");
		expect(actual.at(-1)).toMatchObject({ type: "function_call_output", output: "No result provided" });
	});
});
