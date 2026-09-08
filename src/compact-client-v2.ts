/**
 * V2 compaction streaming client.
 *
 * Sends a Responses API request with a `compaction_trigger` input item appended,
 * streams the SSE response, and collects the encrypted `compaction` output blob.
 *
 * This is the pi extension equivalent of codex-rs `compact_remote_v2.rs`.
 */

import { writeDebugArtifact } from "./debug";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import { isAbortError, toHeaders } from "./shared-headers";
import type { ArtifactContext, ExtensionConfig } from "./types";

// ── Types ──────────────────────────────────────────────────────────────

export type CompactionItem = {
	type: "compaction";
	id?: string;
	encrypted_content: string;
};

export type V2CompactionUsage = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	[key: string]: unknown;
};

export type V2CompactionSuccess = {
	ok: true;
	compactionItem: CompactionItem;
	responseId?: string;
	createdAt?: string;
	usage?: V2CompactionUsage;
	status?: number;
	outputItemTypes?: string[];
};

export type V2CompactionFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "no-compaction-output"
	| "multiple-compaction-outputs"
	| "stream-parse-error"
	| "retries-exhausted"
	| "timeout"
	| "incomplete-stream"
	| "unexpected-output-after-compaction";

export type V2CompactionFailure = {
	ok: false;
	reason: V2CompactionFailureReason;
	status?: number;
	errorMessage?: string;
	outputItemTypes?: string[];
	transportCode?: string;
};

export type V2CompactionResult = V2CompactionSuccess | V2CompactionFailure;

export type ExecuteV2CompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	maxRetries?: number;
	/** Total deadline across all attempts, including reading the stream. */
	timeoutMs?: number;
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const SSE_ACCEPT = "text/event-stream";
const DEFAULT_TIMEOUT_MS = 120_000;
// Copilot rejects compaction_trigger with a smaller explicit output ceiling.
const COPILOT_COMPACTION_OUTPUT_CEILING = 20_000;

// ── Helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCompactionItem(item: unknown): item is CompactionItem {
	return (
		isRecord(item) &&
		(item.type === "compaction" || item.type === "compaction_summary") &&
		typeof item.encrypted_content === "string" &&
		item.encrypted_content.length > 0
	);
}

function writeV2Artifact(
	data: unknown,
	settings: ExtensionConfig | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) return;
	// Never send authentication header values or opaque state to the logger.
	const scrub = (value: unknown, key = ""): unknown => {
		if (key === "headers" && isRecord(value)) return { names: Object.keys(value) };
		if (key === "encrypted_content") return "[OPAQUE STATE OMITTED]";
		if (key === "errorMessage") return "[See failure metadata]";
		if (Array.isArray(value)) return value.map((item) => scrub(item));
		if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
		return value;
	};
	writeDebugArtifact("compact-response", scrub(data), settings, context);
}

// ── SSE stream processing ──────────────────────────────────────────────

type StreamCollectionResult =
	| { ok: true; compactionItems: CompactionItem[]; responseId?: string; createdAt?: string; usage?: V2CompactionUsage; outputItemTypes: string[] }
	| { ok: false; reason: V2CompactionFailureReason; errorMessage?: string };

/**
 * Read an SSE stream from a fetch Response and collect compaction output items.
 *
 * Expected SSE events:
 * - `response.output_item.done` with a compaction item in `item`
 * - `response.completed` with `response.id`, `response.usage`, `response.created_at`
 * - `response.failed` / `error` for server-side errors
 */
