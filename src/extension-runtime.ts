import type {
	BeforeProviderRequestEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	ANTHROPIC_BLOCK_REJECTED_ENTRY,
	ANTHROPIC_MESSAGES_API,
	executeAnthropicCompaction,
	getAnthropicTools,
	isAnthropicMessagesPayload,
	rememberAnthropicTools,
	replaceSummaryWithBlock,
	resolveAnthropicReplay,
} from "./anthropic-compaction";
import { executeNativeCompaction } from "./compact-client";
import { executeV2Compaction } from "./compact-client-v2";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { findLatestCompactionEntry, resolveLatestNativeCompactionEntry } from "./details-store";
import { runNativeFallbackCompaction } from "./native-fallback";
import {
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { buildRetainedMessages } from "./retained-messages";
import {
	isResponsesCompatiblePayload,
	normalizeBaseUrl,
	resolveNativeCompactionEnvironment,
	type NativeCompactionRuntime,
} from "./runtime";
import { serializeMessagesToCompactRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer";
import {
	ANTHROPIC_COMPACTION_STRATEGY,
	createNativeCompactionDetails,
	createNativeCompactionResult,
	EXTENSION_ID,
	isNativeCompactionDetails,
	isNativeCompactionEntry,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	NATIVE_COMPACTION_STRATEGY,
	NATIVE_COMPACTION_STRATEGY_V2,
	type ExtensionConfig,
	type NativeCompactionDetails,
	type NativeCompactionIdentity,
	type NativeCompactionRequestMeta,
} from "./types";

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult<NativeCompactionDetails> }
	| { outcome: "aborted" }
	| { outcome: "failed" };

export type ExtensionRuntimeDependencies = {
	loadExtensionConfig: typeof loadExtensionConfig;
	executeNativeCompaction: typeof executeNativeCompaction;
	executeV2Compaction: typeof executeV2Compaction;
	runNativeFallbackCompaction: typeof runNativeFallbackCompaction;
	executeAnthropicCompaction: typeof executeAnthropicCompaction;
};

/** Per-registration state shared by the provider request and response hooks. */
type RuntimeState = {
	getThinkingLevel?: () => ThinkingLevel | undefined;
	appendEntry?: (customType: string, data?: unknown) => void;
	/** Compaction entry whose block the in-flight provider request carries. */
	pendingAnthropicReplay?: string;
	/** `${compactionEntryId}|${provider}/${model}` pairs already warned about on model_select. */
	warnedCheckpointSwitches?: Set<string>;
};

/**
 * Warning for a model that cannot read the latest compaction.
 *
 * An OpenAI native checkpoint is an opaque window that only replays for the
 * provider and model that produced it; Pi's own summary for it is only a
 * placeholder. Any other model would continue with the placeholder plus the
 * kept messages. Returns undefined when the latest compaction is readable.
 */
export function describeUnreadableCheckpoint(
	branchEntries: readonly SessionEntry[],
	model: { provider: string; id: string } | undefined,
): { key: string; message: string } | undefined {
	const latest = findLatestCompactionEntry(branchEntries);
	if (!model || !isNativeCompactionEntry(latest) || latest.summary !== NATIVE_COMPACTION_FALLBACK_SUMMARY) {
		return undefined;
	}
	const { provider, model: checkpointModel } = latest.details;
	if (provider === model.provider && checkpointModel === model.id) {
		return undefined;
	}
	return {
		key: `${latest.id}|${model.provider}/${model.id}`,
		message:
			`the latest compaction is an OpenAI native checkpoint that only ${provider}/${checkpointModel} can read. ` +
			`${model.provider}/${model.id} will see only the messages kept after it. ` +
			"To continue with the full history, use /tree to branch from the entry before that compaction.",
	};
}

const DEFAULT_DEPENDENCIES: ExtensionRuntimeDependencies = {
	loadExtensionConfig,
	executeNativeCompaction,
	executeV2Compaction,
	runNativeFallbackCompaction,
	executeAnthropicCompaction,
};

function buildCompactionRequestMeta(event: SessionBeforeCompactEvent): NativeCompactionRequestMeta {
	return {
		tokensBefore: event.preparation.tokensBefore,
		previousSummaryPresent: Boolean(event.preparation.previousSummary),
	};
}

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
		}
		: undefined;
}

