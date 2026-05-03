# pi-omlx-picker Design

## Purpose

`pi-omlx-picker` is now an OMLX metadata bridge for Pi. It registers an `omlx`
provider, projects validated OMLX model settings into Pi's native model system,
and keeps diagnostics available through one visible command: `/omlx-status`.

It owns:

- OMLX model discovery from `/v1/models/status` with `/v1/models` fallback
- local `model_settings.json` overlay from OMLX's documented `ModelSettings`
- Pi provider config mapping for fields Pi actually supports
- native Pi thinking-level selection from OMLX thinking metadata
- OMLX/Pi request shaping and bounded provider-defect recovery
- per-model runtime metrics and optional Pi bridge task budget tracking
- structured debug logs, footer status, and `/omlx-status`

It does not own:

- model switching UI; native Pi `/model` owns selection
- unsupported provider fields in Pi
- task completion policy or workflow semantics
- OMLX server-side settings management

## Source Boundaries

OMLX documented settings are listed in
[docs/OMLX_MODEL_SETTINGS.md](docs/OMLX_MODEL_SETTINGS.md). That document is
validated against the OMLX source and separates true OMLX fields from bridge-only
fields such as `task_budget_tokens`.

Pi provider model support was checked in `references/pi-mono`:

- `ProviderModelConfig` supports `id`, `name`, `api`, `reasoning`, `input`,
  `cost`, `contextWindow`, `maxTokens`, `headers`, and `compat`.
- Pi extensions can call `getThinkingLevel()` and `setThinkingLevel()`.
- Pi's OpenAI completions compat owns the actual thinking budget and
  `qwen-chat-template` request shaping.

## Data Flow

```text
OMLX /v1/models/status or /v1/models
  -> parse catalog
  -> apply ~/.omlx/model_settings.json overlay
  -> derive OmlxModel bridge metadata
  -> register Pi provider "omlx"
  -> native /model lists OMLX models
```

Only supported fields are copied into Pi provider config:

- `display_name` -> `name`
- OMLX id -> `id`
- `enable_thinking` / `chat_template_kwargs.enable_thinking` -> `reasoning`
- `model_type_override: "vlm"` -> `input: ["text", "image"]`
- `max_context_window` -> `contextWindow`
- `max_tokens` -> `maxTokens`

The provider sets Pi's OpenAI-compatible `compat.maxTokensField` to
`max_tokens`, matching OMLX `ChatCompletionRequest`. This keeps Pi's model
output budget visible to OMLX even when a model has no local `max_tokens`
setting.

Everything else stays in extension state for `/omlx-status`, diagnostics, or
bridge-owned runtime behavior.

## Native Thinking

Pi owns thinking levels and computed budgets. The bridge only chooses the native
Pi level that best matches OMLX settings:

1. `enable_thinking: false` or `chat_template_kwargs.enable_thinking: false` -> `off`
2. `thinking_budget_tokens: 0` -> `off`
3. `chat_template_kwargs.reasoning_effort` matching a Pi level -> that level
4. positive `thinking_budget_tokens` -> nearest Pi default budget level
5. `enable_thinking: true` -> `medium`
6. `thinking_budget_enabled: true` -> `medium`

The bridge applies this on `session_start`, `model_select`, and `/omlx-status`.
It does not invent non-Pi levels such as `max` or `ultra`.

## Runtime Hooks

```text
session_start
  -> reset recovery counters, active request, task budget
  -> apply OMLX-derived Pi thinking level if active model is OMLX

model_select
  -> reset active request and task budget
  -> apply OMLX-derived Pi thinking level
  -> update footer only for active OMLX or actionable error

context
  -> remove visible /omlx-status messages from provider context
  -> compact pathological inline skill history
  -> remove protocol-only assistant garbage
  -> truncate tool results using max_tool_result_tokens when configured

before_provider_request
  -> apply compatibility overlay
  -> preserve Pi-owned thinking policy for capable models
  -> disable OMLX thinking explicitly for incapable/off models
  -> disable OMLX thinking and thinking preservation on recovery turns
  -> record request start for tokens/sec

message_end
  -> extract output tokens from usage variants
  -> record last sample and rolling last 5 samples
  -> accumulate optional task budget usage
  -> inject hidden 20% and 5% task-budget steers when configured

turn_end
  -> bounded recovery for boundary garbage, invalid tool calls, empty stops,
     thinking-only stops, and visible tool-intent stops
  -> emit pi-omlx-picker:incomplete-stop facts
```

