# Configuration

`/omlx-login` is the normal path. The rest is here for env-var overrides, the optional model metadata overlay, and the stream timeout knob.

## Where credentials live

`/omlx-login` writes to `~/.pi/agent/auth.json` under the `omlx` provider key — the same file Pi uses for native providers. To remove credentials, delete the `omlx` entry there (or unset `OMLX_BASE_URL`/`OMLX_API_KEY` if you're using env vars).

`pi uninstall pi-omlx-picker` does not touch `auth.json`. Reinstall picks up where you left off; delete the `omlx` entry yourself to scrub.

## Environment variable overrides

If `OMLX_BASE_URL` and `OMLX_API_KEY` are set in the shell, they take precedence over stored credentials. Useful for CI, ephemeral shells, or per-project overrides:

```sh
export OMLX_BASE_URL="http://127.0.0.1:8000/v1"
export OMLX_API_KEY="omlx-..."
```

## Model metadata overlay

OMLX's API doesn't return display names, context-window hints, or default thinking budgets. Supply them via a local JSON file and the extension merges them into the catalog before registering the provider.

- Default path: `~/.omlx/model_settings.json`
- Override: `OMLX_MODEL_SETTINGS_PATH=/some/other/path.json`

Optional. Omit to use whatever OMLX returns.

Per-model schema:

```json
{
  "models": {
    "qwen3.6-coder-32b": {
      "display_name": "Qwen3.6 Coder 32B",
      "description": "...",
      "max_tokens": 16000,
      "thinking_budget_enabled": true,
      "thinking_budget_tokens": 8000,
      "chat_template_kwargs": { "enable_thinking": true }
    }
  }
}
```

## Stream timeout

`OMLX_STREAM_FIRST_DELTA_TIMEOUT_MS` (default `120000`) controls how long the stream wrapper waits for the first meaningful body event (text delta, thinking delta, tool-call start, done, or error) after response headers arrive. On timeout the request aborts, retries once, and on the second failure emits an assistant error.

Each timeout writes a `stream_first_delta_timeout` line to the provider debug log with `model`, `timeoutMs`, `attempt`, `maxAttempts`, and `final`.
