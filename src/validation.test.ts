import { afterEach, expect, test } from "bun:test";
import { registerExtensionRuntime } from "./extension-runtime";
import { clearRequestContextCache } from "./request-context-cache";
import {
	createResponsesInputParitySignature,
	serializeMessagesToResponsesInput,
} from "./serializer";
import {
	DEFAULT_EXTENSION_CONFIG,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	createNativeCompactionDetails,
	type ExtensionConfig,
} from "./types";

type AssistantPhase = "commentary" | "final_answer";

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

type TextBlock = {
	type: "text";
	text: string;
	textSignature?: string;
};

type TestModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
	input: string[];
	reasoning: boolean;
};

type TestSessionEntry = {
	type: "message" | "compaction";
	id: string;
	timestamp: string;
	message?: Record<string, unknown>;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	details?: ReturnType<typeof createNativeCompactionDetails>;
};

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

type HookHarnessOptions = {
	compactResult?: Record<string, unknown>;
	v2CompactResult?: Record<string, unknown>;
	config?: Partial<ExtensionConfig>;
	nativeFallbackResult?: Record<string, unknown>;
};

const defaultModel: TestModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	reasoning: true,
};

let timestampCounter = 0;

async function serializeResponsesInput(model: TestModel, messages: Record<string, unknown>[]): Promise<unknown[]> {
	return serializeMessagesToResponsesInput(model as never, messages as never);
}

async function createInputParitySignature(input: readonly unknown[]): Promise<string[]> {
	return createResponsesInputParitySignature(input);
}

function nextTimestamp(): string {
	const timestamp = new Date(Date.UTC(2026, 2, 20, 12, 0, timestampCounter)).toISOString();
	timestampCounter += 1;
	return timestamp;
}

function createTextBlock(text: string, phase?: AssistantPhase, id = `msg_${timestampCounter}`): TextBlock {
	return {
		type: "text",
		text,
		...(phase
			? {
				textSignature: JSON.stringify({
					v: 1,
					id,
					phase,
				}),
			}
			: {}),
	};
}

function createToolCallBlock(
	callId: string,
	name: string,
	argumentsObject: Record<string, unknown>,
	itemId = `fc_${callId}`,
): ToolCallBlock {
	return {
		type: "toolCall",
		id: `${callId}|${itemId}`,
		name,
		arguments: argumentsObject,
	};
}

function createUserEntry(id: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createAssistantEntry(
	id: string,
	blocks: Array<TextBlock | ToolCallBlock>,
	model: TestModel = defaultModel,
	stopReason: string = "stop",
): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			stopReason,
			content: blocks,
			timestamp: Date.now(),
		},
	};
}

function createToolResultEntry(id: string, toolCallId: string, toolName: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError: false,
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createCompactionEntry(args: {
	id: string;
	firstKeptEntryId: string;
	tokensBefore?: number;
	model?: TestModel;
	compactedWindow: unknown[];
	compactResponseId?: string;
}): TestSessionEntry {
	const model = args.model ?? defaultModel;
	return {
		type: "compaction",
		id: args.id,
		timestamp: nextTimestamp(),
		summary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
		firstKeptEntryId: args.firstKeptEntryId,
		tokensBefore: args.tokensBefore ?? 256,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow: args.compactedWindow,
			compactResponseId: args.compactResponseId,
			createdAt: nextTimestamp(),
		}),
	};
}