## Command UX

Public command surface:

- `/omlx-status`

Removed public commands:

- `/omlx`
- `/omlx-refresh`
- `/omlx-doctor`

`/omlx-status` silently refreshes the catalog before rendering. If refresh fails,
it renders the last known catalog plus the error.

Status sections:

- Connection: API root, provider registration, model count, settings path,
  last refresh, last error
- Session: session file/id/leaf, message and token counts, last assistant stop
  diagnosis, and recent anomalies
- Active model: display name, raw id, alias, description, text/image capability
- Pi mapping: provider name, reasoning enabled, current Pi thinking level,
  OMLX-derived thinking source, thinking format, context window, max tokens
- OMLX settings: identity, thinking, limits, sampling, DFlash, SpecPrefill,
  TurboQuant, lifecycle, and bridge task budget
- Runtime: last tokens/sec, rolling tokens/sec, output tokens, task budget, and
  last assistant stop token ratios against `max_tokens`/`max_context_window`
- Recovery: boundary garbage, empty/actionless stop, tool validation, visible
  tool intent, recovery thinking override availability, session recovery
  counts, debug log path

## Recovery Contract

The bridge keeps recovery generic and bounded:

- boundary protocol garbage after tool results: retry once
- empty or thinking-only assistant stop when tools are available: retry once
- visible tool-intent stop such as "let me write/edit/run..." with no Pi tool
  call: retry twice
- Pi tool-validation failure followed by an empty/tool-less stop: retry up to the configured bound
- repeated identical tool calls: warn through the UI

Recovery turns are delivered as hidden Pi steer messages. For OMLX models, the
bridge sends `thinking_budget=0` and overrides
`chat_template_kwargs.enable_thinking=false` and `preserve_thinking=false` on
those retry requests. OMLX `forced_ct_kwargs` can block the chat-template keys,
so `/omlx-status` and debug logs surface that explicitly; `thinking_budget=0`
remains a request-level budget override in OMLX source.

It publishes normalized facts on the Pi event bus as
`pi-omlx-picker:incomplete-stop`. Facts are bounded and exclude raw branch
messages.

## Files

| File | Responsibility |
| --- | --- |
| `index.ts` | Extension lifecycle, commands, hooks, footer, status refresh |
| `src/catalog.ts` | OMLX catalog parsing and local settings projection |
| `src/provider.ts` | `OmlxModel` -> Pi provider config |
| `src/native-thinking.ts` | OMLX metadata -> native Pi thinking level |
| `src/thinking.ts` | OMLX request disablement when thinking is not allowed |
| `src/status.ts` | `/omlx-status` rendering |
| `src/session-diagnostics.ts` | active Pi session trail and stop diagnostics |
| `src/performance.ts` | output-token extraction and tokens/sec samples |
| `src/task-budget.ts` | optional Pi bridge task budget tracking |
| `src/context.ts` | context cleanup, skill compaction, tool-result truncation |
| `src/overlay.ts` | provider-neutral agent contract overlay |
| `src/recovery.ts` | incomplete-stop facts and recovery classifiers |
| `src/recovery-readiness.ts` | recovery override capability derived from forced chat-template keys |
| `src/boundary-garbage.ts` | protocol-only garbage detection |
| `src/config.ts` | OMLX env config loading and URL normalization |
| `scripts/smoke-live-omlx.ts` | live OMLX smoke validation |

## Observability

Logs are newline-delimited JSON at:

```text
~/.pi/packages/pi-omlx-picker/log/provider-debug.log
```

Important log kinds include catalog refresh, local settings projection,
native-thinking application, context compaction, provider request summaries,
assistant stop diagnosis, performance samples, task-budget warnings, and
recovery decisions.
