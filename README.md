# Pi OMLX Picker

Pi extension that registers an `omlx` provider by fetching the live model list from an OMLX server.

All detected models can be selected with native `/model` list alongside your other providers.

## Install

```
pi install /absolute/path/to/packages/pi-omlx-picker
```

## Configure

Copy `.env-example` to `.env` or export these in your shell:

```
export OMLX_BASE_URL="http://127.0.0.1:8000/v1"
export OMLX_API_KEY="omlx-..."
```

Both are required. If either is missing, the provider is not registered and the footer shows `omlx: set OMLX_BASE_URL` (or `OMLX_API_KEY`).

The UI footer will then display your active connection 
status (e.g. `omlx: 4 models`).

## Commands

- `/omlx` — open a picker and switch to an OMLX model.
- `/omlx-refresh` — re-fetch the model list from the server.
