import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { ResponsesCompatibleRequestPayload } from "./runtime";

/**
 * pi stopped exporting the CompactionPreparation type name in 0.80.x, but it is still
 * structurally the first argument of the exported compact(). Derive it from there so we
 * track pi's shape without depending on a private export.
 */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * Use Pi's exported Responses converter (available via api/* in Pi >= 0.84.3).
 * In particular, unsigned IDs, cross-model signatures and tool pairing must match
 * the provider payload exactly; a second local implementation is unsafe here.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "pi-responses-serializer" as const;
// Both Pi's openai-responses and openai-codex-responses use this provider set.
const RESPONSES_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
	/**
	 * Optional passthrough fields mirroring the latest codex_rs CompactionInput.
	 * Sourced from the most recent provider request payload when available;
	 * undefined fields are omitted from the serialized JSON body.
	 */
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	prompt_cache_key?: string;
	text?: Record<string, unknown>;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function collectCompactionWindowMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparation;
	instructions: string;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	return convertResponsesMessages(model, {
		messages: convertToLlm(messages),
		systemPrompt: options.includeInstructionsInInput ? options.instructions : undefined,
	}, RESPONSES_TOOL_CALL_PROVIDERS) as ResponsesInputItem[];
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call") {
		return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output") {
		return "function_call_output";
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
