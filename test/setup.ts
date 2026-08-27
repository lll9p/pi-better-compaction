import { mock } from "bun:test";

const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

mock.module("@earendil-works/pi-coding-agent", () => ({
	compact: async () => {
		throw new Error("unexpected call to pi's real compact() in tests");
	},
	convertToLlm: (messages: Array<Record<string, unknown>>) =>
		messages.map((message) =>
			message.role === "compactionSummary"
				? {
					role: "user",
					content: [
						{
							type: "text",
							text: `${COMPACTION_SUMMARY_PREFIX}${message.summary ?? ""}\n</summary>`,
						},
					],
					timestamp: message.timestamp,
				}
				: message,
		),
}));
