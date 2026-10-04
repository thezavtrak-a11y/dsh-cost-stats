/**
 * audit-public.mjs — the pre-publish gate.
 *
 * Two scopes, because the payload and the development tools are held to
 * different standards:
 *
 *   payload — what a user actually installs (`index.js`, `lib/**`,
 *             `cordis.patch.yml`, `package.json`). It must carry no personal data
 *             AND no code or HTML injection, no clipboard access, no raw
 *             transport, and no storage: this plugin counts tokens and money, it
 *             has no business doing any of that.
 *   repo    — everything tracked in the repository. No personal paths, e-mail
 *             addresses, tokens or keys may be published, in code or in docs.
 *
 * `fetch` is the one network primitive the payload is allowed to use, and only
 * where the DECLARED table below says so, with a stated reason. Both halves stay
 * inside the machine:
 *
 *   - `lib/client.js` (browser half) fetches ONLY this plugin's own host routes
 *     on the page origin — `/cost-stats/series` and `/cost-stats/balance` — i.e.
 *     the local DSH web server at 127.0.0.1 that served the page. Each call is
 *     guarded by `typeof fetch !== 'function'` and falls back to the loaded
 *     conversation history when the route is absent. It never contacts the
 *     internet.
 *   - `index.js` (host half) makes exactly one outbound request in the whole
 *     plugin: the provider's documented `user/balance` endpoint, so the browser
 *     never sees the API key. That single call is why `fetch` is declared here
 *     instead of being banned outright; the endpoint is overridable with
 *     `DSH_BALANCE_URL`, and nothing else in the payload leaves the process.
 *
 * Storage is NOT declared: `DECLARED` carries no storage row, so a single
 * `localStorage.` / `sessionStorage.` / `indexedDB.` in the payload fails the
 * gate. The drawing-free state this plugin keeps lives in React state and host
 * memory, which is exactly what its caches are.
 *
 * Findings are printed with a redacted excerpt; the process exits non-zero when
 * anything is found, so this can gate a release.
 *
 * The script names the patterns it forbids, so it excludes itself from the scan.
 *
 * Usage:  node tools/audit-public.mjs [--root <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`)
	return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}
const root = flag('root', packageRoot)

/** Files that make up the installed payload. `lib/**` is added by prefix. */
const PAYLOAD = ['index.js', 'cordis.patch.yml', 'package.json']

/** Text extensions worth scanning. */
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.ts'])

/**
 * Material that stays on the author's machine (see `.gitignore`). Git already
 * hides it when the repository exists; the fallback walk has no git to ask, so
 * the names are repeated here.
 */
const LOCAL_ONLY = new Set(['HANDOFF.md'])

/** Patterns that must never appear in the payload, anywhere, at all. */
const HARD = [
	{ name: 'code injection', pattern: /\b(?:eval|new Function|document\.write)\b|dangerouslySetInnerHTML|\.innerHTML\s*=/g },
	{ name: 'cookies', pattern: /document\.cookie/g },
	{ name: 'clipboard API', pattern: /navigator\.clipboard/g },
	{ name: 'raw transport', pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/g }
]

/**
 * Rules that are allowed only where this table declares them, with a count and a
 * reason. A file/rule pair with more matches than declared fails the gate; a
 * declaration with no matches left behind is reported as stale.
 */
const DECLARED = [
	{
		file: 'index.js',
		rule: 'fetch',
		count: 1,
		reason:
			'host half: the one outbound call in the plugin — the provider\'s documented `user/balance` endpoint, made in this process so the API key never reaches the browser (override: DSH_BALANCE_URL)'
	},
	{
		file: 'lib/client.js',
		rule: 'fetch',
		count: 2,
		reason:
			'browser half: both calls read this plugin\'s own host routes on the page origin (`/cost-stats/balance`, `/cost-stats/series`) — the local DSH server that served the page, never the internet'
	}
]

