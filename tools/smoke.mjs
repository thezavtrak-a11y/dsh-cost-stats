/**
 * dsh-cost-stats — smoke test.
 *
 * Loads `lib/client.js` the way the DSH web shell does (a
 * `window.__ModuleLoader__.load({id, factory})` registration), materializes the
 * factory against a mock module table, mounts it onto a mock cordis context and
 * then renders both contributions with a miniature React so that the whole cost
 * pipeline — folding, pricing, formatting, JSX-free element tree — is exercised
 * without a browser.
 *
 * Run: `node tools/smoke.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

/* ── miniature React ─────────────────────────────────────────────────────── */

let frames = []

function shallowEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

const Fragment = Symbol('Fragment')

const React = {
  Fragment,
  createElement(type, props, ...children) {
    const flat = []
    const push = (child) => {
      if (Array.isArray(child)) {
        for (const item of child) push(item)
        return
      }
      if (child === null || child === undefined || typeof child === 'boolean') return
      flat.push(child)
    }
    for (const child of children) push(child)
    const next = { ...(props ?? {}) }
    if (flat.length === 1) next.children = flat[0]
    else if (flat.length > 1) next.children = flat
    return { __el: true, type, props: next }
  },
  useState(initial) {
    const frame = frames[frames.length - 1]
    const index = frame.index++
    if (!(index in frame.state)) frame.state[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      frame.state[index] = typeof value === 'function' ? value(frame.state[index]) : value
    }
    return [frame.state[index], set]
  },
  useMemo(factory, deps) {
    const frame = frames[frames.length - 1]
    const index = frame.index++
    const previous = frame.memo[index]
    if (previous !== undefined && shallowEqual(previous.deps, deps)) return previous.value
    const value = factory()
    frame.memo[index] = { deps, value }
    return value
  },
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial }
  },
  /** Effects run immediately in the mock: there is no DOM here to defer to. */
  useEffect(fn) {
    bumpHook()
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : undefined
  },
  useLayoutEffect(fn) {
    bumpHook()
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : undefined
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  }
}

/** Walk one element tree, collecting visible text and selected attributes. */

/** Hook count per component function, across every render this run performed. */
const hookCounts = new Map()

/** Count one hook call against the current frame (used by the mocked shell hooks). */
function bumpHook() {
  const frame = frames[frames.length - 1]
  if (frame !== undefined) frame.index += 1
}

/** Mocked `useCost`: a real hook in the shell, so it must count as one here too. */
const mockUseCost = (stats) => () => {
  bumpHook()
  return stats
}

/** Mocked `useProjection`: same reasoning as `mockUseCost`. */
const mockUseProjection = (read) => (key) => {
  bumpHook()
  return read(key)
}

/** Mocked selector hooks (`useSession` and friends): counts, and still applies the selector. */
const mockUseHook = (value) => (selector) => {
  bumpHook()
  return typeof selector === 'function' ? selector(value) : value
}

function walk(node, text, attrs) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, text, attrs)
    return
  }
  if (typeof node !== 'object' || node.__el !== true) return
  const props = node.props
  if (typeof props.title === 'string') attrs.push(props.title)
  if (typeof props['aria-label'] === 'string') attrs.push(props['aria-label'])
  if (typeof props['data-icon'] === 'string') attrs.push(props['data-icon'])
  if (node.type === Fragment) {
    walk(props.children, text, attrs)
    return
  }
  if (typeof node.type === 'function') {
    const frame = { index: 0, state: [], memo: [] }
    frames.push(frame)
    let produced
    try {
      produced = node.type(props)
    } finally {
      frames.pop()
      // React requires a stable hook count per component across renders. Track it so
      // a component that skips a hook on one branch is caught here, in the test,
      // instead of blowing up in the browser as "rendered fewer hooks than expected".
      let seen = hookCounts.get(node.type)
      if (seen === undefined) {
        seen = new Set()
        hookCounts.set(node.type, seen)
      }
      seen.add(frame.index)
    }
    walk(produced, text, attrs)
    return
  }
  walk(props.children, text, attrs)
}