function createCompactionSummaryMessage(entry: TestSessionEntry): Record<string, unknown> {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function toReplayMessage(entry: TestSessionEntry): Record<string, unknown> {
	if (entry.type !== "message" || !entry.message) {
		throw new Error(`Expected message entry, got ${entry.type}`);
	}
	return entry.message;
}

async function buildPiReplayPayload(args: {
	model?: TestModel;
	branchEntries: TestSessionEntry[];
	compactionEntry: TestSessionEntry;
	instructions: string;
	freshPreamble: string;
	trailingPreamble?: string[];
}): Promise<{
	model: string;
	instructions: string;
	input: unknown[];
}> {
	const model = args.model ?? defaultModel;
	const boundaryIndex = args.branchEntries.findIndex((entry) => entry.id === args.compactionEntry.id);
	if (boundaryIndex < 0) {
		throw new Error(`Missing compaction entry ${args.compactionEntry.id}`);
	}

	const firstKeptEntryIndex = args.branchEntries.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === args.compactionEntry.firstKeptEntryId,
	);
	if (firstKeptEntryIndex < 0) {
		throw new Error(`Missing first-kept entry ${args.compactionEntry.firstKeptEntryId}`);
	}

	const preCompactionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const piReplayMessages = [
		createCompactionSummaryMessage(args.compactionEntry),
		...preCompactionEntries.map(toReplayMessage),
		...postCompactionEntries.map(toReplayMessage),
	];

	return {
		model: model.id,
		instructions: args.instructions,
		input: [
			{
				role: model.reasoning ? "developer" : "system",
				content: args.freshPreamble,
			},
			...(await serializeResponsesInput(model, piReplayMessages)),
			...((args.trailingPreamble ?? []).map((text) => ({
				role: "developer",
				content: [{ type: "input_text", text }],
			}))),
		],
	};
}

function createContext(args: {
	branchEntries?: TestSessionEntry[];
	model?: TestModel;
	systemPrompt?: string;
	sessionContextMessages?: Record<string, unknown>[];
	registryModels?: Array<{ provider: string; id: string }>;
} = {}) {
	const branchEntries = args.branchEntries ?? [];
	const model = args.model ?? defaultModel;
	const sessionContextMessages =
		args.sessionContextMessages ?? branchEntries.filter((entry) => entry.type === "message").map(toReplayMessage);
	return {
		cwd: "/tmp/pi-better-compaction-validation",
		hasUI: false,
		getSystemPrompt: () => args.systemPrompt ?? "Current instructions v1",
		model,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				(args.registryModels ?? []).find((entry) => entry.provider === provider && entry.id === modelId),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-native-compaction" }),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			buildSessionContext: () => ({
				messages: sessionContextMessages,
				thinkingLevel: "off",
				model: null,
			}),
			getSessionId: () => "session-validation",
			getSessionFile: () => "/tmp/pi-better-compaction-validation/session.json",
			getSessionDir: () => "/tmp/pi-better-compaction-validation",
		},
	};
}

async function loadHookHarness(options: HookHarnessOptions = {}): Promise<{
	sessionBeforeCompact: HookHandler;
	beforeProviderRequest: HookHandler;
	compactCalls: Array<Record<string, unknown>>;
	v2CompactCalls: Array<Record<string, unknown>>;
	fallbackCalls: Array<Record<string, unknown>>;
}> {
	const compactCalls: Array<Record<string, unknown>> = [];
	const v2CompactCalls: Array<Record<string, unknown>> = [];
	const fallbackCalls: Array<Record<string, unknown>> = [];

	const handlers = new Map<string, HookHandler>();
	registerExtensionRuntime(
		{
			on: (eventName: string, handler: HookHandler) => {
				handlers.set(eventName, handler);
			},
		} as never,
		{
			loadExtensionConfig: () => ({
				config: {
					...DEFAULT_EXTENSION_CONFIG,
					responsesCompactApis: [...DEFAULT_EXTENSION_CONFIG.responsesCompactApis],
					...(options.config ?? {}),
				},
				source: undefined,
				warnings: [],
			}),
			runNativeFallbackCompaction: async (args: Record<string, unknown>) => {
				fallbackCalls.push(args);
				return (options.nativeFallbackResult ?? { ok: false, reason: "no-model-configured" }) as never;
			},
			executeNativeCompaction: async (args: Record<string, unknown>) => {
				compactCalls.push(args);
				return (
					options.compactResult ?? {
						ok: true,
						status: 200,
						compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_default", content: [] }],
						compactResponseId: "resp_default",
						createdAt: nextTimestamp(),
						response: {
							id: "resp_default",
							created_at: nextTimestamp(),
							output: [{ type: "message", role: "assistant", status: "completed", id: "cmp_default", content: [] }],
						},
					}
				) as never;
			},
			executeV2Compaction: async (args: Record<string, unknown>) => {
				v2CompactCalls.push(args);
				return (
					options.v2CompactResult ?? {
						ok: false,
						reason: "no-compaction-output",
					}
				) as never;
			},
		},
	);

	const sessionBeforeCompact = handlers.get("session_before_compact");
	const beforeProviderRequest = handlers.get("before_provider_request");
	if (!sessionBeforeCompact || !beforeProviderRequest) {
		throw new Error("Expected pi-better-compaction hooks to register");
	}

	return {
		sessionBeforeCompact,
		beforeProviderRequest,
		compactCalls,
		v2CompactCalls,
		fallbackCalls,
	};
}

