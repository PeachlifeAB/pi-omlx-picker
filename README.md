# Pi OMLX Picker

Pi extension that discovers models from a local [OMLX](https://github.com/Open-Model-Lookup-Exchange) server and registers them as a native Pi provider. Switch models with Pi's built-in `/model` command.

## Install

```sh
pi install npm:pi-omlx-picker
```

## Configure

Run `/omlx-login` in Pi and paste your OMLX base URL and API key. That's it. Re-run `/omlx-login` to change credentials.

Env-var overrides, model metadata overlay, and stream timeout knobs are documented in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## How it works

On startup, the extension fetches available models from OMLX, merges local `model_settings.json` metadata, and registers an `omlx` provider in Pi. Thinking controls are applied per-request based on each model's `thinkingDefault`.
