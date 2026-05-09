# Pi OMLX Picker

Pi extension that discovers models from a local [OMLX](https://github.com/Open-Model-Lookup-Exchange) server and registers them as a native Pi provider. Switch models with Pi's built-in `/model` command.

## Install

```sh
pi install npm:pi-omlx-picker
```

## Configure

Set these env vars (or copy `.env-example` to `.env`):

```sh
export OMLX_BASE_URL="http://127.0.0.1:8008/v1"
export OMLX_API_KEY="omlx-..."
```

If either is missing, the provider is skipped and Pi logs a message on startup.

Optionally override the model metadata path (default: `~/.omlx/model_settings.json`):

```sh
export OMLX_MODEL_SETTINGS_PATH="/path/to/model_settings.json"
```

## How it works

On startup, the extension fetches available models from OMLX, merges local `model_settings.json` metadata, and registers an `omlx` provider in Pi. Thinking controls are applied per-request based on each model's `thinkingDefault`.

## Debugging

```sh
mise run debug:omlx        # OMLX config, model path, template, cache
mise run debug:pi          # Pi install, config, session, log, cache
mise run verify            # Biome + typecheck + unit tests
mise run smoke:omlx        # Live smoke test against a running OMLX server
```

See [docs/DEBUG.md](docs/DEBUG.md) for triage order.