afterEach(() => {
	timestampCounter = 0;
	clearRequestContextCache();
});

test("manual /compact preserves tool/result ordering + assistant phases and persists the native window", async () => {
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_1", phase: "commentary", content: [] },
	];
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		config: { compactionVersion: "v1" },
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow,
			compactResponseId: "resp_manual",
			createdAt: nextTimestamp(),
			response: {
				id: "resp_manual",
				created_at: nextTimestamp(),
				output: compactedWindow,
			},
		},
	});
	const model = { ...defaultModel };
	const toolCall = createToolCallBlock("call_docs", "search_docs", { query: "weekly release status" }, "fc_docs");
	const user = createUserEntry("entry_user", "Check the weekly release status.");
	const assistantCommentary = createAssistantEntry(
		"entry_assistant_commentary",
		[createTextBlock("Checking the docs first.", "commentary", "msg_commentary"), toolCall],
		model,
		"toolUse",
	);
	const toolResult = createToolResultEntry("entry_tool_result", toolCall.id, toolCall.name, "Release notes say green.");
	const assistantFinal = createAssistantEntry(
		"entry_assistant_final",
		[createTextBlock("The release is green.", "final_answer", "msg_final")],
		model,
		"stop",
	);
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [
				toReplayMessage(user),
				toReplayMessage(assistantCommentary),
				toReplayMessage(toolResult),
				toReplayMessage(assistantFinal),
			],
			turnPrefixMessages: [],
		},
	};
	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: event.preparation.messagesToSummarize as Record<string, unknown>[],
		}),
	)) as {
		compaction: Record<string, unknown>;
	};

	expect(compactCalls).toHaveLength(1);
	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions v1");
	expect(await createInputParitySignature(compactRequest.input)).toEqual([
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:search_docs",
		"function_call_output",
		"message:assistant:final_answer",
	]);
	expect(result.compaction.summary).toBe(NATIVE_COMPACTION_FALLBACK_SUMMARY);
	expect(result.compaction.firstKeptEntryId).toBe(user.id);
	expect(result.compaction.tokensBefore).toBe(512);
	expect((result.compaction.details as { compactedWindow: unknown[] }).compactedWindow).toEqual(compactedWindow);
});

test("first native compaction sends the full current session context, including Pi's kept recent window", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		config: { compactionVersion: "v1" },
	});
	const model = { ...defaultModel };
	const summarizedUser = createUserEntry("summarized_user", "Older context slated for summarization.");
	const keptUser = createUserEntry("kept_recent_user", "Recent kept window context that must also be compacted.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 384,
			firstKeptEntryId: keptUser.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(summarizedUser)],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions include the kept window too",
			sessionContextMessages: [toReplayMessage(summarizedUser), toReplayMessage(keptUser)],
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions include the kept window too");
	expect(await createInputParitySignature(compactRequest.input)).toEqual(["input:user[1]", "input:user[1]"]);
	expect(JSON.stringify(compactRequest.input)).toContain("Recent kept window context that must also be compacted.");
});

