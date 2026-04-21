# Design System — pi-omlx-picker

## Product Context
- **What this is:** A Pi extension that makes OMLX-backed models feel native inside `pi-mono`, especially during agentic coding flows and gstack skill execution.
- **Who it's for:** The Pi and broader AI builder community, especially terminal-first power users who want local control without losing polish.
- **Space/industry:** Developer tools, terminal UX, coding agents.
- **Project type:** Terminal extension, provider integration, lightweight but high-signal developer UX.

## Aesthetic Direction
- **Direction:** Native Terminal Precision
- **Decoration level:** Minimal
- **Mood:** Calm, exact, trustworthy under failure. It should feel lighter than Claude Code, cleaner than most AI CLIs, and as unsurprising as Pi’s built-in providers.
- **Reference posture:** Claude Code and Codex CLI for seriousness, Pi native providers for integration feel, but stripped down for minimalists.

## User Experience Principles
- **No silent failure:** If OMLX completed but produced unusable output, say so plainly in-band.
- **One truth at a time:** The UI should explain the current state, not narrate internals.
- **Invalid output is not progress:** Preamble parroting, fenced bash with no tool calls, and empty completions are failure states, not assistant progress.
- **Automatic first, explicit second:** Try the obvious recovery once, then surface a crisp next action.
- **Provider-specific behavior, native presentation:** OMLX may need compatibility overlays, but the user experience should still feel like normal Pi.

## Terminal UX Contract
- **Healthy request:** user prompt → spinner → assistant tool call or real text output.
- **Compacted request:** show a low-noise status hint that context was compacted for OMLX compatibility.
- **Invalid first turn:** replace bogus assistant progress with a short system-style explanation:
  - `OMLX returned non-executable autoplan output. Retrying with compatibility overlay.`
- **Invalid retry:** surface a hard, legible stop:
  - `OMLX completed the request but returned no usable output for /autoplan.`
- **Recommended next actions:** always attach one immediate path:
  - retry once more with stronger overlay
  - switch model
  - inspect provider log path
  - continue without `/autoplan`

## Status Language
- **Ready:** `OMLX ready`
- **Compaction:** `OMLX compacted context`
- **Recovery:** `OMLX recovering invalid autoplan output`
- **Hard failure:** `OMLX model returned empty completion`

All status copy should be one line, sentence case, no hype, no apology.

## Typography
- **Display/Hero:** Inherit terminal font. Do not introduce a branded display face inside Pi.
- **Body:** Inherit terminal font. The design work is hierarchy and wording, not font override.
- **UI/Labels:** Terminal font with disciplined capitalization and spacing.
- **Data/Tables:** Monospace with clear alignment. Prefer tabular presentation for logs, counts, and state.
- **Code:** Terminal monospace, inherited.
- **Scale:** Three visual levels only:
  - primary message
  - secondary status/help text
  - de-emphasized diagnostics

## Color
- **Approach:** Restrained
- **Primary:** `#6FC7D8` steel-cyan, for active OMLX state and compatibility hints
- **Secondary:** `#9FB3C8` cool slate-blue, for neutral provider metadata
- **Neutrals:** `#E8ECEF` text, `#B6BEC7` muted text, `#1B1F24` background, `#111417` deeper surface
- **Semantic:** success `#6FB98F`, warning `#D8A657`, error `#C96B6B`, info `#6FC7D8`
- **Dark mode:** Default posture. Keep saturation disciplined. Error red should feel surgical, not loud.

## Spacing
- **Base unit:** 1 terminal row / 2-space horizontal rhythm
- **Density:** Compact
- **Scale:** tight inline state, single blank line before major state change, no stacked padding blocks

## Layout
- **Approach:** Grid-disciplined
- **Grid:** Single column conversation flow, with optional one-line status/footer augmentation
- **Max content width:** Match Pi conversation width. Do not create wide pseudo-panels inside the transcript.
- **Border radius:** None in terminal surfaces. If a widget is rendered, keep geometry square and structural.

## Motion
- **Approach:** Minimal-functional
- **Easing:** N/A in terminal context
- **Duration:** Use existing Pi spinner/progress behavior only. No decorative animation.

## Implementation Guidance
- Classify these as invalid assistant turns during inline gstack execution on OMLX:
  - empty completion
  - preamble-only completion
  - fenced bash narration without tool calls
- Prefer pre-request compatibility overlays over post-hoc repair when a skill prompt is known to be problematic.
- Use footer or status widgets for background provider state, not chat spam.
- If a recovery message is injected, it should read like a system intervention, not like another user typing blindly.
- Never leave the transcript ending in an empty assistant turn with no explanation.

## UX Review Findings
- The current broken path damages trust more than it damages throughput.
- A narrated preamble looks like progress but is actually model failure. That is the worst possible ambiguity.
- Empty completions must be rendered as explicit provider failures, not absence.
- The extension should optimize for legibility under failure, because that is where “native feel” is won or lost.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-20 | Adopted `Native Terminal Precision` as the design direction | The extension should feel like Pi’s built-in providers, not like a custom experiment. |
| 2026-04-20 | Prioritized failure legibility over decorative UX | Silent or fake-progress failures are the main trust break in the current OMLX path. |
| 2026-04-20 | Kept typography inherited from the terminal | In Pi, hierarchy and wording matter more than custom font identity. |
