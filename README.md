# dsh-cost-stats

What a conversation actually costs, in dollars, as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
client plugin: a **per-turn cost chip in the chat** and a **"Расход" conversation view tab** with
charts, ratings and a long-range timeline, sitting next to the action graph.

DSH hands out tokens and never money, so the plugin prices the provider's own token buckets with a
local tariff table and shows the result where you are already looking: under the message, under the
composer, and on its own tab. Nothing upstream is patched — the plugin registers into the official
slot, locale, conversation-target and session-source registries, so it survives DSH upgrades and
uninstalls by removing one row.

## What you get

- **Cost in chat.** Every turn that can be priced gets a chip in the message action row, drawn in the
  row's own style at its right edge, next to the shipped "Использовано N ток" — the total plus a split
  by what the requests did (the glyphs here stand in for icons taken from the shell's own set):
  `$0.7741  ⚙$0.6863  🧠$0.0202`. Categories are labelled with those icons (a letter if one is
  missing), the full names stay in the tooltip and in the panel that opens on click:
  per-action breakdown (requests / tokens / $), the token-bucket table (uncached input, cache read,
  cache write, output, of which reasoning), model, turn number, turn wall time, TTFT and tokens/s.
  A turn the engine could not prove exactly is rebuilt from its own requests and marked `≈`.
- **The "Расход" tab** (`order: 20`, after the trajectory graph):
  - KPI — cost of the loaded turns, whole-session cost, request count and average request price,
    reasoning tokens and their share of the output, cache hit rate, tokens/s, TTFT, turn wall time.
  - Charts — token stack per turn (four segments), cost per turn, a spend-composition donut, where the
    time goes, and context composition.
  - **What the actions cost** — the three categories with requests, tokens, cost and share; the shares
    reconcile to 100 %.
  - Ratings — most expensive turns, tools (calls, time, errors), most expensive requests with model
    and token breakdown, and models with their share of the money.
  - The **tariff table** every number on the tab comes from.
- **An interactive timeline** — `$ per minute`, `requests per minute`, `tokens per minute` and
  `cumulative cost`. Ranges `1 h / 6 h / 24 h / 7 d / all`; wheel to zoom around the cursor, drag to
  pan, double-click or the button to reset; bucket width `auto` (about 160 columns, from 1 s to 1 day)
  or `10 s / 1 min / 15 min / 1 h`; rates stay per minute at any width. **Idle compression** is on by
  default: a pause longer than 20 minutes takes a fixed slice of the axis instead of its real length
  and is drawn as a hatched band, so a night between sessions does not flatten the day. The window line
  reports range, step, requests, cost, average rate, peak, idle stretches, requests outside the window
  and **where the data came from**.
- **Session cost under the composer** — the same three categories and icons at session scale, plus the
  remaining provider account balance behind a separator:
  `$0.2352   ⚙$0.2123   🧠$0.0036   👁$0.0194   │ На счёте $20.35`.
- **Honest degradation.** No host route (older host half, non-web profile) → the timeline falls back to
  the loaded conversation window and says so in its source line. No balance route or no provider answer
  → that block is simply not drawn. A turn whose cost is genuinely unknown → no chip at all, rather
  than a zero.

## Install

The package declares `dsh.client` (browser half) and `dsh.bundle.patch` (loader row), so it installs
like any other DSH plugin:

```sh
# from a checkout, or from a published copy
dsh plugin --profile <profile> add <checkout>
# after that, reload the page once: a NEW loader row is picked up when the page's module table is built
```

Mounting it by hand into a profile, which is what this repository was developed against:

```powershell
# 1. live link, so edits to the browser half are hot-swapped without reinstalling
New-Item -ItemType Junction -Path "$DSH_HOME\profiles\<profile>\node_modules\dsh-cost-stats" `
         -Target (Resolve-Path .).Path

# 2. dependency of the profile:  $DSH_HOME/profiles/<profile>/package.json
#    "dsh-cost-stats": "file:<absolute path to this checkout>"

# 3. loader row:  $DSH_HOME/profiles/<profile>/cordis.patch.yml
#    - insert:
#        - id: cost-stats
#          name: dsh-cost-stats
```

The row is mounted from the **profile patch layer**, deliberately not from `dsh.profile.bundles`:
only the patch layer is re-read on a live server, so the row is picked up without restarting the GUI
(the browser half then appears after one page reload; the host half's routes are registered at boot, so
a restart is what makes `/cost-stats/series` and `/cost-stats/balance` answer). Rollback = drop the
insert row, the dependency and the junction, then reload the page.

`DSH_HOME` is the plugin's own convention, not a wrapper script's: the host half resolves its session
logs from `$DSH_HOME`, falling back to `~/.dsh`, exactly like DSH does.

[NOTES.md](NOTES.md) collects what building this plugin taught about the client-plugin surface —
package shape, the module loader, slots, the conversation targets, and three traps that each cost a
debugging round.

## How it works

| File | Role |
|---|---|
| `index.js` | Host half: mounts as a package and serves two read-only routes — the long-range series and the account balance |
| `lib/client.js` | The whole feature: tariff table, the fold over the conversation targets, the chip, the session summary, the tab, the timeline, the dictionaries |
| `cordis.patch.yml` | The loader row a bundle install applies |
| `tools/*.mjs` | Headless checks and audits; nothing here is loaded by the plugin |

**Where the numbers come from.** The host half of DSH exposes conversation targets and projections;
the plugin folds them, memoized by snapshot identity, into a stable `useSyncExternalStore` source:

| What | Where it comes from |
|---|---|
| Exact per-turn accounting | `chat` target → `turn-tail` nodes (`data.tokenUsage`) |
| Exact per-request usage + model | `trajectory` target → `snapshot.requests[].usage` + `requestConfig` / `provenance` |
| Per-request fallback | `chat` target → `assistant-step` nodes (`data.usage`) |
| Tools | `chat` target → `tool-call` nodes (`data.root`, recursively through `subCalls`) |
| Session timings, tokens, context | host projections `sessionStats`, `tokenUsage`, `contextBreakdown` |
| Turns without exact accounting | rebuilt from their own requests, marked `≈` |

**Attribution.** Each model request belongs to exactly one category by what it was doing: it called at
least one tool that is not a read tool → `tools`; it called no tool at all → `reasoning`; every tool it
called is in `READ_TOOLS` → `reading and analysis`. MCP names are normalized, so
`mcp__windows-mcp__Snapshot` counts as `snapshot`. A request's whole price goes to one category, which
is why the shares always sum to the total — asserted by the smoke test.

**Two seats, mutually exclusive.** The chip is registered in the list slot
`conversation.chat.assistant-actions` (`id: cost-stats`), which is the reliable seat because the list
renders for every completed turn. A second registration in the chain slot
`conversation.chat.turnTail` covers the turns that have no action row at all — it declines any turn
whose tail carries a closing message, i.e. every ordinary turn. Both seats rendering for one turn was
a real bug: the chain stops at its **first** accepting selector, and the shipped deliverables selector
claims every turn that touched a file, so a chain-only registration would have hidden the chip on
exactly the writing turns.

**Long range.** The browser only ever sees the conversation window it has paged in; the durable logs on
disk hold days. The host half walks `$DSH_HOME/sessions/**/*.jsonl.zstd` and serves a compact series:

```
GET /cost-stats/series
{ v: 1, generatedAt, sessions, records, models: [...], categories: {...},
  rows: [[timeMs, modelIndex, miss, hit, write, out, category], ...] }
```

Each log file is a stream of independent zstd frames and is split on their magic, the v3 and v4
envelopes are read by the same code path, and the route answers **tokens, never money** — pricing stays
in the browser. A scan is cached for a minute, concurrent asks share one scan, the walk is capped and it
yields to the event loop every four files, because it runs inside the same process as the agent loop.
`GET /cost-stats/balance` asks the provider's documented `user/balance` endpoint; the credential is read
inside the host process (environment, then `$DSH_HOME/.credentials.yaml`) and never becomes part of a
response. The browser polls it every 5 minutes.

**Pricing.** `PRICES` at the top of `lib/client.js` holds USD per million tokens per model
(`miss` / `hit` / `write` / `out`); a cache write is billed as a miss, hence `write: miss`. Models that
run on this machine (LM Studio / Bionic) are priced at $0 instead of inheriting the paid fallback: a
local model is genuinely free, an unpriced cloud model is an unknown. The `deepseek-v4-pro` row is
calibrated against the provider's own billing export — see [Verify it yourself](#verify-it-yourself).

**Four decisions worth keeping when editing:**

1. **Hooks first, exits last.** Every hook in a component runs before any early return. A
   `useProjection` call placed after a `return null` changed the hook count between renders, React
   discarded the component, and the session summary vanished after a reload while looking fine under
   HMR. The smoke test counts hooks per component in every data state and fails on a mismatch.
2. **The tab resets its own scroll.** The host keeps a single `viewArea` for all conversation tabs, so
   the container inherits the previous tab's scroll and the report opened at its own bottom. `CostView`
   zeroes its scroll and that of its scrollable ancestors in a layout effect, before paint.
3. **The detail panel is a portal.** Each message row is its own stacking context, so an absolutely
   positioned panel inside the action row is painted below the following rows and the composer no
   matter the `z-index`. It is a `createPortal` into `document.body` with `position: fixed`, a
   viewport-bounded width and a very high `z-index`, and it closes on `Esc`, an outside click, scroll or
   resize. Without a DOM (as in the smoke test) it degrades to rendering its children in place.
4. **The timeline axis is slot weights.** A normal slot is 1 and an idle stretch is a fixed share, so
   the compressed and the linear axis are one code path (with compression off every weight is 1) and
   axis labels are placed by the drawn axis, not by the clock. The wheel listener is native with
   `passive: false`, because React's `onWheel` is passive and `preventDefault` in it is ignored.

**Money format.** `fmtUsd` keeps the leading zero (`$0.2352`) and trims trailing zeros below a dollar
(`$0.0010` → `$0.001`), with at least two decimals left (`$0.50`).

## Verify it yourself

```sh
# 1. syntax
node --check index.js && node --check lib/client.js

# 2. headless logic — 105 checks, no browser: a miniature React, a mock cordis context and mock
#    chat/trajectory snapshots, exercising the fold, both ledger paths, pricing, formatting, the
#    element tree of both chip seats, the session summary, the tab, the timeline, category
#    attribution, the option/duplicate guards and the hook-count invariant
node tools/smoke.mjs

# 3. the long-range series: runs the host half's own scan without a server, prints what it found
#    (span, categories, tokens, idle stretches) and asserts the wire contract the browser half
#    depends on — row shape, model indexes, category order, route path
node tools/series-check.mjs          # add --hours for a per-hour histogram

# 4. the account balance route: credential lookup, then a real provider round trip (no server).
#    Needs a credential and network access; the key itself is never printed
node tools/balance-check.mjs

# 5. an independent re-read of the durable logs, priced with the same table: if the tokens agree
#    but the money does not, the tariff is wrong; if the tokens disagree, the plugin is miscounting
node tools/audit-usage.mjs           # --session <id>, --target <usd>, --root <DSH home>, --sessions <dir>

# 6. reconcile a provider billing export against the logs: prints the verdict and a ready PRICES row
node tools/verify-billing.mjs --export <usage_data_YYYY-MM-DD_YYYY-MM-DD.zip>

# 7. the pre-publish gate: no personal data in the tree, no injection/transport/storage in the
#    payload, and every fetch in the payload covered by a declared reason
node tools/audit-public.mjs
```

`tools/series-check.mjs`, `tools/audit-usage.mjs` and `tools/verify-billing.mjs` read **your** session
logs — `$DSH_HOME`, falling back to `~/.dsh`, so they work on any machine. `tools/audit-usage.mjs`
additionally takes `--root <DSH home>` or `--sessions <dir>`, and `tools/verify-billing.mjs` takes the
export to reconcile against with `--export`. Nothing in `tools/` is loaded by the plugin.

## Security and privacy

The payload (`index.js`, `lib/client.js`, `cordis.patch.yml`, `package.json`) is deliberately boring,
and `tools/audit-public.mjs` fails the build if that changes:

- **No code or HTML injection** — no `eval`, no `new Function`, no `document.write`, no `innerHTML`,
  no `dangerouslySetInnerHTML`. All UI is React elements; nothing user-supplied is parsed as markup.
- **No storage, no cookies, no clipboard** — no `localStorage`, `sessionStorage`, `indexedDB`,
  `document.cookie` or `navigator.clipboard`. Both caches live in host process memory and are keyed by
  time, not persisted.
- **No raw transport** — no `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`.
- **`fetch` is declared, not banned** — and only where the gate's `DECLARED` table says so, with a
  reason: the browser half fetches **only this plugin's own host routes on the page origin**
  (`/cost-stats/series`, `/cost-stats/balance`), i.e. the local DSH server that served the page, and
  the host half makes **exactly one** outbound request — the provider's documented `user/balance`
  endpoint. Anything else fails the audit. The endpoint is overridable with `DSH_BALANCE_URL`.
- **The API key stays on the host.** It is read from `DEEPSEEK_API_KEY` or
  `$DSH_HOME/.credentials.yaml` inside the host process and is used only for that balance request; the
  response carries numbers, never the credential. The plugin never sends it anywhere else.
- **What it reads on disk:** your own session logs under `$DSH_HOME/sessions`, read-only, in the host
  process, for the long-range series. They are not uploaded, copied or rewritten; the balance route is
  the only thing that talks to the network at all.

Personal data: the repository contains no user paths, no e-mail addresses, no tokens and no billing
exports. `tools/audit-public.mjs` scans the payload and the whole tree for those, so a re-run is a
one-liner instead of a promise. Note the limits of that promise: it is a pattern gate, not a proof.

## Compatibility

- Verified live on **DSH 0.2.0-rc.2** (official install; both the `web` and the `desktop` profile) and
  developed against **0.1.5-rc.1** — the contract change that 0.2.0 brought is handled explicitly, see
  the changelog.
- Session logs: **v3 and v4** (`session.v3.jsonl.zstd`, `session.v4.jsonl.zstd`) — the
  `assistant/message` envelope (`data.usage`, `data.message.source.model`, numeric `time`) did not
  change between them, so one code path reads both.
- Host routes `/cost-stats/series` and `/cost-stats/balance` answer 200 in both profiles.
- Interfaces used: the `conversation.view`, `conversation.chat.assistant-actions`,
  `conversation.chat.turnTail` and `conversation.composer.dock` slots; the `chat` and `trajectory`
  conversation targets; the `uiSession.provide` hook registry (`cost`); the `sessionStats`,
  `tokenUsage` and `contextBreakdown` projections; the locale registry; the host `webServer` service.
  If a future DSH moves one of these, the failure is visible: the tab or the chip does not appear, and
  `node tools/smoke.mjs` fails.
- **The host half loads once at boot.** `lib/client.js` is hot-swapped by `dsh-client-hmr` (mtime/size
  polling → SSE `rebuilt`), but `index.js` is cached by the ESM loader: after changing it, restart the
  GUI. Until then the route answers 404 and the client honestly reports the loaded history as its
  source.

## Limitations

- **An estimate, not a bill.** The tariff table is local; the tokens and the cache hit are the
  provider's. Only the `deepseek-v4-pro` row is calibrated against a real billing export — the flash
  family still carries the published rates and is unverified. Re-check with
  `tools/verify-billing.mjs --export <zip>` and fix the row.
- **Window.** Per-turn figures cover the loaded turns; "whole session" comes from the `tokenUsage`
  projection (a whole log) priced with a token-weighted blend of the loaded turns, because that
  projection carries no model attribution.
- **Per-turn exactness.** When the engine cannot prove a turn's accounting (truncated window, retries,
  compaction) the turn is rebuilt from its requests and marked `≈`.
- **A 100 % cache hit in a long session is normal** — the prompt is stable, so nearly all input comes
  from cache. It is not a bug in the accounting.
- **Local models are priced at $0.** They are free to run, but the figure is then not comparable with
  a priced model in the same rating.
- **The host routes are unauthenticated.** They expose the cost series and the account balance to
  anything that can reach the DSH web server port; in practice that is loopback only, but if you expose
  the port, you expose the numbers with it. The balance route also never returns the credential.
- **The timeline's long ranges are only as good as the log directory** — a `$DSH_HOME` that moved, or a
  session store that was pruned, shrinks the visible history without an error.
- Russian is the developed wording (the dictionaries ship `en` and `ru`); other locales fall back.

## Diagnostics

- The timeline's window line names its **data source**: `Источник: логи сессий` when the host route
  answered, `Источник: загруженная история` when it did not (and `Источник: читаю логи…` while the scan
  is in flight). That one line tells you whether the host half is mounted and whether the GUI needs a
  restart.
- The tab carries the **tariff table** it is using, so a number that looks wrong can be compared with
  the rates that produced it without opening the bundle; the chip's panel additionally says `Оценка`
  and `ход собран из запросов` for a rebuilt turn.
- `node tools/series-check.mjs` prints what the host scan actually sees (sessions, requests, models,
  span, categories, idle stretches, payload size) and `node tools/audit-usage.mjs` prints the
  independent per-model totals — together they separate "the logs are missing" from "the tariff is
  wrong".
- If an entry disappears entirely, the framework has retired it: a slot entry that throws while
  rendering (or inside an effect) is removed from its cell for the rest of the page's life.
  `document.querySelector('[data-slot-error]')` names the dead slot, and only a page reload brings the
  entry back.
- Nothing in the plugin writes to the console in normal operation; the host half logs a warning only
  when a route handler fails.

## License

MIT — see [LICENSE](LICENSE).

---

## По-русски, коротко

Плагин к веб-интерфейсу DeepSeek Harness: **сколько стоит разговор в долларах**.

- В чате у каждого хода — плашка стоимости в строке действий, рядом со штатной «Использовано N ток»:
  общая цена и разбивка по видам действий (инструменты / размышления / чтение и анализ) иконками.
  По клику — панель с токенами по категориям, моделью, номером хода, временем, TTFT и ток./с.
  Ход, который движок не смог посчитать точно, пересобирается из своих запросов и помечается `≈`.
- Вкладка **«Расход»** рядом с «Траекторией»: KPI, графики (токены и стоимость по ходам, состав
  расхода, куда уходит время, состав контекста), раздел «по чём действия» с долями до 100 %,
  рейтинги ходов, инструментов, запросов и моделей, таблица тарифов.
- **Динамика** — интерактивный таймлайн: деньги/запросы/токены в минуту и накопление, диапазоны
  от часа до «всё», зум колесом, панорама перетаскиванием, шаг 10 с … 1 ч, сжатие простоев.
- Под композером — стоимость всей сессии и остаток на счёте провайдера (ключ остаётся на хосте).
- Долгий ряд берётся из логов сессий (`$DSH_HOME/sessions`, форматы v3 и v4) через хост-маршрут
  `/cost-stats/series`; деньги считаются в браузере по таблице `PRICES`, поэтому это **оценка, а не
  счёт**. Точные ставки проверены по выгрузке биллинга только для `deepseek-v4-pro`.
- Ничего в самом DSH не патчится: только официальные слоты, локали и цели разговора.
- Проверки и аудит — командами из раздела «Verify it yourself»; предпубликационный шлюз —
  `node tools/audit-public.mjs`. Установка — `dsh plugin --profile <profile> add <checkout>`, затем
  одна перезагрузка страницы.
