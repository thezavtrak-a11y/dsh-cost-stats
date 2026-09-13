# dsh-cost-stats

Money on the screen for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI:
a cost pill under every completed turn, and a **Cost** tab next to the chat and trajectory views with
charts, ratings and an interactive timeline. DSH reports tokens and never a monetary amount, so this
plugin does the arithmetic against a local price table — the numbers are an estimate, not a bill.

Nothing upstream is patched: the plugin registers into the official slot, session-source and locale
registries, so it survives DSH upgrades and uninstalls by removing one row.

## What you get

**In the chat** — a flat, right-aligned pill in the message action row, styled like the shipped
`Used N tokens` item next to it:

```
≈ $.6217   ⚙$.4698   🧠$.0430   👁$.1519
```

The icons are the categories, the numbers are what each kind of action cost (see below). Click it for
the full breakdown: bucket table (uncached input, cached input, cache write, output, of which
reasoning), model, turn number, wall time, TTFT and tok/s.

**Under the composer** — the same four numbers for the whole session, sitting right after the shipped
stats strip (steps, tok/s, tokens, cache hit).

**The Cost tab** (`order: 20`, so it lands right after the action graph) contains:

- KPI cards: cost of the loaded turns, whole session, requests and average cost per request,
  reasoning share, cache hit %, tok/s, TTFT, turn wall time;
- per-turn token and cost columns, a spend-composition donut, time split and context composition;
- **what each action costs** — tools / reasoning / reading and analysis, with request counts,
  tokens, money and share;
- ratings: most expensive turns, tools by calls and time, most expensive requests with their model,
  models by cost;
- an **interactive timeline** (see below);
- the price table the whole thing is computed with.

## What each action costs

Every model request is attributed to exactly one category by what that request did:

| Category | Icon | Condition |
|---|---|---|
| Tools | gear | the request called at least one tool outside the read list |
| Reasoning | the shell's own "think" glyph | the request called no tool at all |
| Reading & analysis | browse/data | every tool it called is on the read list |

A request's cost lands in one category, so the shares always add up to the total. The read list lives
in `READ_TOOLS` at the top of `lib/client.js` — MCP names are normalised, so
`mcp__some-server__Snapshot` counts as `snapshot`.

## The interactive timeline

| Metric | Shows |
|---|---|
| `$ per minute` | spend rate over time |
| `Requests per minute` | how often the model was called |
| `Tokens per minute` | token throughput |
| `Cumulative cost` | how the money accumulated from the window start |

Wheel zooms around the cursor, dragging pans, double click (or the Reset button) returns to the full
range. A step selector offers 10 s / 1 min / 5 min / 15 min; rates are always normalised to a minute,
so the unit never changes. Hovering any step shows its own numbers. The line above the plot summarises
the visible window: range, requests, window cost, average rate, peak rate and how many requests fall
outside it.

Geometry is one SVG with `preserveAspectRatio="none"` and **all readable text lives in HTML layers on
top** — text inside a stretched SVG would be distorted. The wheel listener is attached natively with
`{ passive: false }`, because React's own `onWheel` is passive and `preventDefault` there is ignored
(the page would scroll instead of the chart zooming).

## Pricing

`PRICES` at the top of `lib/client.js` is four numbers per model, in USD per million tokens:

```
miss  — uncached prompt input
hit   — prompt input served from the provider cache
write — prompt input written into the provider cache
out   — completion output (reasoning tokens are a SUBSET of out, so they are not added twice)
```

The table ships with published DeepSeek rates on the prompt/output sides and `hit` at **zero**. That
zero is deliberate: auditing a real, long-lived DSH corpus (`tools/audit-usage.mjs`) showed ~99.4 % of
all prompt tokens arriving as cache hits, and pricing those at a published cache rate overshot the
provider's own bill by an order of magnitude — cached input is evidently not charged on that plan.
If yours is, put the real number in `hit` and every total moves with it.

## Install

The plugin is a normal DSH client package. Put it anywhere, then add it to a web profile:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-cost-stats": "file:<path to this checkout>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cost-stats"] } }
}
```

`dsh plugin --profile web add "file:<path>"` does the same thing and needs `pnpm` on `PATH`. A bundle
list is composed at boot, so a newly added bundle shows up after a restart; edits to
`lib/client.js` afterwards are picked up by `dsh-client-hmr` (it polls the bundle's mtime and size)
without any restart.

If you would rather not touch the bundle list, mount the row from the profile's own live-reloaded
patch layer instead — it composes at boot all the same, and reloads live:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: cost-stats
      name: dsh-cost-stats
```

## Tools

```bash
node tools/smoke.mjs         # 96 assertions: folding, pricing, attribution, rendering, hooks
node tools/audit-usage.mjs   # independent audit straight out of the durable session logs
```

`smoke.mjs` renders the plugin against a miniature React and mock shell services, so it runs with no
browser: it covers the cost folds, the category attribution, the money formatting, both seats the pill
can render into, and — because both have already bitten once — that no component changes its hook
count between data states.

`audit-usage.mjs` is the ground truth check. It reads `$DSH_HOME/sessions/*/session.v3.jsonl.zstd`
(each file is a stream of independent zstd frames), sums the provider-reported usage, prices it with
the same table, and reports per model, per session and in total. Useful flags:

```bash
node tools/audit-usage.mjs --session <id-prefix>   # one session
node tools/audit-usage.mjs --target <bill>         # solve the implied $/M, and print a ready table
node tools/audit-usage.mjs --root <dsh-home>       # read another DSH home
```

It makes **no model calls** — it only reads logs and does arithmetic, so running it costs nothing.

## Limitations

- **An estimate, not an invoice.** Token counts come from the provider; the money comes from the local
  table.
- Money is only shown where the cost is actually known: an exact per-turn accounting, or a turn rebuilt
  from its own requests (marked `≈`). Otherwise nothing is rendered rather than a made-up number.
- The report covers the **loaded history window**; the "whole session" figures come from the host's
  own token projection, priced with the effective tariff of the loaded turns.
- Timestamps are the request start times from the log, so a long request is attributed to the minute it
  began.

## Notes for plugin authors

`NOTES.md` collects what was learned writing this against DSH's client-plugin API: the module format,
the four slot kinds (and why `chain` is not a list), how session-scoped hooks reach a component, which
conversation targets carry usage, and the React/scroll traps that only appear after a page reload.

## License

MIT — see `LICENSE`.