function render(element) {
  const text = []
  const attrs = []
  frames = []
  walk(element, text, attrs)
  return { text: text.join(' | '), attrs }
}

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message)
  console.log('  ok  ' + message)
}

/* ── the module table the shell would hand the bundle ────────────────────── */

/** Stand-ins for the shell's outline icon set: the pill must render real glyphs. */
const fakeIcon = (name) =>
  function Icon() {
    return React.createElement('svg', { 'data-rendered': name })
  }

const primitivesMock = {
  IconSettingsOutline16: fakeIcon('IconSettingsOutline16'),
  IconThinkOutline14: fakeIcon('IconThinkOutline14'),
  IconBrowseOutline16: fakeIcon('IconBrowseOutline16')
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    }
  }
}

const requireShim = (spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesMock
  throw new Error('unexpected require("' + spec + '")')
}

const source = readFileSync(BUNDLE, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)
assert(registration !== undefined, 'bundle registered itself with __ModuleLoader__')
assert(registration.id === 'dsh-cost-stats', 'registration id is the package name')

const mod = registration.factory(requireShim)
assert(mod.name === 'dsh-cost-stats', 'exports a stable plugin name')
assert(typeof mod.apply === 'function', 'exports apply()')
assert(Array.isArray(mod.inject), 'exports a service inject roster')

/* ── mock cordis context ─────────────────────────────────────────────────── */

const dicts = {}
const slots = []
let sessionSources
let viewLabel

const mockSession = { loadedOlder: 0, async loadOlder() { this.loadedOlder += 1 } }

const ctx = {
  logger: {
    warn: (...args) => console.log('  warn', ...args),
    error: (...args) => console.log('  error', ...args)
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, ...rest) {
      dicts[ns] = rest.length === 1 ? rest[0] : { [rest[0]]: rest[1] }
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const dict = dicts[ns] ?? {}
        // The harness locale layer walks the active language first (ru here).
        const template = dict.ru?.[key] ?? dict.en?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''))
      }
    }
  },
  slots: {
    inject(name, fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(definition, component) {
      slots.push({ definition, component })
      if (definition.name === 'conversation.view') viewLabel = definition.label?.()
      return () => {}
    }
  },
  uiConversation: {
    binding(binding) {
      return {
        target(name) {
          if (name === 'chat') return chatTarget
          if (name === 'trajectory') return binding.useTrajectory === true ? trajectoryTarget : undefined
          return undefined
        }
      }
    }
  },
  uiSession: {
    provide(descriptor) {
      sessionSources = descriptor
      return () => {}
    }
  },
  sessions: {
    binding() {
      return { session: mockSession }
    }
  }
}

/* ── a synthetic Chat snapshot ───────────────────────────────────────────── */

/** The plugin's EMPTY_STATS shape: nothing loaded, no money. */
const emptyCategory = () => ({ usd: 0, tokens: 0, requests: 0 })
const EMPTY_STATS_LIKE = {
  turns: [],
  byTurn: new Map(),
  byMessage: new Map(),
  requests: [],
  tools: [],
  models: [],
  totals: {
    usd: 0,
    categories: { tools: emptyCategory(), reasoning: emptyCategory(), read: emptyCategory() }
  },
  blend: { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }
}

const turnOne = {
  turn: 1,
  seq: 10,
  time: 1_000,
  ttftMs: 420,
  tokensPerSecond: 48.5,
  closing: { finalNode: { messageId: 'm-1' } },
  tokenUsage: {
    uncachedInputTokens: 12_000,
    outputTokens: 2_000,
    totalTokens: 14_000,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 0,
    reasoningTokens: 800,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
  }
}

