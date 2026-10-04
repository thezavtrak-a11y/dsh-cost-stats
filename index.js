/**
 * dsh-cost-stats — host half.
 *
 * Two jobs:
 *
 * 1. Exist as a package the loader can mount, so the client-modules scanner finds
 *    the `dsh.client` declaration and serves `lib/client.js` to the browser. That
 *    half owns every slot registration, the price table and the live ledger.
 *
 * 2. Serve one read-only route, `GET /cost-stats/series`, with a compact per-request
 *    row for the WHOLE durable session corpus. The browser only ever sees the
 *    conversation window it has paged in — hours at best — while the logs on disk
 *    hold days. This route is the bridge, and it is the only reason this half is not
 *    a no-op.
 *
 * Nothing upstream is patched and no file is written: the route reads
 * `$DSH_HOME/sessions/**\/*.jsonl.zstd` and answers with numbers. Pricing stays in
 * the browser (`PRICES` in `lib/client.js`), so this half sends tokens, never money.
 *
 * @module dsh-cost-stats
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Stable plugin name used by the cordis loader row. */
export const name = 'dsh-cost-stats'

/** The web server owns the route registry; without it this half has nothing to do. */
export const inject = ['webServer']

/** Route the browser reads the long-range series from. */
const ROUTE = '/cost-stats/series'
/** Route the browser reads the provider account balance from. */
const BALANCE_ROUTE = '/cost-stats/balance'
/**
 * Balance endpoint of the provider (DeepSeek's documented `user/balance`). The API
 * key never leaves this process: the browser only ever sees the resulting numbers.
 */
const BALANCE_URL = process.env.DSH_BALANCE_URL ?? 'https://api.deepseek.com/user/balance'
/** The balance moves slowly and costs a round trip; reuse one answer this long. */
const BALANCE_CACHE_MS = 60_000
/** A session log is a stream of independent zstd frames; this is their magic. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** How long one scan is reused before the next request triggers a fresh one. */
const CACHE_MS = 60_000
/** Guard against a runaway directory walk. */
const MAX_FILES = 2000

/**
 * Tools that only read and analyse. Kept in step with `READ_TOOLS` in
 * `lib/client.js`: a request whose every tool is listed here is `read`, a request
 * with no tools at all is `reasoning`, anything else is `tools`.
 */
const READ_TOOLS = new Set([
  'read', 'read_image', 'grep', 'glob', 'view', 'cat', 'ls', 'list', 'tree', 'search', 'find',
  'web_search', 'websearch', 'web_fetch', 'webfetch', 'fetch', 'recall',
  'tare_recall', 'tare_expand', 'tare_stats', 'tare_compact_lossy', 'tare_skeletonize', 'tare_memory_stats',
  'list_agents', 'list_windows', 'snapshot', 'screenshot', 'displayinventory', 'graphify',
  'search_sessions', 'session_read', 'get_goal', 'job_list', 'job_output', 'ask_user_question',
  'opencode_status', 'opencode_transcript', 'opencode_sessions'
])

const CATEGORY = { reasoning: 0, read: 1, tools: 2 }

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** The DSH home whose session logs are read. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Every `.jsonl.zstd` under one directory tree. */
function sessionFiles(dir, out = []) {
  if (out.length >= MAX_FILES) return out
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break
    const path = join(dir, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) sessionFiles(path, out)
    else if (entry.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

/**
 * Decode one session log. The file is a sequence of independent zstd frames and
 * `zstdDecompressSync` stops after the first, so the buffer is split on the frame
 * magic and every slice is decoded on its own.
 */
function readRecords(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  const records = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A torn line is skipped rather than failing the whole scan.
      }
    }
  }
  return records
}

/** Normalise a raw tool name (MCP names included) onto the read vocabulary. */
function isReadTool(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) return false
  const bare = rawName.includes('__') ? rawName.slice(rawName.lastIndexOf('__') + 2) : rawName
  const key = bare.toLowerCase()
  return READ_TOOLS.has(key) || READ_TOOLS.has(rawName.toLowerCase())
}

/** Classify one assistant message by the tools it asked for. */
function categorize(content) {
  if (!Array.isArray(content)) return CATEGORY.reasoning
  let sawTool = false
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
    sawTool = true
    if (!isReadTool(block.name)) return CATEGORY.tools
  }
  return sawTool ? CATEGORY.read : CATEGORY.reasoning
}

/**
 * Walk every session log and emit one row per billed model request:
 * `[timeMs, modelIndex, uncachedInput, cacheRead, cacheWrite, output, category]`.
 *
 * Yields to the event loop between files: this runs inside the same process as the
 * agent loop, and a synchronous multi-second scan would stall it.
 */
