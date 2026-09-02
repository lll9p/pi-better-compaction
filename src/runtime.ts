import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESPONSES_COMPACT_CAPABLE_APIS } from "./types";

const OPENAI_COMPACT_PATH = "responses/compact";
const CODEX_COMPACT_PATH = "codex/responses/compact";
const OPENAI_RESPONSES_PATH = "responses";
const CODEX_RESPONSES_PATH = "codex/responses";

type ResponsesCompactApi = (typeof RESPONSES_COMPACT_CAPABLE_APIS)[number];

type RuntimeModel = Model<Api>;

type NativeCompactionFailureReason =
	| "disabled"
	| "missing-model"
	| "unsupported-api"
	| "missing-base-url"
	| "missing-api-key"
	| "unsupported-payload"
	| "payload-model-mismatch";

export type NativeCompactionSupportOptions = {
	enabled?: boolean;
	/** Which Responses APIs should use the compact endpoint; defaults to all capable APIs. */
	responsesCompactApis?: readonly string[];
};

export type ResponsesCompatibleRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type NativeCompactionRuntime = {
	provider: string;
	api: ResponsesCompactApi;
	model: string;
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
	compactPath: string;
	compactUrl: string;
	responsesUrl: string;
	payload?: ResponsesCompatibleRequestPayload;
	currentModel: RuntimeModel;
};

export type NativeCompactionEnvironmentFailure = {
	ok: false;
	reason: NativeCompactionFailureReason;
	provider?: string;
	api?: string;
	model?: string;
	baseUrl?: string;
};

export type NativeCompactionEnvironmentSuccess = {
	ok: true;
	runtime: NativeCompactionRuntime;
};

export type NativeCompactionEnvironmentResolution =
	| NativeCompactionEnvironmentFailure
	| NativeCompactionEnvironmentSuccess;

function normalizeConfiguredApis(values: readonly string[] | undefined): Set<string> {
	if (values === undefined) {
		return new Set(RESPONSES_COMPACT_CAPABLE_APIS);
	}
	return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

export function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized ? normalized : undefined;
}

function buildOpenAIResponsesUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (normalized.endsWith("/responses")) {
		return normalized;
	}
	return `${normalized}/${OPENAI_RESPONSES_PATH}`;
}

function buildCodexResponsesUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (normalized.endsWith("/codex/responses")) {
		return normalized;
	}
	if (normalized.endsWith("/codex")) {
		return `${normalized}/responses`;
	}
	return `${normalized}/${CODEX_RESPONSES_PATH}`;
}

export function buildResponsesUrl(baseUrl: string, api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? buildCodexResponsesUrl(baseUrl) : buildOpenAIResponsesUrl(baseUrl);
}

function buildOpenAICompactUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (normalized.endsWith("/responses")) {
		return `${normalized}/compact`;
	}
	return `${normalized}/${OPENAI_COMPACT_PATH}`;
}

function buildCodexCompactUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (normalized.endsWith("/codex/responses")) {
		return `${normalized}/compact`;
	}
	if (normalized.endsWith("/codex")) {
		return `${normalized}/responses/compact`;
	}
	return `${normalized}/${CODEX_COMPACT_PATH}`;
}

export function buildCompactUrl(baseUrl: string, api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? buildCodexCompactUrl(baseUrl) : buildOpenAICompactUrl(baseUrl);
}

export function buildCompactPath(api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? CODEX_COMPACT_PATH : OPENAI_COMPACT_PATH;
}

/** Strip null-valued entries so downstream consumers receive a clean Record<string, string>. */
function filterNullHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) {
			filtered[key] = value;
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

async function resolveRequestAuth(
	ctx: ExtensionContext,
	model: RuntimeModel,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	const modelRegistry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (currentModel: RuntimeModel) => Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string | null> }
			| { ok: false; error: string }
		>;
	};

	if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
		return {};
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok ? { apiKey: auth.apiKey, headers: filterNullHeaders(auth.headers) } : {};
}

export function isSupportedApi(api: string): api is ResponsesCompactApi {
	return (RESPONSES_COMPACT_CAPABLE_APIS as readonly string[]).includes(api);
}

export function isResponsesCompatiblePayload(payload: unknown): payload is ResponsesCompatibleRequestPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return typeof candidate.model === "string" && Array.isArray(candidate.input);
}

export function getRuntimeModelDescriptor(model: RuntimeModel | undefined): {
	provider?: string;
	api?: string;
	model?: string;
	baseUrl?: string;
} {
	if (!model) {
		return {};
	}

	return {
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: normalizeBaseUrl(model.baseUrl),
	};
}

export async function resolveNativeCompactionEnvironment(
	ctx: ExtensionContext,
	options: NativeCompactionSupportOptions = {},
	payload?: unknown,
): Promise<NativeCompactionEnvironmentResolution> {
	if (options.enabled === false) {
		return {
			ok: false,
			reason: "disabled",
		};
	}

	const modelChange = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "model_change");
	const currentModel =
		ctx.model ??
		(modelChange?.type === "model_change"
			? ctx.modelRegistry.find(modelChange.provider, modelChange.modelId)
			: undefined);
	const descriptor = getRuntimeModelDescriptor(currentModel);
	if (!currentModel || !descriptor.provider || !descriptor.api || !descriptor.model) {
		return {
			ok: false,
			reason: "missing-model",
			...descriptor,
		};
	}

	// The compact endpoint is selected purely by API family: any provider speaking
	// openai-responses/openai-codex-responses gets a native compact attempt and fails
	// open (to the fallback model or pi's default) when the endpoint is missing.
	const configuredApis = normalizeConfiguredApis(options.responsesCompactApis);
	if (!configuredApis.has(descriptor.api) || !isSupportedApi(descriptor.api)) {
		return {
			ok: false,
			reason: "unsupported-api",
			...descriptor,
		};
	}

	if (!descriptor.baseUrl) {
		return {
			ok: false,
			reason: "missing-base-url",
			...descriptor,
		};
	}

	let requestPayload: ResponsesCompatibleRequestPayload | undefined;
	if (payload !== undefined) {
		if (!isResponsesCompatiblePayload(payload)) {
			return {
				ok: false,
				reason: "unsupported-payload",
				...descriptor,
			};
		}

		if (payload.model !== descriptor.model) {
			return {
				ok: false,
				reason: "payload-model-mismatch",
				...descriptor,
			};
		}

		requestPayload = payload;
	}

	const { apiKey, headers } = await resolveRequestAuth(ctx, currentModel);
	if (!apiKey) {
		return {
			ok: false,
			reason: "missing-api-key",
			...descriptor,
		};
	}

	return {
		ok: true,
		runtime: {
			provider: descriptor.provider,
			api: descriptor.api,
			model: descriptor.model,
			baseUrl: descriptor.baseUrl,
			apiKey,
			headers,
			compactPath: buildCompactPath(descriptor.api),
			compactUrl: buildCompactUrl(descriptor.baseUrl, descriptor.api),
			responsesUrl: buildResponsesUrl(descriptor.baseUrl, descriptor.api),
			payload: requestPayload,
			currentModel,
		},
	};
}

export async function getNativeCompactionRuntime(
	ctx: ExtensionContext,
	options: NativeCompactionSupportOptions = {},
	payload?: unknown,
): Promise<NativeCompactionRuntime | undefined> {
	const resolution = await resolveNativeCompactionEnvironment(ctx, options, payload);
	return resolution.ok ? resolution.runtime : undefined;
}
