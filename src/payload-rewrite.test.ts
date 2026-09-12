import { describe, expect, test } from "bun:test";
import { alignPrunedInput } from "./payload-rewrite";

// Helper: a non-tool-output item (user message)
const userMsg = (text: string) => ({ type: "message", role: "user", content: text });

// Helper: a function_call_output item
const toolOut = (callId: string, output: string) => ({
	type: "function_call_output",
	call_id: callId,
	output,
});

describe("alignPrunedInput", () => {
	test("identical arrays return identity indices", () => {
		const items = [userMsg("hi"), toolOut("c1", "result"), userMsg("bye")];
		expect(alignPrunedInput(items, items)).toEqual([0, 1, 2]);
	});

	test("empty arrays return empty indices", () => {
		expect(alignPrunedInput([], [])).toEqual([]);
	});

	test("non-tool items must match exactly", () => {
		const actual = [userMsg("hello")];
		const expected = [userMsg("world")];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("tool outputs match by call_id, ignoring output field differences", () => {
		const actual = [toolOut("c1", "pruned-output")];
		const expected = [toolOut("c1", "original-full-output")];
		expect(alignPrunedInput(actual, expected)).toEqual([0]);
	});

	test("tool output run reordered in actual still matches by call_id", () => {
		const actual = [toolOut("c2", "r2"), toolOut("c1", "r1")];
		const expected = [toolOut("c1", "full1"), toolOut("c2", "full2")];
		// actual[0] (c2) matches expected[1], actual[1] (c1) matches expected[0]
		expect(alignPrunedInput(actual, expected)).toEqual([1, 0]);
	});

	test("missing expected tool output in actual returns undefined", () => {
		const actual = [toolOut("c1", "r1")];
		const expected = [toolOut("c1", "full1"), toolOut("c2", "full2")];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("extra actual tool output not in expected returns undefined", () => {
		const actual = [toolOut("c1", "r1"), toolOut("c3", "r3")];
		const expected = [toolOut("c1", "full1")];
		// c3 has no matching call_id in expected
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("mixed non-tool and tool items align correctly", () => {
		const actual = [
			userMsg("question"),
			toolOut("c1", "pruned1"),
			toolOut("c2", "pruned2"),
			userMsg("follow-up"),
		];
		const expected = [
			userMsg("question"),
			toolOut("c1", "full-output-1"),
			toolOut("c2", "full-output-2"),
			userMsg("follow-up"),
		];
		expect(alignPrunedInput(actual, expected)).toEqual([0, 1, 2, 3]);
	});

	test("actual longer than expected returns undefined", () => {
		const actual = [userMsg("a"), userMsg("b")];
		const expected = [userMsg("a")];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("actual shorter than expected returns undefined", () => {
		const actual = [userMsg("a")];
		const expected = [userMsg("a"), userMsg("b")];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("duplicate call_id in expected returns undefined", () => {
		const actual = [toolOut("c1", "r1"), toolOut("c1", "r2")];
		const expected = [toolOut("c1", "full1"), toolOut("c1", "full2")];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("tool output with non-string call_id returns undefined", () => {
		const actual = [{ type: "function_call_output", call_id: 123, output: "r" }];
		const expected = [{ type: "function_call_output", call_id: 123, output: "full" }];
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});

	test("tool output fields besides output must still match", () => {
		const actual = [{ type: "function_call_output", call_id: "c1", output: "x", status: "error" }];
		const expected = [{ type: "function_call_output", call_id: "c1", output: "y", status: "ok" }];
		// status differs => should fail (only output is ignored)
		expect(alignPrunedInput(actual, expected)).toBeUndefined();
	});
});
