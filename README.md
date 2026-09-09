# pi-better-compaction

English | [中文](README.zh-CN.md)

A [pi](https://github.com/nicepkg/pi) extension that upgrades context compaction with two coordinated strategies:

1. **OpenAI Responses APIs** use the provider's native compaction endpoint, preserving opaque context that plain text summaries lose.
2. **All other APIs** (Anthropic, Gemini, etc.) can run pi's built-in compaction with a **dedicated cheaper/faster model**, so summarization doesn't consume quota on your primary model.

Everything fails open — if any step cannot proceed, pi's default compaction takes over.

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

- **pi** ≥ 0.84.3 (`@earendil-works/pi-coding-agent >= 0.84.3`)

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
| `enabled` | `boolean` | `true` | Master switch. Set `false` to disable the extension entirely. |
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

When pi triggers compaction (`session_before_compact`):

1. **Responses API detected** → run native compaction (V2 or V1 per config):
   - **V2**: streams a request with `compaction_trigger` to `/responses`; the API returns an encrypted compaction blob. Retained user/developer messages + blob form the compacted context.
   - **V1**: POSTs to `/responses/compact`; receives an opaque compacted window.
   - On success, the compacted window is stored and replayed on subsequent requests via `before_provider_request`.

2. **Not a Responses API, or native compact failed** → if `compactionModel` is configured and differs from the current model, run pi's built-in `compact()` with that model.

3. **No fallback configured** → pi's default compaction runs as if the extension weren't installed.

Selection is by API type, not provider — any OpenAI-compatible proxy speaking a Responses API gets a native compact attempt. If the endpoint doesn't support it, the request fails and falls through to the configured fallback.

## Debugging

Enable debug artifacts:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

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
