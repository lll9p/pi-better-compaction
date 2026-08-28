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
};

export type V2CompactionFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "no-compaction-output"
	| "multiple-compaction-outputs"
	| "stream-parse-error"
	| "retries-exhausted";

export type V2CompactionFailure = {
	ok: false;
	reason: V2CompactionFailureReason;
	status?: number;
	errorMessage?: string;
};

export type V2CompactionResult = V2CompactionSuccess | V2CompactionFailure;

export type ExecuteV2CompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	maxRetries?: number;
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const SSE_ACCEPT = "text/event-stream";

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
	writeDebugArtifact("compact-response", data, settings, context);
}

// ── SSE stream processing ──────────────────────────────────────────────

type StreamCollectionResult =
	| { ok: true; compactionItems: CompactionItem[]; responseId?: string; createdAt?: string; usage?: V2CompactionUsage }
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
	const body = response.body;
	if (!body) {
		return { ok: false, reason: "stream-parse-error", errorMessage: "Response body is null" };
	}

	const compactionItems: CompactionItem[] = [];
	let responseId: string | undefined;
	let createdAt: string | undefined;
	let usage: V2CompactionUsage | undefined;
	let serverError: string | undefined;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				reader.cancel();
				return { ok: false, reason: "aborted" as const };
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			// Keep the last incomplete line in the buffer.
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(":")) continue;
				if (!trimmed.startsWith("data: ")) continue;

				const jsonStr = trimmed.slice(6);
				if (jsonStr === "[DONE]") continue;

				let event: Record<string, unknown>;
				try {
					event = JSON.parse(jsonStr);
					if (!isRecord(event)) continue;
				} catch {
					continue;
				}

				const eventType = event.type;

				if (eventType === "response.output_item.done") {
					const item = event.item;
					if (isCompactionItem(item)) {
						compactionItems.push({
							type: "compaction",
							id: typeof item.id === "string" ? item.id : undefined,
							encrypted_content: item.encrypted_content,
						});
					}
					continue;
				}

				if (eventType === "response.completed") {
					const resp = event.response;
					if (isRecord(resp)) {
						responseId = typeof resp.id === "string" ? resp.id : undefined;
						createdAt = normalizeTimestamp(resp.created_at);
						if (isRecord(resp.usage)) {
							usage = resp.usage as V2CompactionUsage;
						}
					}
					continue;
				}

				if (eventType === "response.failed" || eventType === "error") {
					const errorObj = event.error ?? event;
					serverError = isRecord(errorObj)
						? (typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj))
						: String(errorObj);
					continue;
				}
			}
		}
	} catch (error) {
		if (isAbortError(error)) {
			return { ok: false, reason: "aborted" as const };
		}
		return { ok: false, reason: "stream-parse-error", errorMessage: error instanceof Error ? error.message : String(error) };
	} finally {
		try { reader.releaseLock(); } catch { /* noop */ }
	}

	if (serverError) {
		return { ok: false, reason: "stream-parse-error", errorMessage: serverError };
	}

	return { ok: true, compactionItems, responseId, createdAt, usage };
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
		if (isAbortError(error)) {
			return { failure: { ok: false, reason: "aborted" } };
		}
		return {
			failure: {
				ok: false,
				reason: "network-error",
				errorMessage: error instanceof Error ? error.message : String(error),
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
export async function executeV2Compaction(
	options: ExecuteV2CompactionOptions,
): Promise<V2CompactionResult> {
	const { runtime, request, signal, settings, context } = options;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	const headers = toHeaders(runtime, SSE_ACCEPT);
	const url = runtime.responsesUrl;

	// Build request body: input + compaction_trigger, stream=true.
	const requestBody = {
		...request,
		input: [...request.input, { type: "compaction_trigger" }],
		store: false,
		stream: true,
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

		const { result, failure } = await executeV2Attempt(url, requestBody, headers, signal);

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
			lastFailure = { ok: false, reason: result.reason, errorMessage: result.errorMessage };
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
