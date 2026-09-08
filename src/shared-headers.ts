/**
 * Shared HTTP header construction for V1 and V2 compaction clients.
 *
 * Extracts the header building logic that was previously private in
 * compact-client.ts so both compact-client.ts and compact-client-v2.ts
 * can share it without duplication.
 */

import type { NativeCompactionRuntime } from "./runtime";

const JSON_CONTENT_TYPE = "application/json";

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}

	try {
		const payloadText = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const payload = JSON.parse(payloadText);
		return payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const authClaims = payload?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims)) {
		return undefined;
	}

	const accountId = authClaims.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
}

function buildCodexUserAgent(): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `pi (${platform}; ${arch})`;
}

/**
 * Build HTTP headers for a compaction request from the resolved runtime.
 *
 * Handles model-level headers, extension-resolved headers, authorization,
 * and Codex-specific headers (account ID, originator, user-agent, beta flag).
 *
 * @param accept - The Accept header value. Defaults to `application/json`.
 */
export function toHeaders(
	runtime: NativeCompactionRuntime,
	accept: string = JSON_CONTENT_TYPE,
	input: readonly unknown[] = [],
): Record<string, string> {
	const headers = new Headers();
	headers.set("authorization", `Bearer ${runtime.apiKey}`);
	if (runtime.provider === "github-copilot") {
		// Compaction is an agent-initiated request, even when history ends with a user.
		headers.set("x-initiator", "agent");
		headers.set("openai-intent", "conversation-edits");
		if (input.some((item) => isRecord(item) && [item.content, item.output].some((blocks) =>
			Array.isArray(blocks) && blocks.some((block) => isRecord(block) && block.type === "input_image"),
		))) {
			headers.set("copilot-vision-request", "true");
		}
	}

	if (runtime.api === "openai-codex-responses") {
		const accountId = extractCodexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", buildCodexUserAgent());
		headers.set("openai-beta", "responses=experimental");
	}

	// Defaults first, then model headers, then resolved request auth. Null means
	// remove, even for Authorization and Codex-specific headers.
	for (const source of [runtime.currentModel.headers, runtime.headers]) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value == null) headers.delete(key);
			else headers.set(key, value);
		}
	}
	// These two are mandatory transport invariants, not overridable auth defaults.
	headers.set("accept", accept);
	headers.set("content-type", JSON_CONTENT_TYPE);

	return Object.fromEntries(headers.entries());
}

/** Check whether an error represents an intentional abort (AbortController / AbortSignal). */
export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}