test("repeated native compaction reuses the latest stored compacted window instead of Pi's shim summary", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		config: { compactionVersion: "v1" },
	});
	const model = { ...defaultModel };
	const oldKeptUser = createUserEntry("old_kept_user", "Original context before native compaction.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_repeat",
			phase: "commentary",
			content: [{ type: "output_text", text: "Opaque compacted window", annotations: [] }],
		},
	];
	const priorCompaction = createCompactionEntry({
		id: "compaction_repeat",
		firstKeptEntryId: oldKeptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_repeat",
	});
	const tailUser = createUserEntry("repeat_tail_user", "New follow-up after the earlier native compaction.");
	const tailAssistant = createAssistantEntry(
		"repeat_tail_assistant",
		[createTextBlock("Follow-up answer after the earlier native compaction.", "final_answer", "msg_repeat_tail")],
		model,
		"stop",
	);
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 640,
			firstKeptEntryId: tailUser.id,
			previousSummary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [oldKeptUser, priorCompaction, tailUser, tailAssistant],
			model,
			systemPrompt: "Current instructions v-repeat",
			sessionContextMessages: [
				createCompactionSummaryMessage(priorCompaction),
				toReplayMessage(oldKeptUser),
				toReplayMessage(tailUser),
				toReplayMessage(tailAssistant),
			],
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(tailUser), toReplayMessage(tailAssistant)]);
	expect(compactRequest.instructions).toBe("Current instructions v-repeat");
	expect(compactRequest.input).toEqual([...compactedWindow, ...expectedTail]);
	expect(JSON.stringify(compactRequest.input)).toContain("Opaque compacted window");
	expect(JSON.stringify(compactRequest.input)).not.toContain("The conversation history before this point was compacted");
	expect(JSON.stringify(compactRequest.input)).not.toContain("Original context before native compaction.");
});

test("session_before_compact falls through to the configured-model fallback when the latest compaction is not native", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const olderUser = createUserEntry("older_non_native_user", "Context from before a non-native compaction.");
	const nonNativeCompaction: TestSessionEntry = {
		type: "compaction",
		id: "non_native_compaction",
		timestamp: nextTimestamp(),
		summary: "Legacy Pi summary",
		firstKeptEntryId: olderUser.id,
		tokensBefore: 512,
	};
	const currentUser = createUserEntry("current_after_non_native", "Current context after a non-native compaction.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 768,
			firstKeptEntryId: currentUser.id,
			previousSummary: "Legacy Pi summary",
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [olderUser, nonNativeCompaction, currentUser],
			model,
			systemPrompt: "Current instructions after a non-native compaction",
			sessionContextMessages: [
				createCompactionSummaryMessage(nonNativeCompaction),
				toReplayMessage(olderUser),
				toReplayMessage(currentUser),
			],
		}),
	);

	expect(result).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
	// Responses compact declined (non-native latest entry) → configured-model fallback is consulted.
	expect(fallbackCalls).toHaveLength(1);
});