async function collectStreamOutput(response: Response, signal?: AbortSignal): Promise<StreamCollectionResult> {
	if (!response.body) {
		return { ok: false, reason: "stream-parse-error", errorMessage: "Response body is null" };
	}

	let outputItems: unknown[] = [];
	let responseId: string | undefined;
	let createdAt: string | undefined;
	let usage: V2CompactionUsage | undefined;
	let completed = false;
	let serverError: string | undefined;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const cancelRead = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", cancelRead, { once: true });

	function processLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) return;
		const json = trimmed.slice(5).trim();
		if (json === "[DONE]") return;
		const event: unknown = JSON.parse(json);
		if (!isRecord(event)) throw new Error("Invalid SSE event");
		if (event.type === "response.output_item.done") {
			outputItems.push(event.item);
		} else if (event.type === "response.completed" && isRecord(event.response)) {
			const resp = event.response;
			completed = true;
			responseId = typeof resp.id === "string" ? resp.id : undefined;
			createdAt = normalizeTimestamp(resp.created_at);
			if (isRecord(resp.usage)) usage = resp.usage as V2CompactionUsage;
			// The terminal output is authoritative (some gateways omit item.done).
			if (Array.isArray(resp.output) && resp.output.length > 0) outputItems = resp.output;
		} else if (["response.failed", "response.incomplete", "error"].includes(String(event.type))) {
			const error = event.error ?? (isRecord(event.response) ? event.response.error : undefined);
			serverError = isRecord(error) && typeof error.message === "string" ? error.message : String(event.type);
		}
	}

	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		}
		if (signal?.aborted) return { ok: false, reason: "aborted" };
		buffer += decoder.decode();
		if (buffer.trim()) processLine(buffer);
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) return { ok: false, reason: "aborted" };
		return { ok: false, reason: "stream-parse-error", errorMessage: error instanceof Error ? error.message : String(error) };
	} finally {
		signal?.removeEventListener("abort", cancelRead);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}

	if (serverError) return { ok: false, reason: "stream-parse-error", errorMessage: serverError };
	if (!completed) return { ok: false, reason: "incomplete-stream" };
	const compactionItems = outputItems.filter(isCompactionItem).map((item) => ({
		type: "compaction" as const,
		...(typeof item.id === "string" ? { id: item.id } : {}),
		encrypted_content: item.encrypted_content,
	}));
	const firstCompaction = outputItems.findIndex(isCompactionItem);
	// V2 persists only retained input + blob. Never silently discard a generated tail.
	if (firstCompaction >= 0 && outputItems.slice(firstCompaction + 1).some((item) => !isCompactionItem(item))) {
		return { ok: false, reason: "unexpected-output-after-compaction" };
	}
	return { ok: true, compactionItems, responseId, createdAt, usage,
		outputItemTypes: outputItems.map((item) => isRecord(item) && typeof item.type === "string" ? item.type : "unknown") };
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(ms).toISOString();
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value.trim());
		return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
	}
	return undefined;
}

// ── Single attempt ─────────────────────────────────────────────────────

async function executeV2Attempt(
	url: string,
	requestBody: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ response?: Response; result?: StreamCollectionResult; failure?: V2CompactionFailure }> {
	if (signal?.aborted) {
		return { failure: { ok: false, reason: "aborted" } };
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal,
		});
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			return { failure: { ok: false, reason: "aborted" } };
		}
		return {
			failure: {
				ok: false,
				reason: "network-error",
				errorMessage: error instanceof Error ? error.message : String(error),
				transportCode: getTransportCode(error),
			},
		};
	}

	if (!response.ok) {
		let errorMessage: string | undefined;
		try {
			const text = await response.text();
			if (text.trim()) {
				try {
					const json = JSON.parse(text);
					errorMessage = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string"
						? json.error.message
						: text;
				} catch {
					errorMessage = text;
				}
			}
		} catch { /* swallow */ }
		return {
			response,
			failure: {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				errorMessage,
			},
		};
	}

	const result = await collectStreamOutput(response, signal);
	return { response, result };
}

// ── Retryable errors ───────────────────────────────────────────────────

