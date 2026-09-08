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

test("Copilot vision follows image content, including tool outputs, and is absent for text-only input", () => {
	const copilot = runtime({ provider: "github-copilot", api: "openai-responses" });
	const textHeaders = toHeaders(copilot, "application/json", [{ role: "user", content: "hello" }]);
	expect(textHeaders["x-initiator"]).toBe("agent");
	expect(textHeaders["openai-intent"]).toBe("conversation-edits");
	expect(textHeaders["copilot-vision-request"]).toBeUndefined();
	const imageOutput = [{ type: "function_call_output", output: [{ type: "input_image", image_url: "data:image/png;base64,test" }] }];
	expect(toHeaders(copilot, "application/json", imageOutput)["copilot-vision-request"]).toBe("true");
	expect(toHeaders(runtime(), "application/json", imageOutput)["copilot-vision-request"]).toBeUndefined();
});