test("continuity-break opt-in restarts native compaction from Pi's current session context", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		config: { compactionVersion: "v1", allowCompactionContinuityBreak: true },
	});
	const model = { ...defaultModel };
	const olderUser = createUserEntry("older_recovery_user", "Context retained by Pi after its earlier compaction.");
	const nonNativeCompaction: TestSessionEntry = {
		type: "compaction",
		id: "non_native_recovery_compaction",
		timestamp: nextTimestamp(),
		summary: "Legacy Pi summary used as the recovery baseline",
		firstKeptEntryId: olderUser.id,
		tokensBefore: 512,
	};
	const currentUser = createUserEntry("current_recovery_user", "Continue from the compacted Pi session.");
	const sessionContextMessages = [
		createCompactionSummaryMessage(nonNativeCompaction),
		toReplayMessage(olderUser),
		toReplayMessage(currentUser),
	];
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 768,
			firstKeptEntryId: currentUser.id,
			previousSummary: nonNativeCompaction.summary,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [olderUser, nonNativeCompaction, currentUser],
			model,
			systemPrompt: "Current instructions for continuity recovery",
			sessionContextMessages,
		}),
	)) as { compaction: Record<string, unknown> };

	expect(compactCalls).toHaveLength(1);
	expect(fallbackCalls).toHaveLength(0);
	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions for continuity recovery");
	expect(compactRequest.input).toEqual(await serializeResponsesInput(model, sessionContextMessages));
	expect(JSON.stringify(compactRequest.input)).toContain("Legacy Pi summary used as the recovery baseline");
	expect(result.compaction.firstKeptEntryId).toBe(currentUser.id);
});

test("first post-compaction turn rewrites to fresh preamble + opaque compacted window + live tail without duplication", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user", "Old user context that Pi should stop duplicating.");
	const keptAssistant = createAssistantEntry(
		"kept_assistant",
		[createTextBlock("Old assistant context that should disappear after native replay.", "commentary", "msg_kept")],
		model,
	);
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_commentary", phase: "commentary", content: [] },
		{
			type: "function_call",
			id: "fc_weather",
			call_id: "call_weather",
			name: "weather_lookup",
			arguments: '{"city":"Berlin"}',
		},
		{
			type: "function_call_output",
			call_id: "call_weather",
			output: "18°C and sunny",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_1",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_first_turn",
	});
	const currentUser = createUserEntry("post_compaction_user", "Now summarize only the deploy risk.");
	const branchEntries = [keptUser, keptAssistant, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v2",
		freshPreamble: "Fresh preamble v2",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const expectedInput = [payload.input[0], ...compactedWindow, ...expectedTail];

	expect(rewritten.instructions).toBe("Current instructions v2");
	expect(rewritten.input).toEqual(expectedInput);
	expect(JSON.stringify(rewritten.input)).not.toContain("Old user context that Pi should stop duplicating.");
	expect(JSON.stringify(rewritten.input)).not.toContain(
		"Old assistant context that should disappear after native replay.",
	);
	expect(JSON.stringify(rewritten.input)).not.toContain("The conversation history before this point was compacted");
});

test("trailing provider-authored developer prompts survive native replay in place", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel, reasoning: true };
	const keptUser = createUserEntry("kept_for_trailing_prompt", "Older replay context that should disappear.");
	const compactedWindow = [
		{
			type: "compaction",
			encrypted_content: "opaque-compact-window",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_with_trailing_prompt",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("trailing_prompt_user", "Continue with the trailing developer hint preserved.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions with trailing provider hint",
		freshPreamble: "Fresh preamble before replay",
		trailingPreamble: ["# Juice: 0 !important"],
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const trailingPrompt = payload.input[payload.input.length - 1];

	expect(rewritten.instructions).toBe("Current instructions with trailing provider hint");
	expect(rewritten.input).toEqual([payload.input[0], ...compactedWindow, ...expectedTail, trailingPrompt]);
	expect(rewritten.input[rewritten.input.length - 1]).toEqual(trailingPrompt);
});

