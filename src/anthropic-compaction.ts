/**
 * Anthropic on-demand server-side compaction (beta `compact-2026-09-04`).
 *
 * A request with `compaction: {type: "summarize"}` returns one signed
 * `{type: "compaction", content, signature}` block (stop_reason "compaction").
 * Later requests send that block first, verbatim, in place of the messages it
 * summarizes. Reference: docker/docker-agent pkg/model/provider/anthropic/compaction.go.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import {
	ANTHROPIC_COMPACTION_STRATEGY,
	type NativeCompactionEntry,
	type NativeCompactionIdentity,
} from "./types";

type CompleteSimple = typeof import("@earendil-works/pi-ai/compat").completeSimple;

export const ANTHROPIC_MESSAGES_API = "anthropic-messages";
export const ANTHROPIC_COMPACTION_BETA = "compact-2026-09-04";
/** Custom session entry recorded when the provider rejects a replayed block. */
export const ANTHROPIC_BLOCK_REJECTED_ENTRY = "pi-better-compaction.anthropic-block-rejected";

export type AnthropicCompactionBlock = Record<string, unknown> & {
	type: "compaction";
	content: string;
	signature: string;
};

export type AnthropicMessagesPayload = {
	model: string;
	messages: unknown[];
	[key: string]: unknown;
};

export type AnthropicReplay = {
	entry: NativeCompactionEntry;
	block: AnthropicCompactionBlock;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isAnthropicMessagesPayload(payload: unknown): payload is AnthropicMessagesPayload {
	return isRecord(payload) && typeof payload.model === "string" && Array.isArray(payload.messages);
}

export function isAnthropicCompactionBlock(value: unknown): value is AnthropicCompactionBlock {
	return (
		isRecord(value) &&
		value.type === "compaction" &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.signature)
	);
}

function withCompactionBeta(betas: unknown): string[] {
	const list = Array.isArray(betas) ? betas.filter((beta): beta is string => typeof beta === "string") : [];
	return list.includes(ANTHROPIC_COMPACTION_BETA) ? list : [...list, ANTHROPIC_COMPACTION_BETA];
}

function messageText(message: Record<string, unknown>): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

/**
 * Replace Pi's compaction summary (always messages[0] after a compaction) with the
 * signed block. Returns undefined when messages[0] is not that summary, so the
 * caller keeps Pi's own payload.
 */
export function replaceSummaryWithBlock(
	payload: AnthropicMessagesPayload,
	summary: string,
	block: AnthropicCompactionBlock,
): AnthropicMessagesPayload | undefined {
	const first = payload.messages[0];
	if (!isRecord(first) || first.role !== "user" || !messageText(first).includes(summary.trim())) {
		return undefined;
	}

	return {
		...payload,
		betas: withCompactionBeta(payload.betas),
		// ponytail: assistant role, because CLIProxyAPI prepends text to the first user
		// message and Anthropic requires the block at content index 0. The beta accepts
		// either role; the gateway's own replay uses assistant too.
		messages: [{ role: "assistant", content: [structuredClone(block)] }, ...payload.messages.slice(1)],
	};
}

/** Turn Pi's serialized request into an on-demand summary request. */
export function buildCompactionPayload(
	payload: unknown,
	options: { priorReplay?: AnthropicReplay; instructions?: string; tools?: unknown[]; omitThinking?: boolean },
): AnthropicMessagesPayload | undefined {
	if (!isAnthropicMessagesPayload(payload)) {
		return undefined;
	}

	// Without a usable prior block, Pi's text summary stays as ordinary input.
	const next: AnthropicMessagesPayload =
		(options.priorReplay &&
			replaceSummaryWithBlock(payload, options.priorReplay.entry.summary, options.priorReplay.block)) || {
			...payload,
		};
	const instructions = options.instructions?.trim();
	next.compaction = { type: "summarize", ...(instructions ? { instructions } : {}) };
	next.betas = withCompactionBeta(next.betas);
	if (options.tools && options.tools.length > 0 && next.tools === undefined) {
		next.tools = structuredClone(options.tools);
	}

	// Fields the API rejects on a summary request.
	delete next.context_management;
	delete next.stop_sequences;
	if (isRecord(next.output_config) && "format" in next.output_config) {
		const { format: _format, ...outputConfig } = next.output_config;
		next.output_config = outputConfig;
	}
	if (isRecord(next.tool_choice) && (next.tool_choice.type === "any" || next.tool_choice.type === "tool")) {
		delete next.tool_choice;
	}
	// Thinking blocks already in the history stay; only this request stops thinking.
	if (options.omitThinking) {
		delete next.thinking;
	}
	return next;
}

