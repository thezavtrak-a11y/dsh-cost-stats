# Notes for DSH client-plugin authors

What was learned building `dsh-cost-stats` against the DeepSeek Harness web GUI. Everything here was
verified against a running install, and the three "traps" at the end each cost a real debugging round.

## Package shape

A browser-side plugin is an ordinary npm package that declares itself:

```jsonc
// package.json
{
  "exports": { ".": { "default": "./index.js" }, "./client": { "default": "./lib/client.js" } },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // optional: patches the loader composition
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "…"] }
  }
}
```

- The **host half** (`index.js`) may be empty; it exists so the loader can mount the row, which is what
  makes the client-modules scanner find the `dsh.client` declaration.
- The **browser half** (`lib/client.js`) is a plain script that only *registers* a factory. Nothing in
  it runs until the module is materialised:

```js
window.__ModuleLoader__.load({
  id: 'my-plugin',                       // must equal the package name
  factory: (require) => {
    const react = require('react')
    const exports = {}
    exports.apply = (ctx) => { /* register slots, hooks, locale dicts */ }
    exports.inject = ['slots', 'locale', 'uiConversation', 'uiSession', 'sessions']
    exports.name = 'my-plugin'
    return exports
  }
})
```

- `require` walks a **static table** seeded by the shell — `react`, `react-dom`, `react/jsx-runtime`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` — plus the other graph
  rows. Anything else throws loudly, which is the intended purity gate. A bundle needs no build step:
  hand-written factory-form CJS is fine.
- Styling: injecting CSS is not necessary. The design tokens are CSS variables on the document
  (`--dsw-alias-*` for text/borders/layers, `--dsw-static-*` for palette, `--dsh-content-font-size*`
  for the chat's own type scale), so inline styles stay theme-aware and match the surrounding UI.

## Slots

`ctx.slots.register(definition, Component)`, with the definition declaring `name`, and one of:

| Kind | Behaviour |
|---|---|
| `single` | one occupant; a later registration replaces it |
| `keyed` | one occupant per `key` |
| `list` | every registration renders, ordered by `order`, identified by `id` |
| `chain` | **a priority chain: the first selector that accepts the owner renders, and nothing else** |

The `chain` semantics are the important one, and they are easy to misread as "a list of contributors".
A practical consequence: the shipped `conversation.chat.turnTail` chain is claimed by
`dsh-client-ui-deliverables` for every turn that produced files, so anything registered there silently
renders nothing on exactly the turns a user is most likely to look at. Register in a `list` slot
(`conversation.chat.assistant-actions`) when the element must always appear.

Slots are scoped. A session-scoped slot receives the session standard props, which include every hook
published through `ctx.uiSession.provide`:

```js
ctx.uiSession.provide({
  hooks: ['cost'],                                   // roster key
  resolve: (binding) => ({ hooks: { cost: source(binding) } })
})
// …and the component receives it as `props.useCost`
```

The prop name is `use` + capitalised roster key. Host projections of the session log are read with
`props.useProjection('tokenUsage' | 'sessionStats' | 'contextBreakdown' | 'contextPressure')`.

## Where usage lives

Two conversation targets carry almost everything, and they complement each other:

- **`chat`** — `turn-tail` nodes carry exact per-turn accounting (`data.tokenUsage`, published at
  `turn/end`), `tool-call` nodes carry the call trees, `assistant-step` nodes carry the raw provider
  usage of one settled step. Node locations (`node.location.kind === 'step'`) give the `turn`/`step`
  an event belongs to, which is what lets a request be attributed to the action it performed.
- **`trajectory`** — `snapshot.requests` are assembled per model request and carry both the exact
  provider `usage` and the route it was sent to (`requestConfig`/`provenance`). This is the better
  source for per-request numbers, because `chat` rows do not always know the model.

Reach them from a session binding:

```js
const chat = ctx.uiConversation.binding(binding).target('chat')
const trajectory = ctx.uiConversation.binding(binding).target('trajectory')
```

Both are observable: `getSnapshot()` is identity-stable between changes and `subscribe(listener)`
notifies on every one, so a small memoising wrapper turns them into a `useSyncExternalStore` source.
Resolve the targets defensively — an unknown target name is not guaranteed to return `undefined`.

## Reading the durable logs (for audits)

- Session logs live in `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.v3.jsonl.zstd`.
- One file is **not** one gzip-style stream: it is a sequence of independent zstd frames, and
  `zstdDecompressSync` decodes only the first. Splitting the buffer on the zstd magic
  (`28 B5 2F FD`) and decoding each slice works and is what `tools/audit-usage.mjs` does.
- `assistant/message` records carry `data.usage` (`inputTokens` uncached, `cacheReadTokens`,
  `cacheWriteTokens`, `outputTokens`, `reasoningTokens`) and `data.message.source` with the exact
  provider/model. `totalTokens` decomposes as uncached + cached + output, which is a handy
  self-consistency check.
- Sanity checks worth running before trusting a total: every record's `surfaceOp` should be
  `append` (a replacement copy is not a new bill), and message ids should be unique.

## Three traps

**1. Hooks must not sit behind an early return.** A component that returns `null` while its data is
still loading and then calls one more hook on the next render changes its hook count, and React tears
it down ("rendered fewer hooks than expected"). The nasty part is the *symptom*: under hot reload the
component mounts with data already present, so it looks fine — and it only breaks on a fresh page load,
which reads as "it worked, then I pressed F5 and it vanished". Put every hook at the top, before any
branch. This repository's smoke test asserts it: mock shell hooks count themselves, and every component
must show the same hook count in every data state it is rendered with.

**2. The conversation host keeps one view area for all tabs.** Switching tabs does not create a new
scroll container, so the new view inherits the previous view's scroll position — opening a report from
the bottom of a chat lands on the bottom of the report. A `useLayoutEffect` that resets its own
`scrollTop` and that of its scrollable ancestors (`overflow-y: auto | scroll`) fixes it before paint,
so there is no visible jump.

**3. React's `onWheel` is passive.** `event.preventDefault()` inside it is ignored, so a zoom
implemented that way scrolls the page instead. Attach the listener yourself with
`addEventListener('wheel', handler, { passive: false })`.

## Rounding money, and rate arithmetic

Two mistakes that produce plausible-looking but wrong numbers:

- **A rate is not a bucket value.** The average rate of a window is `total / (span / 60000)`; dividing
  the window total by the *bucket* step multiplies it by the number of buckets and can make the
  "average" exceed the "peak". Per-bucket rates are the ones that do divide by the step.
- **The right edge of a window is inclusive.** A timestamp exactly at `start + span` floors to
  `bucketCount`, i.e. one past the end; clamp it into the last bucket instead of reporting it as
  "outside the window".

And for display: below one dollar, dropping the leading zero *and* trailing zeros (`$0.0010` →
`$.001`) keeps a dense row readable without losing a digit.