test("multi-turn follow-up survives restart/resume while preserving tool/result pairing and assistant phases", async () => {
	const model = { ...defaultModel };
	const keptUser = createUserEntry("resume_kept_user", "Remember the earlier migration context.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_resume",
			phase: "commentary",
			content: [{ type: "output_text", text: "Compacted reasoning survives here.", annotations: [] }],
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "resume_compaction",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_resume",
	});
	const reviewCall = createToolCallBlock("call_review", "review_branch", { branch: "feature/native-compaction" }, "fc_review");
	const tailUser = createUserEntry("resume_tail_user", "Review the branch and call out risks.");
	const tailAssistantCommentary = createAssistantEntry(
		"resume_tail_assistant_commentary",
		[createTextBlock("Reviewing the branch now.", "commentary", "msg_tail_commentary"), reviewCall],
		model,
		"toolUse",
	);
	const tailToolResult = createToolResultEntry(
		"resume_tail_tool_result",
		reviewCall.id,
		reviewCall.name,
		"Found one medium-severity risk.",
	);
	const tailAssistantFinal = createAssistantEntry(
		"resume_tail_assistant_final",
		[createTextBlock("The main risk is stale replay state.", "final_answer", "msg_tail_final")],
		model,
	);
	const currentUser = createUserEntry("resume_current_user", "Which regression should I test first?");
	const branchEntries = [
		keptUser,
		compactionEntry,
		tailUser,
		tailAssistantCommentary,
		tailToolResult,
		tailAssistantFinal,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions after restart",
		freshPreamble: "Fresh preamble after restart",
	});
	const firstHarness = await loadHookHarness();
	const resumedHarness = await loadHookHarness();
	const firstRewrite = (await firstHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const resumedRewrite = (await resumedHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const parity = await createInputParitySignature(firstRewrite.input);

	expect(resumedRewrite).toEqual(firstRewrite);
	expect(firstRewrite.instructions).toBe("Current instructions after restart");
	expect(parity).toEqual([
		"input:developer",
		"message:assistant:commentary",
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:review_branch",
		"function_call_output",
		"message:assistant:final_answer",
		"input:user[1]",
	]);
});

test("a second compaction replays only the latest compacted window and keeps fresh instructions authoritative", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const initialKeptUser = createUserEntry("initial_kept_user", "Initial context before the first compaction.");
	const firstCompaction = createCompactionEntry({
		id: "compaction_first",
		firstKeptEntryId: initialKeptUser.id,
		model,
		compactedWindow: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "cmp_first",
				phase: "commentary",
				content: [{ type: "output_text", text: "First compaction window", annotations: [] }],
			},
		],
	});
	const interimUser = createUserEntry("interim_user", "Interim question between compactions.");
	const interimAssistant = createAssistantEntry(
		"interim_assistant",
		[createTextBlock("Interim answer between compactions.", "final_answer", "msg_interim")],
		model,
	);
	const secondCompactionWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_second",
			phase: "commentary",
			content: [{ type: "output_text", text: "Second compaction window", annotations: [] }],
		},
	];
	const secondCompaction = createCompactionEntry({
		id: "compaction_second",
		firstKeptEntryId: interimUser.id,
		model,
		compactedWindow: secondCompactionWindow,
	});
	const currentUser = createUserEntry("post_second_compaction_user", "What changed after the second compaction?");
	const branchEntries = [
		initialKeptUser,
		firstCompaction,
		interimUser,
		interimAssistant,
		secondCompaction,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry: secondCompaction,
		instructions: "Newest instructions win",
		freshPreamble: "Newest preamble wins too",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };

	expect(rewritten.instructions).toBe("Newest instructions win");
	expect(rewritten.input).toEqual([
		payload.input[0],
		...secondCompactionWindow,
		...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
	]);
	expect(JSON.stringify(rewritten.input)).toContain("Second compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("First compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("Interim question between compactions.");
});