const turnTwo = {
  turn: 2,
  seq: 30,
  time: 3_000,
  ttftMs: 310,
  tokensPerSecond: 52,
  closing: { finalNode: { messageId: 'm-2' } },
  tokenUsage: {
    uncachedInputTokens: 5_000,
    outputTokens: 1_000,
    totalTokens: 6_000,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }]
  }
}

const toolNode = {
  kind: 'tool-call',
  location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } },
  data: {
    root: {
      kind: 'tool-result',
      callId: 'c1',
      time: 2_500,
      callTime: 2_000,
      isError: false,
      call: { name: 'read', argsRaw: '{}' },
      subCalls: [
        { kind: 'tool-result', callId: 'c2', time: 2_400, callTime: 2_300, isError: true, call: { name: 'pwsh', argsRaw: '{}' }, subCalls: [] }
      ]
    }
  }
}

/** Turn 3 step 2 only observed the machine, so its request counts as reading. */
const observeNode = {
  kind: 'tool-call',
  location: { kind: 'step', turn: { turn: 3 }, step: { step: 2 } },
  data: {
    root: {
      kind: 'tool-result',
      callId: 'c3',
      time: 5_700,
      callTime: 5_600,
      isError: false,
      call: { name: 'mcp__windows-mcp__Snapshot', argsRaw: '{}' },
      subCalls: []
    }
  }
}

/** Turn 3 has no exact turn-tail accounting: only settled step usages. */
const stepNode = (step, usage) => ({
  kind: 'assistant-step',
  data: {
    status: 'settled',
    turn: 3,
    step,
    time: 5_000 + step,
    usage,
    finalNode: {
      requestConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    }
  }
})

const nodes = new Map([
  ['k1', { kind: 'turn-tail', data: turnOne }],
  ['k2', toolNode],
  ['k3', { kind: 'turn-tail', data: turnTwo }],
  ['k4', { kind: 'assistant-step', data: { status: 'settled', turn: 1, step: 1, time: 1_500, usage: { inputTokens: 12_000, outputTokens: 2_000 } } }],
  ['k5', stepNode(1, { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 3_000 })],
  ['k6', stepNode(2, { inputTokens: 2_000, outputTokens: 1_000 })],
  ['k7', observeNode]
])

const chatTarget = {
  snapshot: {
    order: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'],
    nodes: { get: (key) => nodes.get(key) },
    timeline: {
      turnOrder: [1, 2, 3],
      turns: new Map([
        [1, { start: { time: 900 }, end: { time: 2_600 } }],
        [2, { start: { time: 2_700 }, end: { time: 4_000 } }]
      ])
    }
  },
  getSnapshot() {
    return this.snapshot
  },
  subscribe() {
    return () => {}
  }
}

/** Trajectory rows: exact per-request usage plus the route each request was sent to. */
const trajectoryRequests = [
  {
    purpose: 'assistant',
    turn: 1,
    step: 1,
    startedAt: 1_000,
    usage: { inputTokens: 12_000, outputTokens: 2_000, cacheReadTokens: 40_000, reasoningTokens: 800 },
    requestConfig: { provider: 'deepseek-official', model: 'deepseek-flash' }
  },
  {
    purpose: 'assistant',
    turn: 2,
    step: 1,
    startedAt: 2_700,
    usage: { inputTokens: 5_000, outputTokens: 1_000 },
    requestConfig: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  },
  {
    purpose: 'assistant',
    turn: 3,
    step: 1,
    startedAt: 5_000,
    completedAt: 5_100,
    usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 3_000 },
    provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  },
  { purpose: 'compaction', turn: null, step: 0, startedAt: 5_500, usage: { inputTokens: 9_999, outputTokens: 9_999 } },
  {
    purpose: 'assistant',
    turn: 3,
    step: 2,
    startedAt: 5_600,
    completedAt: 5_700,
    usage: { inputTokens: 2_000, outputTokens: 1_000 },
    requestConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }
]

const trajectoryTarget = {
  getSnapshot() {
    return { requests: trajectoryRequests }
  },
  subscribe() {
    return () => {}
  }
}