/**
 * Anthropic rejects `compaction` together with `context_management`. This plugin
 * never sends both, but some gateways add `context_management` themselves when
 * thinking is on: CLIProxyAPI (<= 8.0.8 at least) injects
 * `clear_thinking_20251015` into every thinking request it forwards with a
 * Claude subscription. The request is rejected before inference, so it is free
 * to retry without thinking.
 */
const CONTEXT_MANAGEMENT_CONFLICT = /compaction and context_management cannot be used/i;

export function isContextManagementConflict(status: number, body: string): boolean {
	return status === 400 && CONTEXT_MANAGEMENT_CONFLICT.test(body);
}

export type AnthropicCompactionParseResult =
	| { ok: true; block: AnthropicCompactionBlock; messageId?: string }
	| { ok: false; errorMessage: string };

function parseMessageObject(message: Record<string, unknown>): AnthropicCompactionParseResult {
	const content = Array.isArray(message.content) ? message.content : [];
	if (message.stop_reason !== "compaction") {
		return { ok: false, errorMessage: `unexpected stop reason ${JSON.stringify(message.stop_reason)}` };
	}
	if (content.length !== 1 || !isAnthropicCompactionBlock(content[0])) {
		return { ok: false, errorMessage: "expected exactly one signed compaction block" };
	}
	return {
		ok: true,
		block: content[0],
		messageId: typeof message.id === "string" ? message.id : undefined,
	};
}

/** Accumulate an Anthropic Messages SSE body (or a JSON message) into one compaction block. */
export function parseAnthropicCompactionResponse(body: string): AnthropicCompactionParseResult {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		try {
			const json = JSON.parse(trimmed);
			if (isRecord(json) && isRecord(json.error)) {
				return { ok: false, errorMessage: String(json.error.message ?? JSON.stringify(json.error)) };
			}
			return isRecord(json) ? parseMessageObject(json) : { ok: false, errorMessage: "invalid response" };
		} catch {
			return { ok: false, errorMessage: "invalid JSON response" };
		}
	}

	const message: Record<string, unknown> = { content: [] };
	const blocks: Record<string, unknown>[] = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let event: unknown;
		try {
			event = JSON.parse(line.slice(5).trim());
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;

		if (event.type === "error") {
			const error = isRecord(event.error) ? event.error : event;
			return { ok: false, errorMessage: String(error.message ?? JSON.stringify(error)) };
		}
		if (event.type === "message_start" && isRecord(event.message)) {
			message.id = event.message.id;
		} else if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
			blocks[event.index] = structuredClone(event.content_block);
		} else if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
			const block = blocks[event.index];
			const delta = event.delta;
			if (!block) continue;
			if (delta.type === "compaction_delta") {
				if (typeof delta.content === "string") block.content = `${block.content ?? ""}${delta.content}`;
				if (typeof delta.encrypted_content === "string") block.encrypted_content = delta.encrypted_content;
			} else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
				block.signature = delta.signature;
			}
		} else if (event.type === "message_delta" && isRecord(event.delta)) {
			message.stop_reason = event.delta.stop_reason;
		}
	}
	message.content = blocks.filter(Boolean);
	return parseMessageObject(message);
}

// ── Live request context ────────────────────────────────────────────────

let lastTools: { model: string; sessionId?: string; tools: unknown[] } | undefined;

/**
 * Remember tools from the latest live request. Pi does not expose its tool
 * definitions to session_before_compact, and Anthropic needs them to read
 * tool_use blocks in the conversation to summarize.
 */
export function rememberAnthropicTools(payload: AnthropicMessagesPayload, sessionId?: string): void {
	lastTools = Array.isArray(payload.tools)
		? { model: payload.model, sessionId, tools: structuredClone(payload.tools) }
		: undefined;
}

export function getAnthropicTools(model: string, sessionId?: string): unknown[] | undefined {
	if (!lastTools || lastTools.model !== model || lastTools.sessionId !== sessionId) return undefined;
	return structuredClone(lastTools.tools);
}

export function clearAnthropicTools(): void {
	lastTools = undefined;
}

// ── Session state ───────────────────────────────────────────────────────

/**
 * The latest compaction's signed block, when it was made by this strategy for
 * exactly this provider, API, model and base URL, and the provider has not
 * rejected it. Anything else replays Pi's own summary.
 */
