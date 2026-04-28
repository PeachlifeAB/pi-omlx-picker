# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Commands

- `npm test` — runs `node --import tsx --test 'test/*.test.ts'` (Node's built-in test runner with the tsx loader for `.ts` imports).
- `npm run typecheck` — `tsc --noEmit` against `tsconfig.json`.
- Run a single test file: `node --import tsx --test test/catalog.test.ts`.
- Run a single test by name: `node --import tsx --test --test-name-pattern='parseModelsResponse extracts' test/catalog.test.ts`.
- Install into Pi locally: `pi install /absolute/path/to/pi-omlx-picker` (the extension entry is `./index.ts`, declared in `package.json` under `pi.extensions`).

## Required environment

`OMLX_BASE_URL` (e.g. `http://127.0.0.1:8000/v1`) and `OMLX_API_KEY` are both required. If either is missing, the provider is **not** registered — the footer reports `omlx: set OMLX_BASE_URL` (or `OMLX_API_KEY`). `normalizeBaseUrl` auto-appends `/v1` if absent.

On startup, `index.ts` reads a `.env` file co-located with the extension (resolved via `import.meta.url`) and merges it into `process.env` via `src/dotenv.ts`. Existing process env vars take precedence — the file only fills unset/empty keys. Missing `.env` is non-fatal.

## Architecture

This is a Pi (`@mariozechner/pi-coding-agent`) extension that registers an `omlx` provider by querying an OMLX server's OpenAI-compatible model list. The shape is one orchestrator (`index.ts`) wiring Pi event hooks to a set of small, pure modules in `src/`. Tests in `test/*.test.ts` mirror the `src/` layout and are pure unit tests — there is no fixture server.

### Entrypoint: `index.ts`

The default export receives a Pi `ExtensionAPI` and:

1. Guards against double-loading via a `Symbol.for("pi-omlx-picker/loaded")` global flag.
2. Calls `initialRegister` to load config, fetch the catalog, and register the provider. Failure paths log to stderr and skip registration — the user must run `/omlx-refresh` later.
3. Subscribes to Pi lifecycle events (`session_start`, `input`, `context`, `before_provider_request`, `after_provider_response`, `turn_end`, `tool_call`).
4. Registers slash commands `/omlx` (picker) and `/omlx-refresh` (refetch catalog).

Each event handler **only acts when `ctx.model?.provider === "omlx"`**, so the extension is inert for non-OMLX models.

### Provider registration flow

`src/config.ts` → `src/catalog.ts` → `src/provider.ts`:

- `loadConfig()` reads env, throws `MissingEnvError` (a typed sentinel) when either var is unset.
- `fetchModels()` tries `${apiRoot}/models/status` first (richer metadata: context window, max tokens, thinking default, model type). It falls back to `${apiRoot}/models` (plain OpenAI shape) if `/models/status` errors. `AbortError` is preserved across the fallback.
- `toProviderConfig()` shapes the result into Pi's `ProviderConfig` (api: `openai-completions`, `authHeader: true`). Models with `modelType === "vlm"` get `input: ["text", "image"]`; everything else is text-only. Defaults (`128000` context, `16384` max tokens) come from Pi's documented fallbacks.

### OMLX compatibility layers

OMLX models (especially during `/autoplan` skill execution) regress in three ways: empty completions, preamble-only stubs, and narrated bash without tool calls. Three modules cooperate to defend against this — see `DESIGN.md` for the UX contract.

- **`src/overlay.ts`** — `before_provider_request`: rewrites the latest `<skill name="gstack-autoplan">` user message with a stricter execution contract (`/no_think`, no preamble, no fenced bash, immediate tool call). Idempotent via the marker string `[OMLX compatibility overlay applied by pi-omlx-picker.]`.
- **`src/context.ts`** — `context` event: drops synthetic `omlx-status` messages, then compacts (a) repeated inline skill blobs from earlier failed retries, (b) assistant stubs sandwiched between repeated invocations, (c) oversized inline skill blobs, (d) very large messages once total exceeds `CONTEXT_CHAR_BUDGET`. The most recent `KEEP_RECENT_MESSAGES` are always preserved.
- **`src/recovery.ts`** — `turn_end`: classifies the assistant's turn as `empty` / `stub` / `narration` (only when an `/autoplan` invocation is on the branch and no tool calls/results were produced). `getLatestAutoplanInvocationKey` produces a dedup key so we don't notify twice for the same invocation.

`src/thinking.ts` translates Pi's `ThinkingLevel` into OMLX's `thinking_budget` + `chat_template_kwargs.enable_thinking` and is applied **after** the overlay in `before_provider_request`.

### State machine in `index.ts`

The `State` interface holds: `config`, `catalog`, `registered`, `lastError`, `autoplanRecoveryCount`, `lastAutoplanFailureKey`, `lastToolCallFingerprint`, `repeatedToolCallCount`. It resets on `session_start`. `turn_end` also detects stuck-loop tool calls by hashing `${name}:${JSON.stringify(arguments)}` and warning at 3+ identical repeats.

### Image attachment

The `input` handler scans free text for absolute paths matching `\.(png|jpg|jpeg|webp|gif)`, base64-encodes the file, strips the path from the text, and returns a `transform` action with `images[]` blocks. Errors per-path are logged but never throw — the input is left untouched if every read fails.

### Debug logging

All event handlers emit JSON lines to `~/.pi/packages/pi-omlx-picker/log/provider-debug.log` via `debugLog()`. When `before_provider_request` sees an autoplan skill, it also dumps the full payload to `autoplan-payload-<ts>.json` in the same directory. **Logging is wrapped in `try/catch` and must never throw** — that's a load-bearing invariant of the provider path.

## Testing

- Runner: Node's built-in `node:test` with `tsx` as the import loader. No Jest/Vitest, no transform pipeline.
- Layout: every `src/<module>.ts` has a sibling `test/<module>.test.ts`. Import the unit under test directly with the `.ts` suffix (e.g. `from "../src/dotenv.ts"`).
- Tests are **pure** — no fixture server, no real fs/network. Use plain `assert` from `node:assert/strict`. If a unit needs an env, build a `NodeJS.ProcessEnv` literal and pass it in (see `loadConfig` and `mergeDotenv`).
- When adding a new module, follow TDD: write `test/<name>.test.ts` first, run `node --import tsx --test test/<name>.test.ts` to confirm it fails for the right reason, then add `src/<name>.ts`.
- `npm test` runs all tests; `npm run typecheck` runs `tsc --noEmit`. Both must pass before shipping. CI is not configured — these are the only gates.

## Conventions

- TypeScript ESM, `strict: true`, `allowImportingTsExtensions: true` — imports use the `.ts` suffix (`./src/catalog.ts`).
- All cross-module helpers in `src/*.ts` are pure functions that take and return plain data; side effects (network, fs, Pi UI) live in `index.ts`. Tests exploit this by importing `src/*` directly.
- Pi event payloads are typed loosely (`any` casts in a few places) because the SDK types don't yet cover every event the extension uses — keep the runtime guards (`ctx.model?.provider !== PROVIDER`, `Array.isArray(...)`) in place.
