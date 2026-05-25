# Configuration

The normal path is Pi's built-in `/login` flow: choose **API key**, choose **OMLX**, enter the API key, then select an OMLX model with `/model`. The rest of this page documents the base URL override, the optional model metadata overlay, and the stream timeout knob.

## Where credentials live

`/login` writes the API key to `~/.pi/agent/auth.json` under the `omlx` provider key — the same file Pi uses for native providers. Use Pi's built-in `/logout` to remove stored OMLX credentials.

`pi uninstall pi-omlx-picker` does not touch `auth.json`. Reinstall picks up where you left off; use `/logout` or delete the `omlx` entry yourself to scrub.

## Environment variable overrides

Use `OMLX_BASE_URL` when your OMLX server is not at the default URL:

```sh
export OMLX_BASE_URL="http://127.0.0.1:8000/v1"
```

The default base URL is `http://127.0.0.1:8000/v1`.

`OMLX_API_KEY` can also override the stored `/login` key for CI, ephemeral shells, or per-project overrides:

```sh
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