function isRetryable(result: V2CompactionFailure): boolean {
	return result.reason === "network-error" || result.reason === "stream-parse-error";
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Execute a V2 compaction request.
 *
 * Builds a Responses API streaming request with a `compaction_trigger` appended
 * to the input, streams the SSE response, and collects the compaction blob.
 *
 * Retries recoverable failures up to `maxRetries` times (default 2).
 */
async function executeV2CompactionWithSignal(
	options: ExecuteV2CompactionOptions,
): Promise<V2CompactionResult> {
	const { runtime, request, signal, settings, context } = options;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	const headers = toHeaders(runtime, SSE_ACCEPT, request.input);
	const url = runtime.responsesUrl;

	// Build request body: input + compaction_trigger, stream=true.
	const requestBody = {
		...request,
		input: [...request.input, { type: "compaction_trigger" }],
		stream: true,
		...(runtime.provider === "github-copilot" ? {
			store: false,
			max_output_tokens: COPILOT_COMPACTION_OUTPUT_CEILING,
		} : {}),
	};

	let lastFailure: V2CompactionFailure | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) {
			const aborted: V2CompactionFailure = { ok: false, reason: "aborted" };
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: aborted },
				settings,
				context,
			);
			return aborted;
		}

		const { response, result, failure } = await executeV2Attempt(url, requestBody, headers, signal);

		if (failure) {
			lastFailure = failure;
			if (!isRetryable(failure) || attempt >= maxRetries) {
				writeV2Artifact(
					{ request: { url, headers, body: requestBody }, attempt, outcome: failure },
					settings,
					context,
				);
				return failure;
			}
			continue;
		}

		if (!result) {
			// Should not happen, but guard.
			lastFailure = { ok: false, reason: "stream-parse-error", errorMessage: "No result from attempt" };
			continue;
		}

		if (!result.ok) {
			lastFailure = { ok: false, reason: result.reason, status: response?.status, errorMessage: result.errorMessage };
			if (result.reason === "aborted" || !isRetryable(lastFailure) || attempt >= maxRetries) {
				writeV2Artifact(
					{ request: { url, headers, body: requestBody }, attempt, outcome: lastFailure },
					settings,
					context,
				);
				return lastFailure;
			}
			continue;
		}

		// Stream collected successfully. Validate compaction output.
		if (result.compactionItems.length === 0) {
			const noOutput: V2CompactionFailure = {
				ok: false,
				reason: "no-compaction-output",
				status: response?.status,
				outputItemTypes: result.outputItemTypes,
			};
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: noOutput },
				settings,
				context,
			);
			return noOutput;
		}

		if (result.compactionItems.length > 1) {
			const multiOutput: V2CompactionFailure = {
				ok: false,
				reason: "multiple-compaction-outputs",
				status: response?.status,
				outputItemTypes: result.outputItemTypes,
				errorMessage: `Expected 1 compaction item, got ${result.compactionItems.length}`,
			};
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: multiOutput },
				settings,
				context,
			);
			return multiOutput;
		}

		const success: V2CompactionSuccess = {
			ok: true,
			compactionItem: result.compactionItems[0]!,
			status: response?.status,
			outputItemTypes: result.outputItemTypes,
			responseId: result.responseId,
			createdAt: result.createdAt,
			usage: result.usage,
		};

		writeV2Artifact(
			{
				request: { url, headers, body: requestBody },
				attempt,
				outcome: {
					ok: true,
					responseId: success.responseId,
					createdAt: success.createdAt,
					compactionItemId: success.compactionItem.id,
					usage: success.usage,
				},
			},
			settings,
			context,
		);

		return success;
	}

	// All retries exhausted.
	const exhausted: V2CompactionFailure = {
		ok: false,
		reason: "retries-exhausted",
		errorMessage: lastFailure?.errorMessage ?? "All retry attempts failed",
	};
	writeV2Artifact(
		{ request: { url, headers, body: requestBody }, maxRetries, outcome: exhausted },
		settings,
		context,
	);
	return exhausted;
}

function getTransportCode(error: unknown): string | undefined {
	const cause = error instanceof Error ? error.cause : undefined;
	const code = isRecord(cause) ? cause.code : undefined;
	return typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_REQ_CONTENT_LENGTH_MISMATCH)$/.test(code)
		? code : undefined;
}

/** A bounded V2 attempt with payload-independent, credential-free diagnostics. */
export async function executeV2Compaction(options: ExecuteV2CompactionOptions): Promise<V2CompactionResult> {
	const deadline = new AbortController();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => deadline.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	let result: V2CompactionResult;
	try {
		result = await executeV2CompactionWithSignal({ ...options, signal });
		if (options.signal?.aborted) result = { ok: false, reason: "aborted" };
		else if (deadline.signal.aborted) result = { ok: false, reason: "timeout" };
	} finally {
		clearTimeout(timer);
	}
	if (options.settings && options.context) {
		let destination: string | undefined;
		try {
			const url = new URL(options.runtime.responsesUrl);
			destination = `${url.origin}${url.pathname}`;
		} catch { /* Do not log a malformed URL that might contain credentials. */ }
		const knownTypes = new Set(["compaction", "compaction_summary", "reasoning", "message", "function_call", "function_call_output"]);
		writeDebugArtifact("compaction-event", {
			event: "native-v2-result",
			protocol: "compaction_trigger",
			destination,
			ok: result.ok,
			status: result.status,
			reason: result.ok ? undefined : result.reason,
			transportCode: result.ok ? undefined : result.transportCode,
			outputItemTypes: result.outputItemTypes?.map((type) => knownTypes.has(type) ? type : "other"),
			compactionBlobPresent: result.ok,
			compactionBlobLength: result.ok ? result.compactionItem.encrypted_content.length : 0,
			timeoutMs,
		}, options.settings, options.context);
	}
	return result;
}
