# Pi OMLX Bridge

Pi extension that discovers models from a live OMLX server and registers them
as a native Pi provider. Model switching uses Pi's built-in `/model` command.

The runtime package id is `pi-omlx-picker` for compatibility with existing installs.

## Install

```sh
pi install /absolute/path/to/pi-omlx-picker
```

## Configure

Copy `.env-example` to `.env` or export in your shell:

```sh
export OMLX_BASE_URL="http://127.0.0.1:8008/v1"
export OMLX_API_KEY="omlx-..."
```

Both are required. If either is missing, the provider is not registered and Pi logs a message on startup.

By default the bridge reads OMLX metadata from:

```text
~/.omlx/model_settings.json
```

Override with:

```sh
export OMLX_MODEL_SETTINGS_PATH="/path/to/model_settings.json"
```

## What it does

On startup, the bridge:

1. Loads config from env
2. Fetches models from `OMLX_BASE_URL/models/status` (falls back to `/models`)
3. Merges local `model_settings.json` metadata
4. Registers an `omlx` provider with Pi

On each request to an OMLX model, it applies thinking controls: if the model's
`thinkingDefault` is `true` and Pi's thinking level is not `off`, thinking passes
through unchanged. Otherwise it sets `thinking_budget: 0` and `enable_thinking: false`.

## What gets mapped into Pi

- `display_name` → Pi model `name`
- `max_context_window` → Pi `contextWindow`
- `max_tokens` → Pi `maxTokens`
- `thinking_default: true` → Pi `reasoning: true`
- `model_type: vlm` → Pi text+image input capability

The field reference is [references/OMLX_MODEL_SETTINGS.md](references/OMLX_MODEL_SETTINGS.md).

## Live Smoke

With an OMLX server running:

```sh
mise run smoke:omlx
```

Checks `/models/status`, one reasoning model, one non-thinking model, and a tool-flow
request. Override model selection:

```sh
OMLX_REASONING_MODEL=Qwen3.6-27B-MLX-8bit-Ultra mise run smoke:omlx
```

Each run writes proof to `./log/smoke-test/<timestamp>.json`.

## Debugging

```sh
mise run debug:omlx        # OMLX config, model path, template, cache
mise run debug:pi          # Pi install, config, session, log, cache
mise run verify            # Biome + typecheck + unit tests
mise run verify:live       # verify + live smoke
```

See [docs/DEBUG.md](docs/DEBUG.md) for triage order.
