import { describe, expect, test } from "bun:test";
import { buildResponsesUrl, resolveNativeCompactionEnvironment } from "../src/runtime";
import { toHeaders } from "../src/shared-headers";

describe("buildResponsesUrl", () => {
	test("builds openai responses URL", () => {
		expect(buildResponsesUrl("https://api.openai.com/v1", "openai-responses")).toBe(
			"https://api.openai.com/v1/responses",
		);
	});

	test("builds codex responses URL", () => {
		expect(buildResponsesUrl("https://chatgpt.com/backend-api", "openai-codex-responses")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
	});

	test("handles baseUrl already ending in /codex for codex API", () => {
		expect(buildResponsesUrl("https://chatgpt.com/backend-api/codex", "openai-codex-responses")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
	});

	test("handles baseUrl already ending in /codex/responses for codex API", () => {
		expect(buildResponsesUrl("https://chatgpt.com/backend-api/codex/responses", "openai-codex-responses")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
	});

	test("handles baseUrl already ending in /responses for openai API", () => {
		expect(buildResponsesUrl("https://api.openai.com/v1/responses", "openai-responses")).toBe(
			"https://api.openai.com/v1/responses",
		);
	});
});

describe("resolveNativeCompactionEnvironment", () => {
	test("uses getApiKeyAndHeaders to resolve request auth", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [] },
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.6-sol",
				baseUrl: "https://example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders(model: { provider: string; id: string }) {
					if (model.provider !== "openai" || model.id !== "gpt-5.6-sol") {
						return { ok: false, error: "unexpected model" };
					}
					return {
						ok: true,
						apiKey: "sk-openai",
						headers: {
							"x-test-request-header": "present",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-5.6-sol",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-openai",
				headers: {
					"x-test-request-header": "present",
				},
				compactPath: "responses/compact",
				compactUrl: "https://example.com/v1/responses/compact",
				responsesUrl: "https://example.com/v1/responses",
			}),
		});
	});

	test("returns missing-api-key when request auth resolves without an api key", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [] },
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.6-sol",
				baseUrl: "https://example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return {
						ok: true,
						apiKey: undefined,
						headers: {
							"x-test-request-header": "present",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: false,
			reason: "missing-api-key",
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.6-sol",
			baseUrl: "https://example.com/v1",
		});
	});

	test("selects by API family: any provider speaking openai-responses qualifies by default", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [] },
			model: {
				provider: "custom-litellm",
				api: "openai-responses",
				id: "gpt-5.6-sol",
				baseUrl: "https://proxy.example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders(model: { provider: string; id: string }) {
					if (model.provider !== "custom-litellm" || model.id !== "gpt-5.6-sol") {
						return { ok: false, error: "unexpected model" };
					}
					return {
						ok: true,
						apiKey: "sk-custom-litellm",
						headers: {
							"x-proxy-header": "proxy-value",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				provider: "custom-litellm",
				api: "openai-responses",
				model: "gpt-5.6-sol",
				baseUrl: "https://proxy.example.com/v1",
				apiKey: "sk-custom-litellm",
				headers: {
					"x-proxy-header": "proxy-value",
				},
				compactPath: "responses/compact",
				compactUrl: "https://proxy.example.com/v1/responses/compact",
			}),
		});
	});

	test("rejects non-Responses APIs so they take the native-method fallback path", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [] },
			model: {
				provider: "anthropic",
				api: "anthropic-messages",
				id: "claude-sonnet-5",
				baseUrl: "https://api.anthropic.com",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "sk-ant" };
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: false,
			reason: "unsupported-api",
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-sonnet-5",
			baseUrl: "https://api.anthropic.com",
		});
	});

	test("honors responsesCompactApis narrowing from config", async () => {
		const resolution = await resolveNativeCompactionEnvironment(
			{
				sessionManager: { getBranch: () => [] },
				model: {
					provider: "openai",
					api: "openai-responses",
					id: "gpt-5.6-sol",
					baseUrl: "https://example.com/v1",
				},
				modelRegistry: {
					async getApiKeyAndHeaders() {
						return { ok: true, apiKey: "sk-openai" };
					},
				},
			} as any,
			{
				responsesCompactApis: ["openai-codex-responses"],
			},
		);

		expect(resolution).toEqual({
			ok: false,
			reason: "unsupported-api",
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.6-sol",
			baseUrl: "https://example.com/v1",
		});
	});

	test("preserves resolved null header removals until model headers have been merged", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [] },
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.6-sol",
				baseUrl: "https://example.com/v1",
				headers: { "x-remove": "model-value", "x-keep": "model-value" },
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return {
						ok: true,
						apiKey: "sk-openai",
						headers: {
							"x-keep": "yes",
							"x-remove": null,
							"x-also-keep": "ok",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				apiKey: "sk-openai",
				headers: {
					"x-keep": "yes",
					"x-also-keep": "ok",
					"x-remove": null,
				},
			}),
		});
		if (resolution.ok) {
			expect(toHeaders(resolution.runtime)["x-remove"]).toBeUndefined();
			expect(toHeaders(resolution.runtime)["x-keep"]).toBe("yes");
		}
	});

	test("OAuth baseUrl overrides configuration for transport and native identity without mutating model", async () => {
		const model = { provider: "github-copilot", api: "openai-responses", id: "gpt-6-astra", baseUrl: "https://api.individual.githubcopilot.com" };
		const resolution = await resolveNativeCompactionEnvironment({
			model,
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", baseUrl: "https://api.enterprise.githubcopilot.com/", headers: { "x-oauth": "resolved" } }),
			},
		} as any);
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.runtime.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
		expect(resolution.runtime.responsesUrl).toBe("https://api.enterprise.githubcopilot.com/responses");
		expect(resolution.runtime.compactUrl).toBe("https://api.enterprise.githubcopilot.com/responses/compact");
		expect(resolution.runtime.currentModel.baseUrl).toBe(resolution.runtime.baseUrl);
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
		expect(toHeaders(resolution.runtime)["x-oauth"]).toBe("resolved");
	});

	test("resolves OAuth transport from the session model when ctx.model is absent", async () => {
		const model = { provider: "github-copilot", api: "openai-responses", id: "gpt-6-astra", baseUrl: "https://api.individual.githubcopilot.com" };
		const resolution = await resolveNativeCompactionEnvironment({
			sessionManager: { getBranch: () => [{ type: "model_change", provider: model.provider, modelId: model.id }] },
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: async (currentModel: unknown) => {
					expect(currentModel).toBe(model);
					return { ok: true, apiKey: "test", baseUrl: "https://api.business.githubcopilot.com" };
				},
			},
		} as any);
		expect(resolution).toMatchObject({
			ok: true,
			runtime: {
				model: model.id,
				baseUrl: "https://api.business.githubcopilot.com",
				responsesUrl: "https://api.business.githubcopilot.com/responses",
			},
		});
	});
});