function getCompactionIdentityDebugInfo(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? {
			provider: entry.details.provider,
			api: entry.details.api,
			model: entry.details.model,
			baseUrl: entry.details.baseUrl,
		}
		: undefined;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, "warning");
	}
}

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\nAdditional compaction guidance:\n${guidance}`;
}

async function runResponsesV1Compact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: NativeCompactionRuntime,
	dependencies: ExtensionRuntimeDependencies,
): Promise<ResponsesCompactOutcome> {
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: runtime.currentModel.id,
			input,
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: ctx.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-compact-skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// Mirror the latest codex_rs CompactionInput fields captured from the most
	// recent live provider request for this model (tools, reasoning, etc.).
	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras) {
		request = { ...request, ...extras };
	}

	const compactResult = await dependencies.executeNativeCompaction({
		runtime,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (compactResult.ok === false) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-compact-failure",
				reason: compactResult.reason,
				status: compactResult.status,
				errorMessage: compactResult.errorMessage,
			},
			config,
			ctx,
		);
		return compactResult.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: compactResult.compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: buildCompactionRequestMeta(event),
		});
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
		summary: compactResult.summaryText,
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.v1-compact-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: compactResult.compactResponseId,
			compactedItems: compactResult.compactedWindow.length,
			summaryExtracted: Boolean(compactResult.summaryText),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

/**
 * V2 compaction: stream a Responses request with compaction_trigger appended.
 * On success, returns retained messages + encrypted compaction blob.
 */
async function runResponsesV2Compact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: NativeCompactionRuntime,
	dependencies: ExtensionRuntimeDependencies,
): Promise<ResponsesCompactOutcome> {
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: runtime.currentModel.id,
			input,
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: ctx.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-compact-skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras) {
		request = { ...request, ...extras };
	}

	const v2Result = await dependencies.executeV2Compaction({
		runtime,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (!v2Result.ok) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-compact-failure",
				reason: v2Result.reason,
				status: v2Result.status,
				errorMessage: v2Result.errorMessage,
			},
			config,
			ctx,
		);
		return v2Result.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	// Build compacted window: retained messages + compaction blob.
	const retainedMessages = buildRetainedMessages(request.input);
	const compactedWindow = [...retainedMessages, v2Result.compactionItem];

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails(
			{
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactedWindow,
				compactResponseId: v2Result.responseId,
				createdAt: v2Result.createdAt,
				requestMeta: buildCompactionRequestMeta(event),
			},
			NATIVE_COMPACTION_STRATEGY_V2,
		);
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// V2 blob is encrypted; no summary text can be extracted.
	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.v2-compact-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: v2Result.responseId,
			retainedMessageCount: retainedMessages.length,
			compactedItems: compactedWindow.length,
			usage: v2Result.usage,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

function getAnthropicIdentity(ctx: ExtensionContext): NativeCompactionIdentity | undefined {
	const model = ctx.model;
	const baseUrl = normalizeBaseUrl(model?.baseUrl);
	if (!model || model.api !== ANTHROPIC_MESSAGES_API || !baseUrl) {
		return undefined;
	}
	return { provider: model.provider, api: model.api, model: model.id, baseUrl };
}

/**
 * Anthropic on-demand compaction: summarize what Pi would discard, server-side,
 * and keep the signed block for replay. Pi's kept messages stay verbatim.
 */
async function runAnthropicCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	dependencies: ExtensionRuntimeDependencies,
	state: RuntimeState,
): Promise<ResponsesCompactOutcome> {
	const identity = getAnthropicIdentity(ctx);
	if (!identity || !ctx.model) {
		return { outcome: "failed" };
	}

	let auth: { ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string };
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	} catch (error) {
		auth = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!auth.ok) {
		writeDebugArtifact(
			"compaction-event",
			{ event: "session_before_compact.anthropic-auth-failed", errorMessage: auth.error, ...identity },
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const previous = findLatestCompactionEntry(branchEntries);
	const priorReplay = resolveAnthropicReplay(branchEntries, identity);
	const messages: AgentMessage[] = [
		...(previous
			? [{
				role: "compactionSummary",
				summary: previous.summary,
				tokensBefore: previous.tokensBefore,
				timestamp: new Date(previous.timestamp).getTime(),
			} as AgentMessage]
			: []),
		...event.preparation.messagesToSummarize,
		...event.preparation.turnPrefixMessages,
	];
	const headers = Object.fromEntries(
		Object.entries(auth.headers ?? {}).filter((header): header is [string, string] => header[1] !== null),
	);

	const result = await dependencies.executeAnthropicCompaction({
		model: ctx.model,
		apiKey: auth.apiKey,
		headers,
		systemPrompt: ctx.getSystemPrompt(),
		messages,
		priorReplay,
		tools: getAnthropicTools(identity.model, getSessionId(ctx)),
		instructions: event.customInstructions,
		reasoning: state.getThinkingLevel?.(),
		sessionId: getSessionId(ctx),
		signal: event.signal,
	});
	if (!result.ok) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.anthropic-compact-failure",
				reason: result.reason,
				status: result.status,
				errorMessage: result.errorMessage,
				...identity,
			},
			config,
			ctx,
		);
		if (result.reason !== "aborted") {
			notifyWarning(ctx, `Anthropic server compaction failed (${result.errorMessage ?? result.reason}); using fallback compaction`);
		}
		return result.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	const details = createNativeCompactionDetails(
		{
			...identity,
			compactedWindow: [result.block],
			compactResponseId: result.messageId,
			requestMeta: buildCompactionRequestMeta(event),
		},
		ANTHROPIC_COMPACTION_STRATEGY,
	);
	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.anthropic-compact-success",
			...identity,
			compactResponseId: result.messageId,
			priorBlockReplayed: Boolean(priorReplay),
			summarizedMessages: messages.length,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);
	return {
		outcome: "success",
		compaction: createNativeCompactionResult({
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details,
			// The block's plain-text summary doubles as Pi's summary after a model switch.
			summary: result.block.content,
		}),
	};
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
	state: RuntimeState = {},
) {
	const { config } = dependencies.loadExtensionConfig();
	if (!config.enabled) {
		return undefined;
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact",
			customInstructions: event.customInstructions,
			preparation: {
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
			},
		},
		config,
		ctx,
	);

	if (event.signal.aborted) {
		return { cancel: true };
	}

	// Branch 1a: Anthropic Messages uses on-demand server-side compaction.
	if (ctx.model?.api === ANTHROPIC_MESSAGES_API) {
		const anthropicOutcome = await runAnthropicCompact(event, ctx, config, dependencies, state);
		if (anthropicOutcome.outcome === "success") {
			return { compaction: anthropicOutcome.compaction };
		}
		if (anthropicOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: fall through; the Responses branch declines and the fallback runs.
	}

	// Branch 1b: Responses-family APIs use the native /responses/compact endpoint.
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesCompactApis: config.responsesCompactApis,
	});
	if (resolution.ok) {
		let responsesOutcome: ResponsesCompactOutcome;

		if (config.compactionVersion === "v2") {
			responsesOutcome = await runResponsesV2Compact(event, ctx, config, resolution.runtime, dependencies);
		} else {
			responsesOutcome = await runResponsesV1Compact(event, ctx, config, resolution.runtime, dependencies);
		}

		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: fall through to the configured-model fallback below.
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-compact-unavailable",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
			},
			config,
			ctx,
		);
	}

	// Branch 2: run pi's native compaction method with the configured model.
	const fallback = await dependencies.runNativeFallbackCompaction({
		ctx,
		event,
		config,
		sessionId: getSessionId(ctx),
	});
	if (fallback.ok) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${EXTENSION_ID}: compacted with ${fallback.model.provider}/${fallback.model.id} (native method)`,
				"info",
			);
		}
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.fallback-success",
				model: fallback.model,
				usage: fallback.usage,
			},
			config,
			ctx,
		);
		return { compaction: fallback.result };
	}

	if (fallback.reason === "aborted") {
		return { cancel: true };
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.fallback-skip",
			reason: fallback.reason,
			modelSpec: fallback.modelSpec,
			errorMessage: fallback.errorMessage,
		},
		config,
		ctx,
	);

	// Intentional pi-default paths: no configured model, or it matches the current one.
	if (fallback.reason !== "no-model-configured" && fallback.reason !== "same-as-current-model") {
		notifyWarning(
			ctx,
			`compaction model "${fallback.modelSpec}" unusable (${fallback.reason}${fallback.errorMessage ? `: ${fallback.errorMessage}` : ""}); using pi's default compaction`,
		);
	}

	// Branch 3: pi's default native compaction with the current model.
	return undefined;
}

function rewriteAnthropicRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	state: RuntimeState,
) {
	const payload = event.payload;
	if (!isAnthropicMessagesPayload(payload)) {
		return undefined;
	}
	rememberAnthropicTools(payload, getSessionId(ctx));

	const identity = getAnthropicIdentity(ctx);
	const branchEntries = ctx.sessionManager.getBranch();
	const replay = identity && payload.model === identity.model
		? resolveAnthropicReplay(branchEntries, identity)
		: undefined;
	if (!replay) {
		return undefined;
	}

	const rewritten = replaceSummaryWithBlock(payload, replay.entry.summary, replay.block);
	writeDebugArtifact(
		"provider-request",
		{
			event: rewritten ? "before_provider_request.anthropic-replay" : "before_provider_request.anthropic-replay-skip",
			...identity,
			compactionEntryId: replay.entry.id,
			payload: rewritten ?? payload,
		},
		config,
		ctx,
	);
	if (rewritten) {
		state.pendingAnthropicReplay = replay.entry.id;
	}
	return rewritten;
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
	state: RuntimeState = {},
) {
	const { config } = dependencies.loadExtensionConfig();
	if (!config.enabled) {
		return undefined;
	}

	state.pendingAnthropicReplay = undefined;
	if (ctx.model?.api === ANTHROPIC_MESSAGES_API) {
		return rewriteAnthropicRequest(event, ctx, config, state);
	}

	// Capture compact-relevant request fields (tools, reasoning, ...) for the next
	// /responses/compact call, regardless of whether this request gets rewritten.
	if (isResponsesCompatiblePayload(event.payload)) {
		rememberRequestContext(event.payload, getSessionId(ctx));
	}

	const resolution = await resolveNativeCompactionEnvironment(
		ctx,
		{
			enabled: config.enabled,
			responsesCompactApis: config.responsesCompactApis,
		},
		event.payload,
	);
	if (resolution.ok === false) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				currentModel: getCurrentModelDebugInfo(ctx),
				payload: event.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const latestNativeCompactionEntry = latestNativeCompaction.entry;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload: runtime.payload,
		branchEntries,
		compactionEntry: latestNativeCompactionEntry,
	});
	if (!rewrite.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.rewrite-failed",
				reason: rewrite.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				parity: rewrite.parity,
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	writeDebugArtifact(
		"provider-request",
		{
			event: "before_provider_request.native-rewrite",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactionEntryId: latestNativeCompactionEntry.id,
			boundaryIndex: rewrite.segments.boundaryIndex,
			firstKeptEntryIndex: rewrite.segments.firstKeptEntryIndex,
			originalInputItems: runtime.payload.input.length,
			rewrittenInputItems: rewrite.rewrittenPayload.input.length,
			freshPreambleItems: rewrite.segments.freshPreamble.length,
			trailingPreambleItems: rewrite.segments.trailingPreamble.length,
			compactionSummaryItems: rewrite.segments.compactionSummary.length,
			preCompactionKeptItems: rewrite.segments.preCompactionKeptWindow.input.length,
			compactedItems: rewrite.segments.compactedWindow.length,
			postCompactionTailItems: rewrite.segments.postCompactionTail.input.length,
			payload: rewrite.rewrittenPayload,
			originalPayload: runtime.payload,
		},
		config,
		ctx,
	);

	return rewrite.rewrittenPayload;
}

