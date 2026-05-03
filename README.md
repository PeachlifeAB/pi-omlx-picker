# Pi OMLX Bridge

Pi extension that registers an `omlx` provider from a live OMLX server and maps
OMLX `model_settings.json` metadata into Pi-native model behavior.

The runtime package id is still `pi-omlx-picker` for compatibility with existing
installs, logs, and event names.

Model switching stays native: use Pi's built-in `/model` command. This package
does not ship a second model picker.

## Install

```sh
pi install /absolute/path/to/pi-omlx-picker
```

## Configure

Copy `.env-example` to `.env` or export these in your shell:

```sh
export OMLX_BASE_URL="http://127.0.0.1:8000/v1"
export OMLX_API_KEY="omlx-..."
```

Both are required. If either is missing, the provider is not registered.

By default the bridge reads OMLX settings from:

```text
~/.omlx/model_settings.json
```

Override that path with:

```sh
export OMLX_MODEL_SETTINGS_PATH="/path/to/model_settings.json"
```

## What Gets Mapped

The bridge maps only Pi-supported provider fields into Pi:

- `display_name` -> Pi model `name`
- `max_context_window` -> Pi `contextWindow`
- `max_tokens` -> Pi `maxTokens`
- `model_type_override: "vlm"` -> Pi text+image input capability
- OMLX thinking metadata -> Pi native thinking allowance/level

The provider also tells Pi to send OMLX request limits as `max_tokens`, not
OpenAI's newer `max_completion_tokens`, because OMLX validates the former.

Other OMLX settings remain bridge metadata and are shown in `/omlx-status`.
The durable field reference is [docs/OMLX_MODEL_SETTINGS.md](docs/OMLX_MODEL_SETTINGS.md).

## Command

- `/omlx-status` - silently refreshes the catalog, then shows connection health,
  current session trail, active model mapping, OMLX settings, runtime token
  metrics, task budget state, and recovery diagnostics.

The old `/omlx`, `/omlx-refresh`, and `/omlx-doctor` command surface has been
removed. Use native `/model` for selection and `/omlx-status` for bridge
diagnostics.

## Runtime Behavior

The bridge tracks basic per-model generation speed from request start to
assistant `message_end` when token usage is available. It also supports a
Pi-only optional `task_budget_tokens` field in `model_settings.json`; this is not
an OMLX setting, and is documented separately in the field reference.

Recovery is bounded and Pi-native. The bridge retries protocol-boundary garbage,
thinking-only/empty assistant stops, invalid-tool-call fallout, and short visible
"let me write/edit/run..." stops that promise a tool action but emit no Pi tool
call. Recovery turns set `thinking_budget: 0` and request
`enable_thinking=false`/`preserve_thinking=false`. `/omlx-status` reports when
OMLX `forced_ct_kwargs` blocks the chat-template portion of that override.

The footer stays quiet unless an OMLX model is active or there is an actionable
OMLX error.

## Debugging

Structured logs are written to:

```text
~/.pi/packages/pi-omlx-picker/log/provider-debug.log
```

The bridge emits normalized incomplete-stop facts on Pi's shared event bus:

```text
pi-omlx-picker:incomplete-stop
```

The payload is bounded and contains derived facts only, not raw branch messages
or workflow/task guesses.

`/omlx-status` also summarizes the active Pi session branch: session file/id,
message and token counts, last assistant stop diagnosis, recent stop anomalies,
and recovery-message counts. This is intended to make "agent stopped instead of
writing/editing" failures diagnosable without manually opening the JSONL first.

## Live Smoke

With an OMLX server running:

```sh
mise run smoke:omlx
```

The smoke checks `/models/status`, one reasoning model, one non-thinking model,
and a tool-flow request. Override model selection when needed:

```sh
OMLX_BASE_URL=http://127.0.0.1:8008/v1 \
OMLX_API_KEY=local \
OMLX_REASONING_MODEL=Qwen3.6-27B-MLX-8bit-Ultra \
OMLX_NON_THINKING_MODEL=some-non-thinking-model \
mise run smoke:omlx
```

Each run writes proof to:

```text
./log/smoke-test/<timestamp>.json
```

## Local Qwen3.6 Lane Note

A local Pi/OMLX failure that consumed roughly a day of debugging turned out to
be a template/tool-parser lane issue, not just a thinking-budget issue.

What finally fixed the local `qwen36-haiku` lane:

- copy `$HOME/models/qwen36-opus/chat_template.jinja`
  to `$HOME/models/qwen36-haiku/chat_template.jinja`
- keep haiku on the same XML tool-call template shape as opus for Pi agentic use

Current local proof:

- the two files are byte-identical
- shared SHA-256: `a31e6a4bd67c97172b2ed4f4cdd59313f717db2e7ff5f5b417a2550aaab9eb5b`

Important boundary:

- this is a local OMLX/Qwen runtime note
- do not treat it as a generic guarantee that the bridge alone fixes bad tool-call lanes
- if a sibling lane works and one lane repeatedly stops with thinking-only/no-tool turns,
  inspect the model chat template and runtime parser first
