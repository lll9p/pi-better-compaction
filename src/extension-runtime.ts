import type {
	BeforeProviderRequestEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client";
import { executeV2Compaction } from "./compact-client-v2";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { findLatestCompactionEntry, requiresNativeReplay, resolveLatestNativeCompactionEntry } from "./details-store";
import { registerMidRunGuard } from "./midrun";
import { runNativeFallbackCompaction } from "./native-fallback";
import {
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { buildRetainedMessages } from "./retained-messages";
import {
	isResponsesCompatiblePayload,
	resolveNativeCompactionEnvironment,
	type NativeCompactionRuntime,
} from "./runtime";
import { serializeMessagesToCompactRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	EXTENSION_ID,
	isNativeCompactionDetails,
	NATIVE_COMPACTION_STRATEGY,
	NATIVE_COMPACTION_STRATEGY_V2,
	type ExtensionConfig,
	type NativeCompactionDetails,
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
};

const DEFAULT_DEPENDENCIES: ExtensionRuntimeDependencies = {
	loadExtensionConfig,
	executeNativeCompaction,
	executeV2Compaction,
	runNativeFallbackCompaction,
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
				// Detailed V2 transport metadata is logged by the client, never raw error bodies.
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

function nativeCompactionPreflight(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	runtime: NativeCompactionRuntime,
): string | undefined {
	if (!ctx.sessionManager.getBranch().some((entry) => entry.id === event.preparation.firstKeptEntryId)) {
		return "missing-kept-boundary";
	}
	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras?.tools?.some((tool) => !tool || typeof tool !== "object" ||
		(tool as { type?: unknown }).type !== "function" || (tool as { defer_loading?: unknown }).defer_loading)) {
		return "unsupported-custom-or-deferred-tools";
	}
	// Our compact request does not carry Pi's grammar/deferred-tool option maps.
	// Decline before writing a placeholder checkpoint when that context is needed.
	if (ctx.sessionManager.buildSessionContext().messages.some((message) =>
		(message.role === "toolResult" && message.addedToolNames?.length) ||
		(message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.namespace !== undefined)),
	)) return "unsupported-custom-or-deferred-tools";
	return undefined;
}

async function trySessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
	nativeReplayRequired: boolean,
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

	// Branch 1: Responses-family APIs use the native /responses/compact endpoint.
	const { resolution, latestNativeCompaction } = await resolveNativeReplayEnvironment(ctx, config);
	if (resolution.ok) {
		// Continuity-break may restart a genuine text summary, never a damaged or
		// mismatched native checkpoint reclassified as "latest-compaction-not-native".
		if (nativeReplayRequired && !latestNativeCompaction?.ok) return { cancel: true };
		const preflightFailure = nativeCompactionPreflight(event, ctx, resolution.runtime);
		let responsesOutcome: ResponsesCompactOutcome;
		if (preflightFailure) {
			writeDebugArtifact("compaction-event", { event: "native-preflight-declined", reason: preflightFailure }, config, ctx);
			responsesOutcome = { outcome: "failed" };
		} else if (config.compactionVersion === "v2") {
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

	// Never summarize Pi's placeholder-only context over an existing native checkpoint.
	if (nativeReplayRequired) return { cancel: true };

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

async function resolveNativeReplayEnvironment(
	ctx: ExtensionContext,
	config: ExtensionConfig,
	payload?: unknown,
) {
	const branchEntries = ctx.sessionManager.getBranch();
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesCompactApis: config.responsesCompactApis,
	}, payload);
	const latestNativeCompaction = resolution.ok ? resolveLatestNativeCompactionEntry(branchEntries, {
		provider: resolution.runtime.provider,
		api: resolution.runtime.api,
		model: resolution.runtime.model,
		baseUrl: resolution.runtime.baseUrl,
	}) : undefined;
	return { branchEntries, resolution, latestNativeCompaction };
}

async function tryBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
) {
	const { config } = dependencies.loadExtensionConfig();
	if (!config.enabled) {
		return undefined;
	}

	// Capture compact-relevant request fields (tools, reasoning, ...) for the next
	// /responses/compact call, regardless of whether this request gets rewritten.
	if (isResponsesCompatiblePayload(event.payload)) {
		rememberRequestContext(event.payload, getSessionId(ctx));
	}

	const replayEnvironment = await resolveNativeReplayEnvironment(ctx, config, event.payload);
	const { resolution, branchEntries } = replayEnvironment;
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
	// A successful environment resolution always includes its strict identity match.
	const latestNativeCompaction = replayEnvironment.latestNativeCompaction!;
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

const NATIVE_REPLAY_BLOCKED_MESSAGE =
	"Request cancelled to protect encrypted compaction history. Restore the checkpoint's provider/model and original OAuth endpoint, " +
	"and re-enable pi-better-compaction if disabled. If replay still fails, use /tree to recover a branch before the native compaction; " +
	"do not continue from the placeholder summary with another model.";

function warnNativeReplayBlocked(ctx: ExtensionContext): void {
	// Notification failure must not undo cancellation.
	try { notifyWarning(ctx, NATIVE_REPLAY_BLOCKED_MESSAGE); } catch { /* best effort UI */ }
}

function abortNativeReplay(ctx: ExtensionContext): never {
	// Pi's runner catches hook exceptions and returns the old payload. Abort the
	// active Agent signal FIRST so the provider SDK cannot send that lossy payload.
	ctx.abort();
	warnNativeReplayBlocked(ctx);
	throw new Error(`${EXTENSION_ID}: ${NATIVE_REPLAY_BLOCKED_MESSAGE}`);
}

async function handleContext(ctx: ExtensionContext, dependencies: ExtensionRuntimeDependencies) {
	if (ctx.signal?.aborted) return;
	let nativeReplayRequired = true;
	let available = false;
	try {
		nativeReplayRequired = requiresNativeReplay(findLatestCompactionEntry(ctx.sessionManager.getBranch()));
		if (!nativeReplayRequired) return;
		const { config } = dependencies.loadExtensionConfig();
		const environment = await resolveNativeReplayEnvironment(ctx, config);
		available = environment.resolution.ok && environment.latestNativeCompaction?.ok === true;
	} catch { /* Indeterminate native state is not permission to send a placeholder. */ }
	// Google's SDK may invoke fetch after a late onPayload abort. Aborting in
	// context makes its buildParams reject before transport construction instead.
	if (nativeReplayRequired && !available) abortNativeReplay(ctx);
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
) {
	if (ctx.signal?.aborted) return undefined;
	// A failed branch read is indeterminate, not permission to send without state.
	let nativeReplayRequired = true;
	let payload: unknown;
	try {
		nativeReplayRequired = requiresNativeReplay(findLatestCompactionEntry(ctx.sessionManager.getBranch()));
		// This check precedes disabled/unsupported provider/auth/payload early exits.
		payload = await tryBeforeProviderRequest(event, ctx, dependencies);
	} catch (error) {
		if (nativeReplayRequired) abortNativeReplay(ctx);
		throw error;
	}
	if (nativeReplayRequired && payload === undefined) abortNativeReplay(ctx);
	return payload;
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
) {
	let nativeReplayRequired = true;
	try {
		nativeReplayRequired = requiresNativeReplay(findLatestCompactionEntry(ctx.sessionManager.getBranch()));
		const result = await trySessionBeforeCompact(event, ctx, dependencies, nativeReplayRequired);
		if (!nativeReplayRequired || result?.compaction) return result;
	} catch (error) {
		if (!nativeReplayRequired) throw error;
	}
	warnNativeReplayBlocked(ctx);
	// A thrown session_before_compact error is also swallowed by Pi's runner.
	// Return its supported cancellation result instead of falling into Pi compact().
	return { cancel: true };
}

export function registerExtensionRuntime(
	pi: ExtensionAPI,
	dependencies: ExtensionRuntimeDependencies = DEFAULT_DEPENDENCIES,
): void {
	registerMidRunGuard(pi, dependencies.loadExtensionConfig);

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
		handleSessionBeforeCompact(event, ctx, dependencies),
	);
	pi.on("context", (_event, ctx) => handleContext(ctx, dependencies));
	pi.on("before_provider_request", (event, ctx) =>
		handleBeforeProviderRequest(event, ctx, dependencies),
	);

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