/* ── mount ───────────────────────────────────────────────────────────────── */

mod.apply(ctx)

assert(dicts.cost !== undefined && dicts.cost.ru !== undefined, 'registers its locale namespace for ru')
assert(viewLabel === 'Расход', 'the new view tab is labelled «Расход»')

const viewSlot = slots.find((entry) => entry.definition.name === 'conversation.view')
const tailSlot = slots.find((entry) => entry.definition.name === 'conversation.chat.turnTail')
assert(viewSlot !== undefined && viewSlot.definition.id === 'cost', 'registers the conversation view tab')
assert(viewSlot.definition.order === 20, 'the tab sits after chat (0) and trajectory (10)')
assert(tailSlot !== undefined, 'registers the chat turn-tail cost chip')

/* ── the cost ledger ─────────────────────────────────────────────────────── */

const hooks = sessionSources.resolve({}).hooks
const ledger = hooks.cost.getSnapshot()

assert(ledger.turns.length === 3, 'folds three turns')
assert(ledger.turns[0].turn === 1 && ledger.turns[2].turn === 3, 'orders turns ascending')
assert(ledger.turns[0].wallMs === 1_700, 'derives turn wall time from the timeline')
// turn 1: 12000 miss * 0.27 + 40000 hit * 0.07 + 2000 out * 1.10, all /1e6
// Tariff under test: flash 0.27 / 0.00 / 1.10, pro 0.55 / 0.00 / 2.19 — cached
// input is not charged, which is what the audit of the real logs established.
const expectedTurnOne = (12_000 * 0.27 + 40_000 * 0.0 + 2_000 * 1.1) / 1e6
const expectedTurnTwo = (5_000 * 0.55 + 1_000 * 2.19) / 1e6
// turn 3 is rebuilt from its two steps: 3000 miss, 3000 cache read, 1500 out at flash
const expectedTurnThree = (3_000 * 0.27 + 3_000 * 0.0 + 1_500 * 1.1) / 1e6
const round = (value) => Number(value.toFixed(9))
assert(round(ledger.turns[0].cost.usd.total) === round(expectedTurnOne), 'prices turn 1 with the flash tariff')
assert(round(ledger.turns[1].cost.usd.total) === round(expectedTurnTwo), 'prices turn 2 with the pro tariff')
assert(round(ledger.turns[2].cost.usd.total) === round(expectedTurnThree), 'rebuilds a turn from its step usages')
assert(ledger.turns[0].approximate === false && ledger.turns[2].approximate === true, 'flags the rebuilt turn approximate')
assert(
  round(ledger.totals.usd) === round(expectedTurnOne + expectedTurnTwo + expectedTurnThree),
  'totals sum the per-turn cost'
)
assert(ledger.totals.tokens === 67_500, 'totals sum every disjoint token bucket')
assert(ledger.totals.reasoning === 800, 'reasoning tokens are tracked separately')
assert(ledger.totals.cacheHitPercent === 68, 'cache hit percent is hit / (hit + miss)')
assert(ledger.requests.length === 3, 'keeps one ledger row per settled request')
assert(ledger.totals.requests === 3, 'counts requests')
assert(round(ledger.blend.miss) === round((3_240 + 2_750 + 810) / 20_000), 'blends a token-weighted miss tariff')
assert(ledger.tools.length === 3, 'collects tools, nested calls included')
assert(ledger.tools[0].name === 'read' && ledger.tools[1].name === 'pwsh', 'keeps tool order by call count')
assert(ledger.tools[0].ms === 500 && ledger.tools[1].errors === 1, 'records tool duration and errors')
assert(ledger.models.length === 3 && ledger.models[0].model === 'deepseek-flash', 'ranks models by cost')

/* ── the chat chip ───────────────────────────────────────────────────────── */

