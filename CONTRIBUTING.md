# Contributing

Local development for `pi-omlx-picker`. User config: [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## Setup

```sh
npm install
mise run verify
```

A live OMLX server is needed for `mise run smoke:omlx` and `mise run verify:live`.

## Tasks

Run via [`mise`](https://mise.jdx.dev/):

- `mise run verify` — Biome, TypeScript type checking, unit tests.
- `mise run smoke:omlx` — live OMLX probe: reasoning model, non-thinking model, tool-flow request.
- `mise run verify:live` — typecheck, unit tests, and live smoke (skips Biome; run `mise run verify` first if you want lint coverage).
- `mise run debug:omlx` — OMLX config, model path, template, log, and cache diagnostics. Pass model names after `--` to narrow, e.g. `mise run debug:omlx -- opus sonnet`.
- `mise run debug:pi` — Pi install, config, session, log, and cache diagnostics. Pass `install`, `config`, `sessions`, `logs`, or `cache` after `--`.
- `mise run debug:pi -- timeline <session-id|session-file|iso-time>` — Pi provider + OMLX server + changed-files window around a stuck turn. Use `--minutes=N` to set the window (default 3).

## Triage order

1. Read the latest provider events in `log/provider-debug.log` (or `~/.pi/packages/pi-omlx-picker/log/provider-debug.log` when installed via Pi). Look for `stream_first_delta_timeout`, `assistant_stop_diagnosis`, and the most recent `before_provider_request` / `after_provider_response` pair. The latest `mise run smoke:omlx` proof lives in `log/smoke-test/<iso-timestamp>.json`.
2. Inspect Pi host state: `mise run debug:pi`.
3. Inspect OMLX config and model files: `mise run debug:omlx`.
4. Run live smoke: `mise run smoke:omlx`.
5. Check upstream OMLX repo releases and issues before writing local workarounds.
6. Only then change code.

Most fixes are upstream (OMLX `model_settings.json`, `chat_template.jinja`), not in Pi-side code. New-session-OK plus takeover-broken means session state, not model capacity.

## Failure families

```text
symptom
  ├─ package didn't load, wrong install, stale session, compaction, takeover
  │   └─ mise run debug:pi
  ├─ model alias, model settings, template, rope config, OMLX/HF cache
  │   └─ mise run debug:omlx
  ├─ live model request behavior
  │   └─ mise run smoke:omlx
  ├─ new session good, takeover bad
  │   └─ mise run debug:pi -- sessions, then compare model_settings.json and chat_template.jinja
  ├─ local checks pass but live smoke fails
  │   └─ check upstream OMLX repo, releases, and issues
  └─ model not appearing in Pi /model list
      └─ check OMLX_BASE_URL is reachable, then mise run debug:omlx
```
