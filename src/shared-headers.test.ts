import { expect, test } from "bun:test";
import { toHeaders } from "./shared-headers";

function runtime(overrides: any = {}) {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "default-account" } })).toString("base64url");
	return { provider: "openai-codex", api: "openai-codex-responses", apiKey: `header.${payload}.signature`, currentModel: { headers: {} }, ...overrides } as any;
}

test("resolved Authorization:null deletes the default bearer and model authorization case-insensitively", () => {
	const headers = toHeaders(runtime({ currentModel: { headers: { AUTHORIZATION: "Bearer model-default" } }, headers: { Authorization: null } }));
	expect(headers.authorization).toBeUndefined();
});

test("resolved Codex headers override or remove defaults and model values", () => {
	const headers = toHeaders(runtime({ currentModel: { headers: { originator: "model-origin", "OpenAI-Beta": "model-beta" } }, headers: { "ChatGPT-Account-ID": null, ORIGINATOR: "resolved-origin", "User-Agent": "resolved-agent", "openai-beta": null } }));
	expect(headers["chatgpt-account-id"]).toBeUndefined();
	expect(headers.originator).toBe("resolved-origin");
	expect(headers["user-agent"]).toBe("resolved-agent");
	expect(headers["openai-beta"]).toBeUndefined();
});

test("only accept and content-type are mandatory transport exceptions to resolved header overrides", () => {
	const headers = toHeaders(runtime({ headers: { Accept: null, "Content-Type": "text/plain", Authorization: "Bearer explicitly-resolved" } }), "text/event-stream");
	expect(headers.accept).toBe("text/event-stream");
	expect(headers["content-type"]).toBe("application/json");
	expect(headers.authorization).toBe("Bearer explicitly-resolved");
});