export function registerExtensionRuntime(
	pi: ExtensionAPI,
	dependencies: ExtensionRuntimeDependencies = DEFAULT_DEPENDENCIES,
): void {
	const state: RuntimeState = {
		getThinkingLevel: () => pi.getThinkingLevel?.(),
		appendEntry: (customType, data) => pi.appendEntry?.(customType, data),
	};

	pi.on("session_start", (_event, ctx) => {
		const { config, source, warnings } = dependencies.loadExtensionConfig();
		if (!config.enabled) return;

		if (warnings.length > 0 && ctx.hasUI && config.debug) {
			ctx.ui.notify(`${EXTENSION_ID}: ${warnings[0]}`, "warning");
		}

		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				config,
				configSource: source,
				warnings,
			},
			config,
			ctx,
		);

		if (ctx.hasUI && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", (event, ctx) =>
		handleSessionBeforeCompact(event, ctx, dependencies, state),
	);
	pi.on("before_provider_request", (event, ctx) =>
		handleBeforeProviderRequest(event, ctx, dependencies, state),
	);
	pi.on("after_provider_response", (event, ctx) => {
		const compactionEntryId = state.pendingAnthropicReplay;
		state.pendingAnthropicReplay = undefined;
		// ponytail: any 400 on a request that carried the block retires the block; the
		// next request replays Pi's summary instead. A 400 unrelated to the block costs
		// server-side continuity, never correctness.
		if (!compactionEntryId || event.status !== 400) return;
		state.appendEntry?.(ANTHROPIC_BLOCK_REJECTED_ENTRY, { compactionEntryId });
		notifyWarning(ctx, "provider rejected the Anthropic compaction block; replaying Pi's summary from now on");
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI || !dependencies.loadExtensionConfig().config.enabled) return;
		const warning = describeUnreadableCheckpoint(ctx.sessionManager.getBranch(), event.model);
		if (!warning) return;
		state.warnedCheckpointSwitches ??= new Set();
		if (state.warnedCheckpointSwitches.has(warning.key)) return;
		state.warnedCheckpointSwitches.add(warning.key);
		notifyWarning(ctx, warning.message);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		const { config } = dependencies.loadExtensionConfig();
		if (!config.enabled) return;

		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_compact_failed",
				reason: event.reason,
				errorMessage: event.errorMessage,
				aborted: event.aborted,
				willRetry: event.willRetry,
				fromExtension: event.fromExtension,
			},
			config,
			ctx,
		);
	});
}

export default registerExtensionRuntime;