async function scan() {
  const files = sessionFiles(join(dshHome(), 'sessions'))
  const models = []
  const rows = []
  for (let index = 0; index < files.length; index += 1) {
    if (index % 4 === 0) await new Promise((resolve) => setImmediate(resolve))
    for (const record of readRecords(files[index])) {
      if (record.type !== 'assistant/message') continue
      const data = record.data
      if (data === null || data === undefined) continue
      const usage = data.usage
      if (usage === null || usage === undefined) continue
      const time = record.time
      if (typeof time !== 'number') continue
      const source = data.message === null || data.message === undefined ? undefined : data.message.source
      const model = source !== null && source !== undefined && typeof source.model === 'string' ? source.model : 'unknown'
      let modelIndex = models.indexOf(model)
      if (modelIndex === -1) {
        models.push(model)
        modelIndex = models.length - 1
      }
      rows.push([
        time,
        modelIndex,
        num(usage.inputTokens),
        num(usage.cacheReadTokens),
        num(usage.cacheWriteTokens),
        num(usage.outputTokens),
        categorize(data.message === null || data.message === undefined ? undefined : data.message.content)
      ])
    }
  }
  rows.sort((left, right) => left[0] - right[0])
  return {
    v: 1,
    generatedAt: Date.now(),
    sessions: files.length,
    records: rows.length,
    models,
    categories: CATEGORY,
    rows
  }
}

/**
 * Walk every session log and emit one row per billed model request.
 *
 * Exported so it can be exercised outside the running server
 * (`node tools/series-check.mjs`) — the HTTP route below is a thin wrapper.
 *
 * @returns the wire payload served at {@link ROUTE}.
 */
export async function scanSeries() {
  return scan()
}

/**
 * Read the provider API key for the balance call.
 *
 * Resolution order: the environment first, then DSH's own credential file, which
 * stores these refs in plain text (`refs: DEEPSEEK_API_KEY: sk-…`). The key is used
 * inside this process only and is never part of a response.
 */
function apiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
    return match === null ? undefined : match[1]
  } catch {
    return undefined
  }
}

/**
 * Ask the provider for the remaining account balance. Never returns the key.
 *
 * Exported alongside {@link scanSeries} so both host routes can be exercised without
 * a running server (`node tools/series-check.mjs --balance`).
 */
export async function readBalance() {
  const key = apiKey()
  if (key === undefined) return { available: false, error: 'no-credential' }
  let response
  try {
    response = await fetch(BALANCE_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    return { available: false, error: 'unreachable' }
  }
  if (!response.ok) return { available: false, error: 'http-' + String(response.status) }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { available: false, error: 'bad-json' }
  }
  const infos = payload !== null && payload !== undefined && Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  const info = infos.find((entry) => entry.currency === 'USD') ?? infos[0]
  if (info === undefined) return { available: false, error: 'no-balance-info' }
  return {
    available: payload.is_available === true,
    currency: info.currency,
    total: Number(info.total_balance),
    granted: Number(info.granted_balance),
    toppedUp: Number(info.topped_up_balance),
    fetchedAt: Date.now()
  }
}

/**
 * Mount the long-range series route.
 *
 * The route is loopback-only in practice (the web server binds locally) and
 * read-only; it answers 405 for anything but GET/HEAD and never throws at the
 * caller — a failed scan is a logged 500, not a broken server.
 *
 * @param ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  let cache = null
  let inFlight = null
  const series = async () => {
    const now = Date.now()
    if (cache !== null && now - cache.at < CACHE_MS) return cache.payload
    if (inFlight !== null) return inFlight
    inFlight = scan()
      .then((payload) => {
        cache = { at: Date.now(), payload }
        return payload
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
  let balanceCache = null
  let balanceInFlight = null
  const balance = async () => {
    const now = Date.now()
    if (balanceCache !== null && now - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.payload
    if (balanceInFlight !== null) return balanceInFlight
    balanceInFlight = readBalance()
      .then((payload) => {
        // Only a real answer is worth caching: a 502 must be retried on the next ask.
        if (payload.error === undefined) balanceCache = { at: Date.now(), payload }
        return payload
      })
      .finally(() => {
        balanceInFlight = null
      })
    return balanceInFlight
  }

  const respond = (res, method, work, failure) => {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    work()
      .then((payload) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store'
        })
        res.end(method === 'HEAD' ? undefined : body)
      })
      .catch((error) => {
        ctx.logger.warn('dsh-cost-stats: ' + failure, error)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"error":"' + failure + '"}')
      })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: (req, res) => respond(res, req.method, series, 'scan-failed') }),
    'dsh-cost-stats: ' + ROUTE + ' route'
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: BALANCE_ROUTE, handler: (req, res) => respond(res, req.method, balance, 'balance-failed') }),
    'dsh-cost-stats: ' + BALANCE_ROUTE + ' route'
  )
}
