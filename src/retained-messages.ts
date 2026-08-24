/**
 * V2 compaction retained-message filtering.
 *
 * After the API returns an encrypted compaction blob, V2 keeps a window of recent
 * user/developer/system messages alongside the blob so the model retains explicit
 * user instructions and context anchors. This module mirrors the filtering and
 * budget logic from codex-rs `compact_remote_v2.rs`.
 */

/** Token budget for retained messages (matches codex-rs RETAINED_MESSAGE_TOKEN_BUDGET). */
export const RETAINED_MESSAGE_TOKEN_BUDGET = 65_536;

/** Messages larger than this are excluded even if they are of a retained role. */
const MAX_SINGLE_ITEM_TOKENS = 10_000;

/** Rough chars-per-token ratio for budget estimation. */
const CHARS_PER_TOKEN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Estimate the token count of an opaque input item by serializing to JSON and
 * dividing by the chars-per-token ratio. This is intentionally rough — codex-rs
 * uses a real tokenizer but we don't have one in the extension runtime.
 */
export function estimateItemTokens(item: unknown): number {
	try {
		const length = JSON.stringify(item).length;
		return Math.ceil(length / CHARS_PER_TOKEN);
	} catch {
		return 0;
	}
}

/**
 * Whether an input item should be retained alongside the compaction blob.
 *
 * Retained roles (matching codex-rs `is_retained_for_remote_compaction_v2`):
 * - `user` messages
 * - `developer` messages
 * - `system` messages
 *
 * Everything else (assistant, function_call, function_call_output, reasoning,
 * compaction, etc.) is excluded.
 */
export function isRetainedItem(item: unknown): boolean {
	if (!isRecord(item)) {
		return false;
	}

	const role = item.role;
	if (typeof role === "string") {
		return role === "user" || role === "developer" || role === "system";
	}

	return false;
}

/**
 * From a list of Responses API input items, select the most recent retained
 * messages that fit within the token budget. Items are selected newest-first
 * (reverse order) and returned in their original chronological order.
 *
 * Oversized individual items (> MAX_SINGLE_ITEM_TOKENS) are skipped.
 */
export function buildRetainedMessages(
	input: readonly unknown[],
	budget: number = RETAINED_MESSAGE_TOKEN_BUDGET,
): unknown[] {
	// Filter to retained roles first.
	const retained: Array<{ index: number; item: unknown; tokens: number }> = [];
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		if (!isRetainedItem(item)) continue;

		const tokens = estimateItemTokens(item);
		if (tokens > MAX_SINGLE_ITEM_TOKENS) continue;

		retained.push({ index: i, item, tokens });
	}

	// Select from newest to oldest within the budget.
	let remaining = budget;
	const selected: typeof retained = [];

	for (let i = retained.length - 1; i >= 0; i--) {
		const entry = retained[i]!;
		if (entry.tokens > remaining) break;
		remaining -= entry.tokens;
		selected.push(entry);
	}

	// Return in original chronological order.
	selected.reverse();
	return selected.map((entry) => structuredClone(entry.item));
}