const owner = { turn: { data: { get: (key) => (key === 'turn-tail' ? turnOne : undefined) } } }
assert(
  tailSlot.definition.select(owner) === null,
  'the chain seat declines a turn the message action list will price (no duplication)'
)
assert(
  tailSlot.definition.select({ turn: { data: { get: () => undefined } } }) === null,
  'the chain seat declines a turn with no tail at all'
)

// A turn whose tail has no closing assistant has no action row to attach to, so the
// chain seat is the only place its cost can appear.
const chainedTail = {
  turn: 4,
  seq: 45,
  time: 7_000,
  closing: null,
  ttftMs: 100,
  tokensPerSecond: 10,
  tokenUsage: {
    uncachedInputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }]
  }
}
const chained = tailSlot.definition.select({ turn: { data: { get: () => chainedTail } } })
assert(chained !== null && chained.turn === 4, 'the chain seat claims a turn that has no action row')
assert(chained.exact !== null, 'the chain seat prices the turn exactly when the tail carries usage')

const claimed = tailSlot.definition.select({ turn: { data: { get: () => ({ turn: 3, closing: null }) } } })
assert(claimed !== null && claimed.exact === null, 'the chain seat still claims a turn only the ledger can price')

assert(ledger.byMessage.get('m-1') === 1, 'maps the closing assistant message to its turn')
assert(ledger.byTurn.get(1) === ledger.turns[0], 'indexes turns by number')

const chip = render(
  React.createElement(tailSlot.component, { matched: chained, t: ctx.locale.bind('cost'), useCost: mockUseCost(ledger) })
)
assert(chip.text.includes('$.0008'), 'the chip shows the turn price, without a leading zero')
assert(chip.text.includes('1.50k'), 'the chip shows the total token count')

const approximateChip = render(
  React.createElement(tailSlot.component, {
    matched: claimed,
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(ledger)
  })
)
assert(approximateChip.text.includes('≈ $.0025'), 'the chip prices a ledger-rebuilt turn with ≈')
assert(approximateChip.attrs.some((value) => value.includes('ход собран из запросов')), 'the chip explains the ≈')

const blindChip = render(
  React.createElement(tailSlot.component, {
    matched: { turn: 99, exact: null, mixed: false },
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(ledger)
  })
)
assert(blindChip.text.trim() === '', 'the chip renders nothing for a turn the ledger cannot price')

/* ── the message action entry (the reliable seat) ────────────────────────── */

const actionSlot = slots.find((entry) => entry.definition.name === 'conversation.chat.assistant-actions')
assert(actionSlot !== undefined && actionSlot.definition.id === 'cost-stats', 'registers a message action entry')

const action = render(
  React.createElement(actionSlot.component, {
    messageId: 'm-1',
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(ledger)
  })
)
assert(action.text.includes('$.0054'), 'the message action prices the closing message turn')
assert(action.attrs.includes('IconSettingsOutline16'), 'the message action labels tools with the shell gear icon')
assert(action.attrs.some((value) => value.includes('Инструменты')), 'the message action keeps the label in its tooltip')
assert(!action.attrs.some((value) => value.includes('Чтение и анализ')), 'the message action omits a category with no spend')
assert(!action.text.includes('Инструменты'), 'the message action carries no word labels in the row')

/* ── the session summary under the composer ──────────────────────────────── */

const summarySlot = slots.find((entry) => entry.definition.name === 'conversation.composer.dock')
assert(
  summarySlot !== undefined && summarySlot.definition.id === 'cost-stats' && summarySlot.definition.order === 10,
  'registers the session summary after the shipped stats pills'
)

const summary = render(
  React.createElement(summarySlot.component, {
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(ledger),
    useProjection: mockUseProjection(() => undefined)
  })
)
assert(summary.text.includes('$.0128'), 'the session summary shows the whole-session cost')
assert(summary.attrs.includes('IconSettingsOutline16'), 'the session summary reuses the category icons')
assert(summary.attrs.includes('IconThinkOutline14'), 'the session summary shows reasoning spend')
assert(summary.attrs.includes('IconBrowseOutline16'), 'the session summary shows reading spend')
assert(summary.attrs.some((value) => value.includes('Стоимость сессии')), 'the session summary labels itself on hover')

