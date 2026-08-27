import { describe, expect, test } from "bun:test";
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import { registerMidRunGuard } from "./midrun";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function createHarness(configOverrides: Partial<ExtensionConfig["midRun"]> = {}) {
	const handlers = new Map<string, Handler[]>();
	const compactCalls: CompactOptions[] = [];
	const messages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let abortCalls = 0;
	let sessionId = "session-1";
	let idle = true;
	let pendingMessages = false;
	let usage = { tokens: 81_000, contextWindow: 100_000, percent: 81 };
	let branch: any[] = [];

	const config: ExtensionConfig = {
		...DEFAULT_EXTENSION_CONFIG,
		midRun: {
			enabled: true,
			thresholdPercent: 80,
			...configOverrides,
		},
		responsesCompactApis: [...DEFAULT_EXTENSION_CONFIG.responsesCompactApis],
	};

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: any, options: any) {
			messages.push({ message, options });
		},
	};

	const ctx = {
		hasUI: true,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		getContextUsage: () => usage,
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
		abort() {
			abortCalls += 1;
		},
		compact(options: CompactOptions = {}) {
			compactCalls.push(options);
		},
	};

	registerMidRunGuard(pi as any, () => ({ config, warnings: [] }));

	return {
		ctx,
		compactCalls,
		messages,
		notifications,
		get abortCalls() {
			return abortCalls;
		},
		setUsage(next: typeof usage) {
			usage = next;
		},
		setBranch(next: any[]) {
			branch = next;
		},
		setSessionId(next: string) {
			sessionId = next;
		},
		setIdle(next: boolean) {
			idle = next;
		},
		setPendingMessages(next: boolean) {
			pendingMessages = next;
		},
		async emit(event: string, data: any = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(data, ctx);
			}
		},
		async flushImmediate() {
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

const toolTurn = { turnIndex: 32, message: {}, toolResults: [{}] };
const proseTurn = { turnIndex: 32, message: {}, toolResults: [] };
const compactionEntry = (id: string) => ({ type: "compaction", id });

describe("mid-run guard", () => {
	test("does not abort below the threshold", async () => {
		const harness = createHarness();
		harness.setUsage({ tokens: 79_000, contextWindow: 100_000, percent: 79 });

		await harness.emit("turn_end", toolTurn);

		expect(harness.abortCalls).toBe(0);
		expect(harness.compactCalls).toHaveLength(0);
	});

	test("does not abort a final prose turn", async () => {
		const harness = createHarness();

		await harness.emit("turn_end", proseTurn);

		expect(harness.abortCalls).toBe(0);
		expect(harness.compactCalls).toHaveLength(0);
	});

	test("only aborts while the tool-bearing turn is active", async () => {
		const harness = createHarness();

		await harness.emit("turn_end", toolTurn);

		expect(harness.abortCalls).toBe(1);
		expect(harness.compactCalls).toHaveLength(0);
		expect(harness.messages).toHaveLength(0);
	});

	test("compacts exactly once after agent_settled", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);

		await harness.emit("agent_settled");
		await harness.emit("agent_settled");

		expect(harness.compactCalls).toHaveLength(1);
		expect(harness.compactCalls[0]?.customInstructions).toContain("exact next steps");
	});

	test("does not compact if another extension starts a run during agent_settled", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		harness.setIdle(false);

		await harness.emit("agent_settled");
		await harness.flushImmediate();

		expect(harness.compactCalls).toHaveLength(0);
		expect(harness.messages).toHaveLength(0);
	});

	test("midrun-does-not-double-compact-after-abort", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		harness.setBranch([compactionEntry("pi-auto-compact")]);

		await harness.emit("agent_settled");
		await harness.flushImmediate();

		expect(harness.compactCalls).toHaveLength(0);
		expect(harness.messages).toHaveLength(1);
		expect(harness.messages[0]).toEqual({
			message: expect.objectContaining({
				customType: "pi-better-compaction-midrun-resume",
				display: false,
				details: { source: "midrun-compaction" },
			}),
			options: { triggerTurn: true },
		});
	});

	test("resumes once after manual compaction succeeds", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");

		harness.compactCalls[0]?.onComplete?.({} as any);
		await harness.flushImmediate();

		expect(harness.messages).toHaveLength(1);
	});

	test("treats Already compacted with a new compaction ID as success", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");
		harness.setBranch([compactionEntry("other-extension")]);

		harness.compactCalls[0]?.onError?.(new Error("Already compacted"));
		await harness.flushImmediate();

		expect(harness.messages).toHaveLength(1);
		expect(harness.notifications).toHaveLength(0);
	});

	test("treats Already compacted without a new compaction ID as failure", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");

		harness.compactCalls[0]?.onError?.(new Error("Already compacted"));
		await harness.flushImmediate();

		expect(harness.messages).toHaveLength(0);
		expect(harness.notifications[0]).toEqual({
			message: "pi-better-compaction: mid-run compaction failed: Already compacted",
			level: "error",
		});
	});

	test("does not resume after compaction failure", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");

		harness.compactCalls[0]?.onError?.(new Error("provider unavailable"));
		await harness.flushImmediate();
		await harness.emit("turn_end", toolTurn);

		expect(harness.messages).toHaveLength(0);
		expect(harness.abortCalls).toBe(1);
	});

	test("invalidates a pending resume on session shutdown", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");
		harness.compactCalls[0]?.onComplete?.({} as any);

		await harness.emit("session_shutdown");
		harness.setSessionId("session-2");
		await harness.flushImmediate();

		expect(harness.messages).toHaveLength(0);
	});

	test("does not trigger when steering or follow-up messages are pending", async () => {
		const harness = createHarness();
		harness.setPendingMessages(true);

		await harness.emit("turn_end", toolTurn);

		expect(harness.abortCalls).toBe(0);
	});

	test("drops resume if another run starts first", async () => {
		const harness = createHarness();
		await harness.emit("turn_end", toolTurn);
		await harness.emit("agent_settled");
		harness.compactCalls[0]?.onComplete?.({} as any);
		harness.setIdle(false);

		await harness.flushImmediate();

		expect(harness.messages).toHaveLength(0);
	});
});