test("unsupported model/provider switching fails open instead of replaying stale native state", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const matchingModel = { ...defaultModel };
	const switchedModel = {
		...defaultModel,
		id: "gpt-5-nano",
	};
	const unsupportedProviderModel = {
		...defaultModel,
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-sonnet-4",
	};
	const keptUser = createUserEntry("switch_kept_user", "Original context before switching models.");
	const olderMatchingCompaction = createCompactionEntry({
		id: "switch_compaction_old",
		firstKeptEntryId: keptUser.id,
		model: matchingModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_old", content: [] }],
	});
	const newerMismatchedCompaction = createCompactionEntry({
		id: "switch_compaction_new",
		firstKeptEntryId: keptUser.id,
		model: switchedModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_new", content: [] }],
	});
	const branchEntries = [keptUser, olderMatchingCompaction, newerMismatchedCompaction];
	const matchingPayload = {
		model: matchingModel.id,
		instructions: "Instructions after switching back",
		input: [{ role: "developer", content: "Fresh preamble after switching back" }],
	};
	const mismatchedLatestResult = await beforeProviderRequest(
		{ payload: matchingPayload },
		createContext({ branchEntries, model: matchingModel, systemPrompt: matchingPayload.instructions }),
	);
	const unsupportedProviderResult = await beforeProviderRequest(
		{ payload: { ...matchingPayload, model: unsupportedProviderModel.id } },
		createContext({ branchEntries, model: unsupportedProviderModel, systemPrompt: matchingPayload.instructions }),
	);

	expect(mismatchedLatestResult).toBeUndefined();
	expect(unsupportedProviderResult).toBeUndefined();
});

test("responses compact failure falls back to the configured native model and returns its result", async () => {
	const fallbackResult = {
		summary: "## Goal\nFinish the compaction refactor.",
		firstKeptEntryId: "entry_user",
		tokensBefore: 512,
		details: { readFiles: ["src/extension-runtime.ts"], modifiedFiles: [] },
	};
	const { sessionBeforeCompact, v2CompactCalls, compactCalls, fallbackCalls } = await loadHookHarness({
		v2CompactResult: { ok: false, reason: "non-2xx", status: 404 },
		nativeFallbackResult: {
			ok: true,
			result: fallbackResult,
			model: { provider: "google", id: "gemini-2.5-flash" },
		},
		config: { compactionModel: "google/gemini-2.5-flash" },
	});
	const model = { ...defaultModel };
	const user = createUserEntry("entry_user", "Compact this conversation.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// V2 was attempted and failed; V1 was never tried; fallback took over.
	expect(v2CompactCalls).toHaveLength(1);
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(1);
	expect(result.compaction).toEqual(fallbackResult);
});

test("non-Responses model routes straight to the native-method fallback", async () => {
	const anthropicModel = {
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-fable-5",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		reasoning: true,
	};
	const fallbackResult = {
		summary: "## Goal\nAnthropic-side summary.",
		firstKeptEntryId: "entry_user",
		tokensBefore: 256,
		details: { readFiles: [], modifiedFiles: [] },
	};
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		nativeFallbackResult: {
			ok: true,
			result: fallbackResult,
			model: { provider: "google", id: "gemini-2.5-flash" },
		},
		config: { compactionModel: "google/gemini-2.5-flash" },
	});
	const user = createUserEntry("entry_user", "Compact this Anthropic conversation.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 256,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model: anthropicModel,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// The compact endpoint is never touched for a non-Responses API.
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(1);
	expect(result.compaction).toEqual(fallbackResult);
});

test("responses compact stores the extracted assistant summary text as the entry summary", async () => {
	const compactedWindow = [
		{ type: "compaction", encrypted_content: "opaque" },
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_summary",
			content: [{ type: "output_text", text: "Compaction covered the auth refactor.", annotations: [] }],
		},
	];
	const { sessionBeforeCompact } = await loadHookHarness({
		config: { compactionVersion: "v1" },
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow,
			compactResponseId: "resp_summary",
			createdAt: nextTimestamp(),
			summaryText: "Compaction covered the auth refactor.",
			response: { id: "resp_summary", output: compactedWindow },
		},
	});
	const model = { ...defaultModel };
	const user = createUserEntry("entry_user", "Compact with a real summary.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({ model, sessionContextMessages: [toReplayMessage(user)] }),
	)) as { compaction: Record<string, unknown> };

	expect(result.compaction.summary).toBe("Compaction covered the auth refactor.");
});