const summaryWithoutLedger = render(
  React.createElement(summarySlot.component, {
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(EMPTY_STATS_LIKE),
    useProjection: mockUseProjection(() => undefined)
  })
)
assert(summaryWithoutLedger.text.trim() === '', 'the session summary survives a missing ledger')

const noAction = render(
  React.createElement(actionSlot.component, {
    messageId: 'unknown-message',
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(ledger)
  })
)
assert(noAction.text.trim() === '', 'the message action renders nothing for an unrouted message')

const noStats = render(
  React.createElement(actionSlot.component, {
    messageId: 'm-1',
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(EMPTY_STATS_LIKE)
  })
)
assert(noStats.text.trim() === '', 'the message action survives a missing ledger')

/* ── the tab ─────────────────────────────────────────────────────────────── */

const projections = (key) =>
  key === 'tokenUsage'
    ? { uncachedInputTokens: 17_000, outputTokens: 3_000, cacheReadTokens: 40_000, cacheWriteTokens: 0 }
    : key === 'sessionStats'
      ? { turns: 2, steps: 9, llmMs: 4_200, toolMs: 1_100, ttftMs: 730, ttftSteps: 2, decodeMs: 3_000, decodeTokens: 3_000 }
      : key === 'contextBreakdown'
        ? { systemTokens: 5_000, toolsTokens: 9_000, messageTokens: 21_000 }
        : undefined

const view = render(
  React.createElement(viewSlot.component, {
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(hooks.cost.getSnapshot()),
    useProjection: mockUseProjection(projections),
    useSession: mockUseHook({ hasMore: true }),
    sessionId: 's1',
    loadOlder: () => {}
  })
)

assert(view.text.includes('Расход и статистика'), 'the tab renders its title')
assert(view.text.includes('$.0128'), 'the tab shows the total cost of the loaded turns')
assert(view.text.includes('Ввод из кэша'), 'the tab renders the bucket breakdown')
assert(view.text.includes('Рейтинг: самые дорогие ходы'), 'the tab renders the turn rating')
assert(view.text.includes('Рейтинг инструментов'), 'the tab renders the tool rating')
assert(view.text.includes('Рейтинг: самые дорогие запросы'), 'the tab renders the request rating')
assert(view.text.includes('По чём действия'), 'the tab renders the action-cost section')

/* ── the interactive timeline ────────────────────────────────────────────── */

assert(view.text.includes('Динамика: запросы, деньги и накопление'), 'the tab renders the timeline section')
assert(view.text.includes('$ в минуту'), 'the timeline offers a money-per-minute metric')
assert(view.text.includes('Запросов в минуту'), 'the timeline offers a request-rate metric')
assert(view.text.includes('Накопленная стоимость'), 'the timeline offers cumulative cost')
assert(view.text.includes('1 мин') && view.text.includes('10 с'), 'the timeline offers bucket widths')
assert(view.text.includes('Средний темп') && view.text.includes('Пик'), 'the timeline summarises the visible window')
assert(view.text.includes('перетаскивание'), 'the timeline explains its own gestures')
assert(view.text.includes('/мин'), 'rates carry the per-minute unit')

/* ── the timeline arithmetic ─────────────────────────────────────────────── */

// The full window must hold every request the ledger knows about, and report none
// as falling outside it — the last request sits exactly on the window edge.
assert(view.text.includes('Запросов: 3'), 'the window counts every request in range')
assert(!view.text.includes('Вне окна'), 'nothing falls outside the full window')
assert(view.text.includes('deepseek-v4-pro'), 'the tab renders the model rating')
assert(view.text.includes('≈ '), 'the tab marks the rebuilt turn approximate')
assert(view.text.includes('Загрузить раннюю историю'), 'the tab offers earlier history when paged')
assert(view.attrs.some((value) => value.includes('ход 3')), 'turn columns carry hover detail')