export function resolveAnthropicReplay(
	branchEntries: readonly SessionEntry[],
	identity: NativeCompactionIdentity,
): AnthropicReplay | undefined {
	const latest = resolveLatestNativeCompactionEntry(branchEntries, identity);
	if (!latest.ok || latest.entry.details.strategy !== ANTHROPIC_COMPACTION_STRATEGY) {
		return undefined;
	}

	const window = latest.entry.details.compactedWindow;
	const block = window[0];
	if (window.length !== 1 || !isAnthropicCompactionBlock(block)) {
		return undefined;
	}

	const rejected = branchEntries
		.slice(latest.index + 1)
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === ANTHROPIC_BLOCK_REJECTED_ENTRY &&
				isRecord(entry.data) &&
				entry.data.compactionEntryId === latest.entry.id,
		);
	return rejected ? undefined : { entry: latest.entry, block };
}

// ── Summary request ─────────────────────────────────────────────────────

export type AnthropicCompactionFailureReason = "aborted" | "request-failed" | "invalid-response";

export type AnthropicCompactionResult =
	| { ok: true; block: AnthropicCompactionBlock; messageId?: string; retriedWithoutThinking?: true }
	| { ok: false; reason: AnthropicCompactionFailureReason; status?: number; errorMessage?: string };

export type ExecuteAnthropicCompactionOptions = {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	systemPrompt: string;
	/** Pi messages to summarize; a leading compactionSummary is replaced by priorReplay's block. */
	messages: AgentMessage[];
	priorReplay?: AnthropicReplay;
	tools?: unknown[];
	instructions?: string;
	reasoning?: ThinkingLevel;
	sessionId?: string;
	signal?: AbortSignal;
	/** Injectable for tests. */
	complete?: CompleteSimple;
};

/**
 * Send the summary request through pi-ai, so auth, headers, thinking and message
 * serialization match Pi's own Anthropic requests. pi-ai does not know the
 * `compaction` stop reason, so a fetch wrapper keeps the raw body for parsing.
 *
 * If a gateway turns a thinking request into a compaction/context_management
 * conflict, the summary is requested once more without thinking.
 */
export async function executeAnthropicCompaction(
	options: ExecuteAnthropicCompactionOptions,
): Promise<AnthropicCompactionResult> {
	const first = await requestAnthropicCompaction(options, false);
	if (!first.retryWithoutThinking) {
		return first.result;
	}
	const retry = await requestAnthropicCompaction(options, true);
	return retry.result.ok ? { ...retry.result, retriedWithoutThinking: true } : retry.result;
}

async function requestAnthropicCompaction(
	options: ExecuteAnthropicCompactionOptions,
	omitThinking: boolean,
): Promise<{ result: AnthropicCompactionResult; retryWithoutThinking?: boolean }> {
	let captured: { status: number; body: string } | undefined;
	let sentThinking = false;
	const captureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response = await fetch(input, init);
		const body = await response.text();
		captured = { status: response.status, body };
		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(body, { status: response.status, statusText: response.statusText, headers });
	};

	let result: Awaited<ReturnType<CompleteSimple>>;
	try {
		const complete = options.complete ?? (await import("@earendil-works/pi-ai/compat")).completeSimple;
		result = await complete(
			options.model,
			{ systemPrompt: options.systemPrompt, messages: convertToLlm(options.messages) },
			{
				apiKey: options.apiKey,
				headers: options.headers,
				signal: options.signal,
				sessionId: options.sessionId,
				reasoning: options.reasoning === "off" ? undefined : options.reasoning,
				fetch: captureFetch as typeof fetch,
				onPayload: (payload: unknown) => {
					const next = buildCompactionPayload(payload, { ...options, omitThinking });
					if (!next) throw new Error("unexpected Anthropic payload shape");
					sentThinking = next.thinking !== undefined;
					return next;
				},
			},
		);
	} catch (error) {
		if (options.signal?.aborted) return { result: { ok: false, reason: "aborted" } };
		return {
			result: { ok: false, reason: "request-failed", errorMessage: error instanceof Error ? error.message : String(error) },
		};
	}

	if (options.signal?.aborted || result.stopReason === "aborted") {
		return { result: { ok: false, reason: "aborted" } };
	}
	if (!captured) {
		return { result: { ok: false, reason: "request-failed", errorMessage: result.errorMessage ?? "no response" } };
	}
	if (captured.status < 200 || captured.status >= 300) {
		return {
			result: {
				ok: false,
				reason: "request-failed",
				status: captured.status,
				errorMessage: result.errorMessage ?? captured.body.slice(0, 500),
			},
			retryWithoutThinking: sentThinking && isContextManagementConflict(captured.status, captured.body),
		};
	}

	const parsed = parseAnthropicCompactionResponse(captured.body);
	return {
		result: parsed.ok
			? { ok: true, block: parsed.block, messageId: parsed.messageId }
			: { ok: false, reason: "invalid-response", status: captured.status, errorMessage: parsed.errorMessage },
	};
}