// ── V2 decision path tests ────────────────────────────────────────────

test("V2 compaction success returns compactedWindow with retained messages + blob", async () => {
	const { sessionBeforeCompact, v2CompactCalls, compactCalls } = await loadHookHarness({
		v2CompactResult: {
			ok: true,
			compactionItem: { type: "compaction", id: "cmp_v2", encrypted_content: "encrypted-blob" },
			responseId: "resp_v2_success",
			createdAt: nextTimestamp(),
			usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
		},
		// compactionVersion defaults to "v2" so V2 path is taken
	});
	const model = { ...defaultModel };
	const user = createUserEntry("v2_user", "Context for V2 compaction.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "V2 test instructions",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// V2 was attempted and succeeded — V1 was never called.
	expect(v2CompactCalls).toHaveLength(1);
	expect(compactCalls).toHaveLength(0);
	expect(result.compaction.summary).toBe(NATIVE_COMPACTION_FALLBACK_SUMMARY);
	expect(result.compaction.firstKeptEntryId).toBe(user.id);

	const details = result.compaction.details as {
		strategy: string;
		compactedWindow: unknown[];
	};
	expect(details.strategy).toBe("openai-native-compact-v2");
	// compactedWindow should contain retained messages + the compaction blob
	const lastItem = details.compactedWindow[details.compactedWindow.length - 1] as Record<string, unknown>;
	expect(lastItem.type).toBe("compaction");
	expect(lastItem.encrypted_content).toBe("encrypted-blob");
});

test("V2 failure falls through to configured-model fallback", async () => {
	const fallbackResult = {
		summary: "## Fallback summary after V2 failure.",
		firstKeptEntryId: "v2_fallback_user",
		tokensBefore: 512,
		details: { readFiles: [], modifiedFiles: [] },
	};
	const { sessionBeforeCompact, v2CompactCalls, compactCalls, fallbackCalls } = await loadHookHarness({
		v2CompactResult: {
			ok: false,
			reason: "no-compaction-output",
		},
		nativeFallbackResult: {
			ok: true,
			result: fallbackResult,
			model: { provider: "google", id: "gemini-2.5-flash" },
		},
		config: { compactionModel: "google/gemini-2.5-flash" },
	});
	const model = { ...defaultModel };
	const user = createUserEntry("v2_fallback_user", "Context for V2 fallback.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "V2 fallback test",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// V2 was attempted and failed — V1 was never tried — fallback took over.
	expect(v2CompactCalls).toHaveLength(1);
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(1);
	expect(result.compaction).toEqual(fallbackResult);
});

test("compactionVersion=v1 skips V2 entirely", async () => {
	const { sessionBeforeCompact, v2CompactCalls, compactCalls } = await loadHookHarness({
		config: { compactionVersion: "v1" },
	});
	const model = { ...defaultModel };
	const user = createUserEntry("v1_only_user", "Context for V1-only mode.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "V1 only test",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// V2 was never attempted; V1 ran directly.
	expect(v2CompactCalls).toHaveLength(0);
	expect(compactCalls).toHaveLength(1);
	const details = result.compaction.details as { strategy: string };
	expect(details.strategy).toBe("openai-native-compact-v1");
});

test("V2 abort cancels without fallback", async () => {
	const { sessionBeforeCompact, v2CompactCalls, compactCalls, fallbackCalls } = await loadHookHarness({
		v2CompactResult: {
			ok: false,
			reason: "aborted",
		},
	});
	const model = { ...defaultModel };
	const user = createUserEntry("v2_abort_user", "Context for V2 abort.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "V2 abort test",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	) as { cancel?: boolean };

	// V2 was attempted, returned aborted — should cancel, not fall through.
	expect(v2CompactCalls).toHaveLength(1);
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(0);
	expect(result.cancel).toBe(true);
});