/** The declared rule patterns themselves. */
const DECLARABLE = [
	{ rule: 'fetch', name: 'network call', pattern: /\bfetch\s*\(/g },
	{ rule: 'storage', name: 'storage write', pattern: /\b(?:localStorage|sessionStorage|indexedDB)\s*\./g }
]

/** Patterns that must never be published, in either scope. */
const PERSONAL = [
	{ name: 'Windows user path', pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g },
	{ name: 'POSIX home path', pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g },
	{ name: 'e-mail address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
	{ name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
	{ name: 'OpenAI-style key', pattern: /sk-[A-Za-z0-9_-]{16,}/g },
	{ name: 'bearer credential', pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/g },
	{ name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ name: 'assigned secret', pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{6,}["']/gi }
]

/** Every file the repository would publish. */
function trackedFiles() {
	try {
		const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return out.split('\0').filter((value) => value !== '')
	} catch (error) {
		console.log('note: not a git repository yet — scanning the working tree, minus .gitignore local material')
		return null
	}
}

/** Fallback listing when the directory is not a git repository yet. */
function walk(directory, found = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === '.git' || entry.name === 'node_modules' || LOCAL_ONLY.has(entry.name)) continue
		const path = join(directory, entry.name)
		if (entry.isDirectory()) walk(path, found)
		else found.push(relative(root, path).split(sep).join('/'))
	}
	return found
}

/** Redact a finding so the report itself leaks nothing. */
function redact(text) {
	const clean = text.trim()
	return clean.length <= 12 ? clean : `${clean.slice(0, 6)}…${clean.slice(-3)}`
}

const files = trackedFiles() ?? walk(root)
const findings = []
/** file|rule → how many matches the payload actually carries. */
const actual = new Map()

/** Scan one file for one rule set. */
function scanFile(file, rules, scope) {
	const path = join(root, file)
	if (!existsSync(path) || statSync(path).isDirectory()) return
	if (!TEXT.has(extname(file))) return
	if (file.endsWith('tools/audit-public.mjs')) return
	const text = readFileSync(path, 'utf8')
	const lines = text.split('\n')
	for (const rule of rules) {
		for (const match of text.matchAll(rule.pattern)) {
			const lineNumber = text.slice(0, match.index).split('\n').length
			if (scope === 'declared') {
				const key = `${file}|${rule.rule}`
				actual.set(key, (actual.get(key) ?? 0) + 1)
				continue
			}
			findings.push({ file, line: lineNumber, scope, rule: rule.name, excerpt: redact(lines[lineNumber - 1] ?? match[0]) })
		}
	}
}

/* The payload exists and is what the manifest says it is. */
const missing = PAYLOAD.filter((file) => !existsSync(join(root, file)))
for (const file of missing) findings.push({ file, line: 0, scope: 'payload', rule: 'expected payload file is missing', excerpt: file })

for (const file of files) {
	const isPayload = PAYLOAD.includes(file) || file.startsWith('lib/')
	/* Personal data is forbidden everywhere; payload safety only in the payload. */
	scanFile(file, PERSONAL, isPayload ? 'payload' : 'repo')
	if (isPayload) {
		scanFile(file, HARD, 'payload')
		scanFile(file, DECLARABLE, 'declared')
	}
}

/* Every declared match must be covered by the table; more than declared fails. */
const declared = new Map(DECLARED.map((entry) => [`${entry.file}|${entry.rule}`, entry]))
const stale = []
for (const [key, count] of actual) {
	/* Keys are `file|rule`; a file name cannot contain the separator. */
	const [file, rule] = key.split('|')
	const entry = declared.get(key)
	if (entry === undefined) {
		findings.push({ file, line: 0, scope: 'payload', rule: `undeclared ${rule} call`, excerpt: `${count} match(es), no DECLARED row` })
		continue
	}
	if (count > entry.count) {
		findings.push({ file, line: 0, scope: 'payload', rule: `more ${entry.rule} calls than declared`, excerpt: `${count} found, ${entry.count} declared` })
	}
}
for (const entry of DECLARED) {
	const count = actual.get(`${entry.file}|${entry.rule}`) ?? 0
	if (count < entry.count) stale.push({ entry, count })
}

const scanned = files.filter((file) => TEXT.has(extname(file)) && !file.endsWith('tools/audit-public.mjs'))
console.log(`dsh-cost-stats · pre-publish audit`)
console.log(`root: ${root}`)
console.log(`files: ${files.length} tracked, ${scanned.length} text files scanned (payload: ${PAYLOAD.join(', ')}, lib/**)`)
console.log(`rules: ${PERSONAL.length} personal-data, ${HARD.length} payload-safety, ${DECLARABLE.length} declarable`)

console.log('\ndeclared payload API uses — allowed only here, with a reason:')
for (const entry of DECLARED) {
	const count = actual.get(`${entry.file}|${entry.rule}`) ?? 0
	console.log(`  ${entry.file}  ${entry.rule} × ${count}/${entry.count}`)
	console.log(`    ${entry.reason}`)
}
const storageDeclared = DECLARED.some((entry) => entry.rule === 'storage')
if (!storageDeclared) console.log('  storage (localStorage / sessionStorage / indexedDB): 0 declared — any use fails the gate')

for (const item of stale) {
	console.log(`\nnote: stale declaration — ${item.entry.file} declares ${item.entry.rule} × ${item.entry.count}, found ${item.count}`)
}

if (findings.length === 0) {
	console.log('\nRESULT: clean — no personal data, no injection/transport/storage in the payload, every fetch declared')
	process.exitCode = 0
} else {
	console.log('')
	for (const finding of findings) {
		console.log(`  ${finding.scope === 'payload' ? 'PAYLOAD' : 'repo   '} ${finding.file}:${finding.line}  ${finding.rule}  «${finding.excerpt}»`)
	}
	console.log(`\nRESULT: ${findings.length} finding(s) — do not publish until they are gone`)
	process.exitCode = 1
}