/* ── the trajectory-backed request ledger ────────────────────────────────── */

// A second binding resolves with the trajectory target present: the request
// ledger then comes from trajectory rows, which carry route attribution.
const routedHooks = sessionSources.resolve({ useTrajectory: true }).hooks
const routed = routedHooks.cost.getSnapshot()

assert(routed.requests.length === 4, 'takes one ledger row per assistant request')
assert(
  routed.requests.every((row) => row.model !== 'unknown'),
  'attributes every request to the route it was sent to'
)
assert(routed.turns[2].cost.model === 'deepseek-v4-flash', 'rebuilds a turn under its own model')
assert(routed.turns[2].wallMs === 700, 'falls back to the request span for turn wall time')
assert(ledger.turns[2].wallMs === 1, 'spans the chat step times when no request ledger exists')

/* ── what each kind of action costs ──────────────────────────────────────── */

const expectedTurnThreeStepOne = (1_000 * 0.27 + 3_000 * 0.0 + 500 * 1.1) / 1e6
const expectedTurnThreeStepTwo = (2_000 * 0.27 + 1_000 * 1.1) / 1e6
const categorySum = (categories) => categories.tools.usd + categories.reasoning.usd + categories.read.usd

assert(
  round(routed.totals.categories.tools.usd) === round(expectedTurnOne),
  'attributes the tool-calling request to «tools»'
)
assert(
  round(routed.totals.categories.reasoning.usd) === round(expectedTurnTwo + expectedTurnThreeStepOne),
  'attributes tool-less requests to «reasoning»'
)
assert(
  round(routed.totals.categories.read.usd) === round(expectedTurnThreeStepTwo),
  'treats an observation-only MCP call as reading'
)
assert(
  round(categorySum(routed.totals.categories)) === round(routed.totals.usd),
  'category shares add up to the total'
)
assert(routed.totals.categories.tools.requests === 1, 'counts requests per category')
assert(routed.totals.categories.read.tokens === 3_000, 'tracks tokens per category')
assert(
  round(routed.turns[0].categories.tools.usd) === round(expectedTurnOne),
  'carries the attribution per turn as well'
)
assert(routed.turns[2].categories.read.requests === 1, 'splits a rebuilt turn by action')
assert(
  routed.models.some((model) => model.model === 'deepseek-v4-pro'),
  'keeps the pro route in the model split'
)
assert(
  round(routed.totals.usd) === round(expectedTurnOne + expectedTurnTwo + expectedTurnThree),
  'prices the same money from the trajectory ledger'
)

const routedView = render(
  React.createElement(viewSlot.component, {
    t: ctx.locale.bind('cost'),
    useCost: mockUseCost(routed),
    useProjection: mockUseProjection(() => undefined),
    useSession: mockUseHook({ hasMore: false }),
    sessionId: 's1'
  })
)
assert(routedView.text.includes('deepseek-v4-flash'), 'the routed view names the flash route')
assert(routedView.text.includes('Запросов: 4'), 'the routed timeline counts the whole trajectory ledger')
assert(routedView.text.includes('Запросов'), 'the routed view counts requests')
assert(routedView.text.includes('Рейтинг: самые дорогие запросы'), 'the routed view ranks requests')

/* ── React rules of hooks ────────────────────────────────────────────────── */

// A component that skips a hook on one data state (early return before a hook) works
// on the happy path and then dies in the browser the first time it renders empty —
// exactly the bug that made the composer summary disappear after a page reload.
const unstable = [...hookCounts.entries()]
  .filter(([, counts]) => counts.size > 1)
  .map(([fn, counts]) => `${fn.name === '' ? 'anonymous' : fn.name}: ${[...counts].join('/')} hooks`)
if (unstable.length > 0) console.log('  unstable hook counts:', unstable)
assert(unstable.length === 0, 'every component calls a stable number of hooks in every data state')

console.log('\ndsh-cost-stats smoke: PASS')
