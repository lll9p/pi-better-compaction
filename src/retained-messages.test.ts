import { describe, expect, test } from "bun:test";
import {
	buildRetainedMessages,
	estimateItemTokens,
	isRetainedItem,
	RETAINED_MESSAGE_TOKEN_BUDGET,
} from "./retained-messages";

describe("isRetainedItem", () => {
	test("retains user, developer, and system roles", () => {
		expect(isRetainedItem({ role: "user", content: "hi" })).toBe(true);
		expect(isRetainedItem({ role: "developer", content: "instruction" })).toBe(true);
		expect(isRetainedItem({ role: "system", content: "system prompt" })).toBe(true);
	});

	test("excludes assistant and function_call roles", () => {
		expect(isRetainedItem({ role: "assistant", content: "answer" })).toBe(false);
		expect(isRetainedItem({ type: "function_call", name: "read" })).toBe(false);
		expect(isRetainedItem({ type: "function_call_output", output: "result" })).toBe(false);
	});

	test("excludes compaction and reasoning items", () => {
		expect(isRetainedItem({ type: "compaction", encrypted_content: "blob" })).toBe(false);
		expect(isRetainedItem({ type: "reasoning", content: "thinking" })).toBe(false);
	});

	test("excludes non-object values", () => {
		expect(isRetainedItem(null)).toBe(false);
		expect(isRetainedItem(undefined)).toBe(false);
		expect(isRetainedItem("string")).toBe(false);
		expect(isRetainedItem(42)).toBe(false);
		expect(isRetainedItem([{ role: "user" }])).toBe(false);
	});

	test("excludes objects without a string role", () => {
		expect(isRetainedItem({})).toBe(false);
		expect(isRetainedItem({ role: 42 })).toBe(false);
		expect(isRetainedItem({ role: null })).toBe(false);
	});
});

describe("estimateItemTokens", () => {
	test("estimates based on JSON string length / 4", () => {
		const item = { role: "user", content: "hello world" };
		const json = JSON.stringify(item);
		expect(estimateItemTokens(item)).toBe(Math.ceil(json.length / 4));
	});

	test("returns 0 for circular references", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(estimateItemTokens(circular)).toBe(0);
	});

	test("handles simple values", () => {
		expect(estimateItemTokens("hello")).toBeGreaterThan(0);
		expect(estimateItemTokens(42)).toBeGreaterThan(0);
		expect(estimateItemTokens(null)).toBeGreaterThan(0);
	});
});

describe("buildRetainedMessages", () => {
	function userItem(text: string) {
		return { role: "user", content: [{ type: "input_text", text }] };
	}

	function developerItem(text: string) {
		return { role: "developer", content: [{ type: "input_text", text }] };
	}

	function assistantItem(text: string) {
		return {
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text }],
		};
	}

	function functionCallItem(name: string) {
		return { type: "function_call", name, arguments: "{}" };
	}

	function functionCallOutputItem(output: string) {
		return { type: "function_call_output", output };
	}

	test("returns only user/developer/system items from a mixed input", () => {
		const input = [
			developerItem("system instruction"),
			userItem("hello"),
			assistantItem("reply"),
			functionCallItem("read"),
			functionCallOutputItem("file content"),
			userItem("follow-up"),
		];

		const result = buildRetainedMessages(input, 100_000);
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual(developerItem("system instruction"));
		expect(result[1]).toEqual(userItem("hello"));
		expect(result[2]).toEqual(userItem("follow-up"));
	});

	test("returns items in chronological order (newest-first selection, reversed output)", () => {
		const input = [
			userItem("first"),
			userItem("second"),
			userItem("third"),
		];

		// With a tight budget that fits only 2 items, the 2 most recent should be kept.
		const singleItemTokens = estimateItemTokens(userItem("first"));
		const budget = singleItemTokens * 2 + 1; // fits exactly 2
		const result = buildRetainedMessages(input, budget);

		expect(result).toHaveLength(2);
		// Most recent 2 items, but in chronological order
		expect(result[0]).toEqual(userItem("second"));
		expect(result[1]).toEqual(userItem("third"));
	});

	test("excludes oversized items (>10K tokens)", () => {
		// 10K tokens ≈ 40K chars. Create an item larger than that.
		const bigText = "x".repeat(50_000);
		const input = [
			userItem(bigText),
			userItem("small"),
		];

		const result = buildRetainedMessages(input, 100_000);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(userItem("small"));
	});

	test("returns empty array for empty input", () => {
		expect(buildRetainedMessages([])).toEqual([]);
	});

	test("returns empty array when no items have retained roles", () => {
		const input = [
			assistantItem("reply"),
			functionCallItem("search"),
			functionCallOutputItem("results"),
		];
		expect(buildRetainedMessages(input)).toEqual([]);
	});

	test("returns empty array when budget is 0", () => {
		const input = [userItem("hello")];
		expect(buildRetainedMessages(input, 0)).toEqual([]);
	});

	test("uses the default budget constant when none specified", () => {
		// The default should be RETAINED_MESSAGE_TOKEN_BUDGET (65536).
		// With small items, all should fit.
		const input = [userItem("a"), userItem("b")];
		const result = buildRetainedMessages(input);
		expect(result).toHaveLength(2);
		// Verify the constant is exported as expected
		expect(RETAINED_MESSAGE_TOKEN_BUDGET).toBe(65_536);
	});

	test("deep-clones items so mutations don't affect the originals", () => {
		const original = userItem("original");
		const input = [original];
		const result = buildRetainedMessages(input, 100_000);

		// Mutate the result
		(result[0] as Record<string, unknown>).role = "mutated";
		expect(original.role).toBe("user");
	});

	test("budget boundary: item exactly at budget fits", () => {
		const item = userItem("test");
		const tokens = estimateItemTokens(item);
		const result = buildRetainedMessages([item], tokens);
		expect(result).toHaveLength(1);
	});

	test("budget boundary: item one token over budget does not fit", () => {
		const item = userItem("test");
		const tokens = estimateItemTokens(item);
		const result = buildRetainedMessages([item], tokens - 1);
		expect(result).toHaveLength(0);
	});
});
