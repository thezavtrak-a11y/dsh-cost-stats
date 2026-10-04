# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-04

First public release.

### Added

- **Per-turn USD cost in chat.** A chip in the message action row showing what the turn cost, split by
  what each request actually did — `tools` / `reasoning` / `reading and analysis` — priced from the
  provider's own token buckets. A request belongs to exactly one category (every tool it called is a
  read tool → `reading`, no tools at all → `reasoning`, anything else → `tools`), so the shares always
  add up to the total.
- **The "Расход" conversation view tab** (`conversation.view`, `id: cost`, `order: 20`, next to the
  action graph): KPI (cost, requests, average request price, reasoning share, cache hit, tokens/s,
  TTFT, turn wall time), charts (token stack per turn, cost per turn, spend-composition donut, where
  the time goes, context composition), a "what the actions cost" section that reconciles to 100 %, and
  ratings — most expensive turns, tools (calls, time, errors), most expensive requests with model and
  token breakdown, and models with their share of the money.
- **Interactive timeline** — money/requests/tokens per minute and cumulative cost, ranges
  `1 h / 6 h / 24 h / 7 d / all`, wheel zoom around the cursor, drag to pan, double-click or the
  button to reset, automatic or manual bucket width (10 s … 1 h), idle compression (gaps over 20
  minutes take a fixed slice of the axis and are drawn as a hatched band), a window summary line and a
  "re-read logs" button.
- **Session cost summary under the composer** (`conversation.composer.dock`, `id: cost-stats`,
  `order: 10`): whole-session cost in the same three categories and with the same icons as the chip,
  plus, on the right behind a separator so it does not read as a fourth category, what is left on the
  provider account.
- **Host half with two read-only routes** (`index.js`, service `webServer`):
  `GET /cost-stats/series` serves a compact one-row-per-request series over the *whole* durable session
  corpus — `[time, modelIndex, uncachedInput, cacheRead, cacheWrite, output, category]` — read from
  `$DSH_HOME/sessions/**/*.jsonl.zstd` (the v3 and v4 session logs, `session.v3.jsonl.zstd` /
  `session.v4.jsonl.zstd`; each file is a stream of independent zstd frames split on their magic, and
  the envelope is the same for both versions, so one code path reads them). It sends tokens and never
  money, caches a scan for a minute, coalesces concurrent asks and yields to the event loop every four
  files so a multi-second walk cannot stall the agent loop. `GET /cost-stats/balance` asks the
  provider's documented `user/balance` endpoint; the API key is read inside the host process
  (`DEEPSEEK_API_KEY`, else `$DSH_HOME/.credentials.yaml`) and is never part of a response.
- **Honest degradation** — if the series route is absent (older host half, non-web profile) the
  timeline falls back to the loaded conversation window and says so in its source line; if the balance
  route is absent or the provider does not answer, that block is simply not drawn.
- **Locale registration** (`ru`) for the tab label and every visible string, and registration through
  the official slot / locale / session-source registries only — no upstream file is patched.
- **Host-side local models are priced at $0** instead of falling through to the paid fallback row: a
  local model is genuinely free, an unpriced cloud model is an unknown.
- **Verification tooling**: `tools/smoke.mjs` (105 headless checks), `tools/series-check.mjs` (the host
  scan plus the wire contract the browser half relies on), `tools/balance-check.mjs`,
  `tools/audit-usage.mjs` (an independent re-read of the durable logs), `tools/verify-billing.mjs`
  (reconciles a provider `usage_data_*.zip` export against the logs and prints a ready `PRICES` row)
  and `tools/audit-public.mjs` (the pre-publish gate).

### Fixed

- **DSH 0.2.0: the plugin half-registered itself silently.** `conversation.chat.turnTail` is a *list*
  slot in 0.2.0, not a chain slot, so it requires `id` and its owner props carry the turn location
  directly (`props.turn`, not a selector result in `props.matched`). The old registration without `id`
  threw `list slot "conversation.chat.turnTail" requires options.id`, and that exception was swallowed
  by the `try/catch` inside `apply()` — so everything registered after it, including the whole
  "Расход" tab, never appeared. The chip now also reads TTFT and tokens/s from the ledger, because
  0.2.0's `turn-tail` no longer carries `ttftMs` / `tokensPerSecond`.
- **A duplicated chip.** Both seats rendered for one turn. The chain seat now declines any turn whose
  tail carries a closing message — i.e. every ordinary turn — so exactly one chip remains, in the
  message action row.
- **The chip no longer collides with the rest of the row.** It is drawn in the row's own style (no
  frame, no background, 13 px, tertiary label colour) at the right edge (`order: 99` + `marginLeft:
  auto`, `flexShrink: 0`, because the row does not wrap), and its categories are labelled with icons
  from the shell's own set — with a letter fallback, since an unknown icon name is `undefined` and
  React rejects that as an element type.
- **The session summary disappeared after a page reload.** `useProjection` sat below an early
  `return null`, so the hook count changed between the first render and the render that had data, and
  React drops such a component. Every hook now runs before any early exit, and the smoke test counts
  hooks per component in every data state so this cannot come back.
- **The "Расход" tab opened scrolled to the bottom.** The host keeps a single `viewArea` for all
  conversation tabs, so the container inherits the previous tab's scroll; `CostView` now zeroes its own
  scroll and that of its scrollable ancestors in a layout effect, before paint.
- **Timeline arithmetic.** The average rate divided by the whole window instead of one bucket (it came
  out larger than the peak), and a request landing exactly on the right edge fell "outside the window".
  Both were found on a live screenshot, not by the tests, and both now have assertions.
- **The cost panel fell under the chat's stacking contexts.** Each message row is its own stacking
  context, so an absolutely positioned panel inside the action row is painted below the next rows and
  the composer no matter the `z-index`. The panel is now a portal into `document.body` with
  `position: fixed` and a viewport-bounded width, and it closes on `Esc`, an outside click, scroll or
  resize.
- **The `deepseek-v4-pro` tariff was wrong by roughly a factor of four.** The provider's own billing
  export (`usage_data_<day>.zip`, `amount-*.csv` carrying both tokens and the price per token) showed
  the cache-read price was not zero but 0.044 $/M, and that the miss/output rates are above the
  published ones. The three rates now in `PRICES` (`1.32 / 0.044 / 3.96` $/M) reproduce the exported
  bill to the cent, while the token sums had been right all along — with the last two requests of the
  window excluded, the logs match the export token for token. Only `deepseek-v4-pro` is calibrated;
  the flash family still carries the published rates.
- **Money format**: leading zero restored (`$0.2352`), trailing zeros still trimmed
  (`$0.0010` → `$0.001`).
