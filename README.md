# pi-better-compaction

English | [中文](README.zh-CN.md)

A [pi](https://github.com/nicepkg/pi) extension that upgrades context compaction with three coordinated strategies:

1. An optional **mid-run guard** aborts an oversized tool loop, waits for `agent_settled`, compacts once, then resumes with a hidden custom message.
2. **OpenAI Responses APIs** use the provider's native compaction endpoint, preserving opaque context that plain text summaries lose.
3. **All other APIs** (Anthropic, Gemini, etc.) can run pi's built-in compaction with a **dedicated cheaper/faster model**, so summarization doesn't consume quota on your primary model.

Initial compaction attempts can fall back to pi's default summarization. **Once a native checkpoint exists, replay failures cancel the request instead of sending a placeholder without its encrypted history.** Keep this extension loaded while continuing a native-compacted session.

## Install

```bash
# From npm (recommended)
pi install npm:@lll9p/pi-better-compaction

# Try without installing
pi -e npm:@lll9p/pi-better-compaction

# From source
git clone https://github.com/lll9p/pi-better-compaction.git
cd pi-better-compaction && pi install .
```

After installation, run `/reload`.

## Requirements

- **pi** ≥ 0.84.3 (`@earendil-works/pi-coding-agent >= 0.84.3`, `@earendil-works/pi-ai >= 0.84.3`)
- Serialization uses Pi's exported Responses converter. Paired Pi/pi-ai **0.84.3 and 0.84.4** are tested; future SDK versions are not pre-verified. Strict replay validation cancels rather than ignoring incompatibilities.

## Configuration

Config file location:

```
~/.pi/agent/extensions/pi-better-compaction/config.json
```

If the file doesn't exist, all defaults apply. The extension never creates this file.

### Defaults

```jsonc
{
  "enabled": true,
  "midRun": {
    "enabled": false,
    "thresholdPercent": 80
  },
  "compactionVersion": "v2",
  "compactionModel": null,
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,

  // Debug & logging
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Disables compaction/replay when `false`. The native-checkpoint safety guard remains active: re-enable before continuing a session that depends on native state. |
| `midRun.enabled` | `boolean` | `false` | Enable the mid-run guard. It may abort a long tool loop once context reaches the configured threshold. |
| `midRun.thresholdPercent` | `number` | `80` | Context usage percentage that triggers the mid-run guard after a tool-bearing turn. Must be greater than 0 and at most 100. |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Protocol for Responses-family APIs. **V2** (streaming, encrypted blob) is the current OpenAI default. **V1** uses the legacy `/responses/compact` endpoint. |
| `compactionModel` | `string \| null` | `null` | Model for fallback compaction (non-Responses APIs, or when native compact fails). Format: `"provider/model-id"`, e.g. `"openai/gpt-5.1-mini"`. `null` = let pi use the current chat model. |
| `compactionThinkingLevel` | `string` | `"off"` | Thinking level for the fallback compaction model. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `responsesCompactApis` | `string[]` | `["openai-responses", "openai-codex-responses"]` | Which Responses APIs use native compaction. Can only narrow the built-in set; unknown entries are ignored with a warning. |
| `allowCompactionContinuityBreak` | `boolean` | `false` | Allow restarting native compaction when the latest session compaction was created by pi's default path (not this extension). Sacrifices opaque-window continuity at that boundary. |
| `notifyOnLoad` | `boolean` | `false` | Show a notification in the TUI when the extension loads. |
| `debug` | `boolean` | `false` | Write lifecycle and compaction-event debug artifacts. |
| `logProviderPayloads` | `boolean` | `false` | Write `before_provider_request` payload artifacts. |
| `logCompactResponses` | `boolean` | `false` | Write compact endpoint request/response artifacts. |
| `redactSensitiveData` | `boolean` | `true` | Redact secrets in debug artifacts. |
| `artifactRoot` | `string` | `"~/.pi/agent/artifacts/pi-better-compaction"` | Root directory for debug artifacts. Supports `~/` and relative paths (resolved against config dir). |

### Example: enable mid-run compaction

```json
{
  "midRun": {
    "enabled": true,
    "thresholdPercent": 80
  }
}
```

### Example: use a cheap model for fallback compaction

```json
{
  "compactionModel": "openai/gpt-5.1-mini",
  "compactionThinkingLevel": "off"
}
```

### Example: force V1 compaction protocol

```json
{
  "compactionVersion": "v1"
}
```

## How it works

With `midRun.enabled`, a completed tool-bearing `turn_end` above the threshold only calls `ctx.abort()`. After Pi emits `agent_settled`, the guard reuses any compaction Pi already completed during abort handling; otherwise it calls `ctx.compact()` exactly once. A successful or coalesced compaction triggers the next turn with a hidden custom message. Failed compaction does not resume, preventing a compact-fail-resume loop.

When pi triggers compaction (`session_before_compact`):

1. **Responses API detected** → run native compaction (V2 or V1 per config):
   - **V2**: streams a request with `compaction_trigger` to `/responses`; the API returns an encrypted compaction blob. Retained user/developer messages + blob form the compacted context.
   - **V1**: POSTs to `/responses/compact`; receives an opaque compacted window.
   - On success, the compacted window is stored and replayed on subsequent requests via `before_provider_request`.

2. **Not a Responses API, or native compact failed** → if no existing native checkpoint is required, and `compactionModel` is configured and differs from the current model, run pi's built-in `compact()` with that model. Otherwise protect the native checkpoint by cancelling.

3. **No fallback configured and no native checkpoint to protect** → pi's default compaction runs as if the extension weren't installed.

Selection is by API type, not provider — any OpenAI-compatible proxy speaking a Responses API gets a native compact attempt. If the endpoint doesn't support it, an initial compaction attempt can fall through to the configured fallback. An existing native checkpoint is never silently replaced by fallback summarization.

### GitHub Copilot Responses models

Keep `compactionVersion: "v2"`. Native requests use Pi's resolved OAuth endpoint and headers, which can differ from the configured model URL (for example, Individual → Enterprise). The same resolved endpoint is part of the persisted checkpoint identity; a checkpoint is not replayed at a different endpoint or with a different provider/model.

Copilot's `compaction_trigger` requires an explicit output ceiling of at least 20,000 tokens. The extension sets that ceiling only for Copilot; it is not a target response size. V2 requests have a two-minute total deadline across retries and honor cancellation. Missing completion, missing compaction output, or output after the blob never persists a partial checkpoint. Text fallback is allowed only when no existing native checkpoint would be lost; otherwise compaction is cancelled. Cancellation never starts fallback.

A small synthetic Astra test verified native generation and factual recovery through reloaded hooks with unsigned and cross-model kept messages, without the original fact-bearing history (which was before Pi's kept boundary); a no-blob control could not recover the fact. This does not establish lossless memory or large-context reliability. Copilot's separate `/responses/compact` endpoint was unavailable; the alternative `context_management` protocol is not enabled by this patch.

### Switching models or recovering a blocked native session

Encrypted checkpoints are not portable across providers, models, or OAuth-resolved endpoints. If replay cannot be verified, the extension aborts and warns rather than silently using the placeholder summary. Restore the checkpoint's provider/model with its original OAuth endpoint and keep the extension enabled. If that is unavailable or replay still fails, use `/tree` to select a branch **before the native compaction**, where the original history is still present, before continuing with another model. Do not delete the checkpoint or disable/unload the extension to bypass the guard.

Two hook phases are required: `context` checks native identity/availability before provider request construction (including unsupported providers such as Gemini); `before_provider_request` verifies exact serialized content and checkpoint replay. A thrown hook error alone does not block Pi's runner. Cancellation is verified with the real runner, Agent, and fake provider transports, not just direct hook assertions.

Custom/grammar/deferred tool contexts that require serializer options not captured by this extension, and missing kept boundaries, are declined before checkpoint creation. Later payload changes are still subject to strict replay validation. Resolved HTTP headers override defaults, including `Authorization: null` and Codex overrides/removals; only `Content-Type: application/json` and the protocol's `Accept` value are mandatory exceptions.

## Debugging

Enable debug artifacts:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

For payload-free V2 diagnostics, `debug: true` is sufficient; leave `logCompactResponses` and `logProviderPayloads` off. The `native-v2-result` event records destination (without query credentials), protocol, status/failure reason, known transport error code, returned item types when available, and blob presence/length, never the blob or auth headers. Raw provider payload logging can contain conversation data and opaque state; do not enable it for sensitive sessions.

Then `/reload`, run `/compact`, send a follow-up message, and inspect:

```
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## Tests

```bash
bun test
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
```

## License

MIT
