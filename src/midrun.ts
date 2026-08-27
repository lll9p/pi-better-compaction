import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { EXTENSION_ID, type LoadedExtensionConfig } from "./types";

type MidRunPhase = "idle" | "abort-pending" | "compacting" | "resume-pending" | "failed";

type MidRunState = {
	phase: MidRunPhase;
	generation: number;
	sessionId?: string;
	baselineCompactionId?: string;
	triggerTokens?: number;
	triggerPercent?: number;
	triggerContextWindow?: number;
};

type ConfigLoader = () => LoadedExtensionConfig;

const RESUME_CUSTOM_TYPE = "pi-better-compaction-midrun-resume";
const RESUME_PROMPT = `[pi-better-compaction/midrun]
Context compaction completed. Continue the interrupted task from the exact point where execution stopped.`;
const MIDRUN_COMPACTION_INSTRUCTIONS =
	"Preserve the active task, completed work, decisions, changed files, failures, current tool-loop state, and exact next steps so execution can resume immediately after compaction.";

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function getLatestCompactionId(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "compaction") return entry.id;
	}
	return undefined;
}

function resetState(state: MidRunState): void {
	state.phase = "idle";
	state.generation += 1;
	state.sessionId = undefined;
	state.baselineCompactionId = undefined;
	state.triggerTokens = undefined;
	state.triggerPercent = undefined;
	state.triggerContextWindow = undefined;
}

function sameSession(state: MidRunState, ctx: ExtensionContext): boolean {
	return state.sessionId !== undefined && state.sessionId === getSessionId(ctx);
}

function notifyFailure(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, "error");
	}
}

function scheduleResume(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: MidRunState,
	generation: number,
): void {
	state.phase = "resume-pending";

	setImmediate(() => {
		if (
			state.generation !== generation ||
			state.phase !== "resume-pending" ||
			!sameSession(state, ctx)
		) {
			return;
		}

		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			resetState(state);
			return;
		}

		resetState(state);
		pi.sendMessage(
			{
				customType: RESUME_CUSTOM_TYPE,
				content: RESUME_PROMPT,
				display: false,
				details: { source: "midrun-compaction" },
			},
			{ triggerTurn: true },
		);
	});
}

export function registerMidRunGuard(
	pi: ExtensionAPI,
	loadConfig: ConfigLoader = loadExtensionConfig,
): void {
	const state: MidRunState = { phase: "idle", generation: 0 };

	pi.on("turn_end", (event, ctx) => {
		const { config } = loadConfig();
		if (!config.enabled || !config.midRun.enabled || state.phase !== "idle") return;
		if (event.toolResults.length === 0 || ctx.hasPendingMessages()) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.percent == null) return;
		if (usage.percent < config.midRun.thresholdPercent) return;

		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		state.phase = "abort-pending";
		state.generation += 1;
		state.sessionId = sessionId;
		state.baselineCompactionId = getLatestCompactionId(ctx);
		state.triggerTokens = usage.tokens;
		state.triggerPercent = usage.percent;
		state.triggerContextWindow = usage.contextWindow;

		writeDebugArtifact(
			"lifecycle",
			{
				event: "midrun.threshold",
				turnIndex: event.turnIndex,
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percent: usage.percent,
				thresholdPercent: config.midRun.thresholdPercent,
				baselineCompactionId: state.baselineCompactionId,
			},
			config,
			ctx,
		);

		// Never compact while the agent run is active; let Pi settle first.
		ctx.abort();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (state.phase !== "abort-pending") return;
		if (!sameSession(state, ctx)) {
			resetState(state);
			return;
		}

		// An earlier agent_settled handler may already have started or queued another run.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			resetState(state);
			return;
		}

		const generation = state.generation;
		const latestCompactionId = getLatestCompactionId(ctx);
		if (latestCompactionId !== state.baselineCompactionId) {
			const { config } = loadConfig();
			writeDebugArtifact(
				"lifecycle",
				{
					event: "midrun.coalesced",
					reason: "compaction-already-occurred-during-abort",
					baselineCompactionId: state.baselineCompactionId,
					latestCompactionId,
				},
				config,
				ctx,
			);
			scheduleResume(pi, ctx, state, generation);
			return;
		}

		const { config } = loadConfig();
		if (!config.enabled || !config.midRun.enabled) {
			scheduleResume(pi, ctx, state, generation);
			return;
		}

		const usage = ctx.getContextUsage();
		if (usage?.percent != null && usage.percent < config.midRun.thresholdPercent) {
			scheduleResume(pi, ctx, state, generation);
			return;
		}

		state.phase = "compacting";
		ctx.compact({
			customInstructions: MIDRUN_COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				if (
					state.generation !== generation ||
					state.phase !== "compacting" ||
					!sameSession(state, ctx)
				) {
					return;
				}
				scheduleResume(pi, ctx, state, generation);
			},
			onError: (error) => {
				if (state.generation !== generation || !sameSession(state, ctx)) return;

				const latest = getLatestCompactionId(ctx);
				if (/Already compacted/i.test(error.message) && latest !== state.baselineCompactionId) {
					scheduleResume(pi, ctx, state, generation);
					return;
				}

				state.phase = "failed";
				writeDebugArtifact(
					"lifecycle",
					{
						event: "midrun.failed",
						errorMessage: error.message,
						triggerTokens: state.triggerTokens,
						triggerPercent: state.triggerPercent,
						triggerContextWindow: state.triggerContextWindow,
					},
					config,
					ctx,
				);
				notifyFailure(ctx, `mid-run compaction failed: ${error.message}`);
			},
		});
	});

	pi.on("session_start", () => resetState(state));
	pi.on("session_shutdown", () => resetState(state));
}
