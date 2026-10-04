window.__ModuleLoader__.load({
	id: 'dsh-cost-stats',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const e = react.createElement;
		const useState = react.useState;
		const useMemo = react.useMemo;
		const useSyncExternalStore = react.useSyncExternalStore;
		/** The shell's icon set: the same outline pictograms the chat row itself uses. */
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		/** Portals, for the one layer that must escape the chat's stacking contexts. */
		let reactDom = null;
		try {
			reactDom = require('react-dom');
		} catch (error) {
			reactDom = null;
		}

		/**
		 * Render children into `document.body` instead of the current position.
		 *
		 * The chat wraps every message row in its own stacking context, so a panel
		 * positioned inside the action row is painted under the rows that follow it — the
		 * cost breakdown used to sink beneath the next message and the composer. A portal
		 * escapes every ancestor context and `overflow` clip at once. Without a DOM (the
		 * smoke test) or without `react-dom`, children render in place, which is only a
		 * cosmetic difference.
		 */
		function FloatingLayer(props) {
			if (reactDom === null || typeof reactDom.createPortal !== 'function') return props.children;
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return props.children;
			return reactDom.createPortal(props.children, document.body);
		}

		/**
		 * Render one shell icon, degrading to its first letter rather than crashing
		 * when the icon set does not carry the glyph (an unknown name is `undefined`,
		 * and React treats `undefined` as an invalid element type).
		 */
		function iconOf(name, fallback, size) {
			const Icon = primitives === null || primitives === undefined ? undefined : primitives[name];
			if (typeof Icon === 'function' || (typeof Icon === 'object' && Icon !== null)) {
				return e(Icon, { size: size, 'data-icon': name });
			}
			return e('span', { 'data-icon': 'missing:' + name, 'aria-hidden': true }, fallback);
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  1. ТАРИФЫ / PRICES — USD per 1,000,000 tokens.
		 *
		 *  DSH reports provider token counts but never a monetary amount, so the
		 *  dollar figures in this plugin are computed HERE. EDIT THIS TABLE to
		 *  match your plan; nothing else has to change.
		 *
		 *    miss  — uncached prompt input
		 *    hit   — prompt input served from the provider cache (cache read)
		 *    write — prompt input written into the provider cache
		 *    out   — completion output (reasoning tokens are a SUBSET of out)
		 *
		 *  CALIBRATION — verified against the provider's own billing export.
		 *
		 *  A `usage_data_<day>.zip` export carries, per model and hour, both the token
		 *  counts and the price charged for each of them (`amount-*.csv`) plus the
		 *  resulting bill (`cost-*.csv`). One hour of `deepseek-v4-pro` read:
		 *
		 *    output_tokens          64 778  @ 0.00000396 /token  =  3.96 $/M
		 *    input_cache_miss      701 698  @ 0.00000132 /token  =  1.32 $/M
		 *    input_cache_hit    17 558 272  @ 0.000000044/token  =  0.044 $/M
		 *    bill                 1.955326208 USD
		 *
		 *  Those three rates reproduce that bill to the cent on those token counts, and
		 *  the `deepseek-v4-pro` row below is exactly them. Two corrections to what this
		 *  table used to assume:
		 *
		 *  1. Cache reads ARE charged (0.044 $/M here). An earlier revision had
		 *     `hit: 0`, inferred from an account total that turned out to span other
		 *     keys and plans; the export is direct billing and settles it.
		 *  2. The platform's miss/output rates are not the published DeepSeek ones:
		 *     roughly 2.4x and 1.8x higher, which made every figure this plugin showed
		 *     about 4x too low for this model.
		 *
		 *  Verified for `deepseek-v4-pro` only. The flash family keeps the published
		 *  rates and is **unverified**: feed an hour of a flash export through
		 *  `tools/verify-billing.mjs` and set its row the same way. `write` has no line
		 *  of its own — a cache write is billed as a miss, hence `write: miss`.
		 * ════════════════════════════════════════════════════════════════════ */
		const PRICES = {
			'deepseek-v4-pro': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
			'deepseek-reasoner': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
			'deepseek-v4-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
			'deepseek-v4-flash-vision-exp': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
			'deepseek-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
			'deepseek-chat': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }
		};
		const FALLBACK_PRICE = { miss: 0.27, hit: 0, write: 0.27, out: 1.1 };
		/**
		 * Models that run on this machine (LM Studio / Bionic) have no per-token price
		 * at all, so they must not inherit the fallback row: an unpriced cloud model is
		 * an unknown, a local one is genuinely free.
		 */
		const FREE_MODEL_HINTS = ['ornith', 'qwen', 'lmstudio', 'bionic', 'local'];
		const FREE_PRICE = { miss: 0, hit: 0, write: 0, out: 0 };

		/** Resolve one model id to a price row, degrading to the family default. */
		function priceFor(model) {
			if (typeof model !== 'string' || model.length === 0) return FALLBACK_PRICE;
			const id = model.toLowerCase();
			for (const hint of FREE_MODEL_HINTS) if (id.includes(hint)) return FREE_PRICE;
			if (PRICES[id] !== undefined) return PRICES[id];
			const keys = Object.keys(PRICES);
			for (const key of keys) if (id.startsWith(key) || key.startsWith(id)) return PRICES[key];
			if (id.includes('pro') || id.includes('reason')) return PRICES['deepseek-v4-pro'];
			if (id.includes('flash') || id.includes('chat')) return PRICES['deepseek-v4-flash'];
			return FALLBACK_PRICE;
		}

		/** Provider/model attribution of one turn's billed attempts. */
		function routeOf(usage) {
			const routes = usage === null || usage === undefined ? undefined : usage.routes;
			if (Array.isArray(routes) && routes.length > 0) {
				const first = routes[0];
				return {
					model: typeof first.model === 'string' && first.model.length > 0 ? first.model : 'unknown',
					provider: typeof first.provider === 'string' ? first.provider : '',
					mixed: routes.length > 1
				};
			}
			return { model: 'unknown', provider: '', mixed: false };
		}

		/** Exact positive number, or 0 — every token bucket is a non-negative count. */
		function num(value) {
			return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
		}

		/** Price one turn's provider-reported buckets. */
		function costOfUsage(usage, model) {
			const price = priceFor(model);
			const miss = num(usage === null || usage === undefined ? 0 : usage.uncachedInputTokens);
			const hit = num(usage === null || usage === undefined ? 0 : usage.cacheReadTokens);
			const write = num(usage === null || usage === undefined ? 0 : usage.cacheWriteTokens);
			const out = num(usage === null || usage === undefined ? 0 : usage.outputTokens);
			const reasoning = num(usage === null || usage === undefined ? 0 : usage.reasoningTokens);
			const usdMiss = (miss * price.miss) / 1e6;
			const usdHit = (hit * price.hit) / 1e6;
			const usdWrite = (write * price.write) / 1e6;
			const usdOut = (out * price.out) / 1e6;
			return {
				model,
				price,
				tokens: { miss, hit, write, out, reasoning, total: miss + hit + write + out },
				usd: { miss: usdMiss, hit: usdHit, write: usdWrite, out: usdOut, total: usdMiss + usdHit + usdWrite + usdOut }
			};
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  2. Формат / formatters
		 * ════════════════════════════════════════════════════════════════════ */
		function trimNumber(value) {
			if (value >= 100) return value.toFixed(0);
			if (value >= 10) return value.toFixed(1);
			return value.toFixed(2);
		}

		function fmtTokens(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
			const n = Math.abs(value);
			if (n < 1000) return String(Math.round(value));
			if (n < 1e6) return trimNumber(value / 1e3) + 'k';
			return trimNumber(value / 1e6) + 'M';
		}

		/**
		 * Money: the leading zero stays (`$0.2352`, not `$.2352`), trailing zeros go
		 * (`$0.0010` reads `$0.001`). At least two decimals are kept, so half a dollar
		 * is `$0.50`.
		 */
		function fmtUsd(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
			if (value === 0) return '$0';
			if (value < 0.00005) return '$' + value.toExponential(1);
			if (value < 1) {
				let digits = value.toFixed(4).slice(2);
				while (digits.length > 2 && digits.endsWith('0')) digits = digits.slice(0, -1);
				return '$0.' + digits;
			}
			if (value < 100) {
				let text = value.toFixed(3);
				while (text.endsWith('0') && text.length - text.indexOf('.') - 1 > 2) text = text.slice(0, -1);
				return '$' + text;
			}
			return '$' + value.toFixed(2);
		}

		function fmtDuration(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
			if (ms < 1000) return Math.round(ms) + ' мс';
			if (ms < 60000) return trimNumber(ms / 1000) + ' с';
			const minutes = Math.floor(ms / 60000);
			const seconds = Math.round((ms % 60000) / 1000);
			return minutes + ' мин ' + seconds + ' с';
		}

		function fmtTps(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
			return trimNumber(value) + ' ток/с';
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  3. Свёртка / derivation over the Chat target
		 * ════════════════════════════════════════════════════════════════════ */
		const EMPTY_TOTALS = Object.freeze({
			usd: 0,
			miss: 0,
			hit: 0,
			write: 0,
			out: 0,
			reasoning: 0,
			tokens: 0,
			usdMiss: 0,
			usdHit: 0,
			usdWrite: 0,
			usdOut: 0,
			requests: 0,
			wallMs: 0,
			timedTurns: 0,
			cacheHitPercent: null
		});
		const EMPTY_STATS = Object.freeze({
			turns: [],
			byTurn: new Map(),
			byMessage: new Map(),
			requests: [],
			tools: [],
			models: [],
			totals: EMPTY_TOTALS,
			nodes: 0,
			blend: FALLBACK_PRICE
		});

		/**
		 * Tools whose requests read data and analyse it rather than changing anything.
		 * A request is attributed to `read` only when every tool it called is listed
		 * here; one mutating or acting tool makes the whole request `tools`.
		 */
		const READ_TOOLS = Object.freeze({
			read: true,
			read_image: true,
			grep: true,
			glob: true,
			view: true,
			cat: true,
			ls: true,
			list: true,
			tree: true,
			search: true,
			find: true,
			web_search: true,
			websearch: true,
			web_fetch: true,
			webfetch: true,
			fetch: true,
			recall: true,
			tare_recall: true,
			tare_expand: true,
			tare_stats: true,
			tare_compact_lossy: true,
			tare_skeletonize: true,
			tare_memory_stats: true,
			list_agents: true,
			list_windows: true,
			snapshot: true,
			screenshot: true,
			displayinventory: true,
			graphify: true,
			search_sessions: true,
			session_read: true,
			get_goal: true,
			job_list: true,
			job_output: true,
			ask_user_question: true,
			opencode_status: true,
			opencode_transcript: true,
			opencode_sessions: true
		});

		/** One action category's share of the spend. */
		function emptyCategory() {
			return { usd: 0, tokens: 0, requests: 0 };
		}

		/** Normalize a raw tool name onto the read/analysis vocabulary above. */
		function isReadTool(name) {
			if (typeof name !== 'string') return false;
			const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
			return READ_TOOLS[bare.toLowerCase()] === true || READ_TOOLS[name.toLowerCase()] === true;
		}

		/**
		 * Attribute one request to the kind of action it performed: a request that
		 * called no tool is thinking, one that only read data is reading/analysis,
		 * and anything else is acting through tools.
		 */
		function categorize(toolNames) {
			if (toolNames === undefined || toolNames.size === 0) return 'reasoning';
			for (const name of toolNames) if (!isReadTool(name)) return 'tools';
			return 'read';
		}

		/** Tool name of one call block, whichever lifecycle variant it is. */
		function toolNameOf(block) {
			if (block === null || typeof block !== 'object') return null;
			if (block.kind === 'tool-result') {
				if (block.call !== null && block.call !== undefined && typeof block.call.name === 'string') return block.call.name;
				return null;
			}
			return typeof block.name === 'string' && block.name.length > 0 ? block.name : null;
		}

		/** Accumulate one tool call tree (root plus every nested dispatch). */
		function collectTool(block, acc) {
			if (block === null || typeof block !== 'object') return;
			const name = toolNameOf(block);
			if (name !== null) {
				let record = acc.get(name);
				if (record === undefined) {
					record = { name, calls: 0, ms: 0, errors: 0 };
					acc.set(name, record);
				}
				record.calls += 1;
				if (block.kind === 'tool-result') {
					if (block.isError === true) record.errors += 1;
					if (typeof block.callTime === 'number' && typeof block.time === 'number' && block.time >= block.callTime) {
						record.ms += block.time - block.callTime;
					}
				}
			}
			const sub = block.subCalls;
			if (Array.isArray(sub)) for (const child of sub) collectTool(child, acc);
		}

		/** Every tool name in one call tree, without timing bookkeeping. */
		function collectToolNames(block, acc) {
			if (block === null || typeof block !== 'object') return;
			const name = toolNameOf(block);
			if (name !== null) acc.add(name);
			const sub = block.subCalls;
			if (Array.isArray(sub)) for (const child of sub) collectToolNames(child, acc);
		}

		/** `turn:step` identity of one tool-call node, from its Location or its call head. */
		function stepKeyOf(node, data) {
			const location = node === null || node === undefined ? undefined : node.location;
			if (location !== null && location !== undefined && location.kind === 'step') {
				const turn = location.turn === null || location.turn === undefined ? undefined : location.turn.turn;
				const step = location.step === null || location.step === undefined ? undefined : location.step.step;
				if (typeof turn === 'number' && typeof step === 'number') return String(turn) + ':' + String(step);
			}
			const root = data === null || data === undefined ? undefined : data.root;
			if (
				root !== null &&
				root !== undefined &&
				typeof root.turn === 'number' &&
				typeof root.step === 'number'
			) {
				return String(root.turn) + ':' + String(root.step);
			}
			return null;
		}

		/** Provider usage object normalized to the four disjoint billed buckets. */
		function normalizeUsage(raw) {
			if (raw === null || typeof raw !== 'object') return null;
			const miss = num(raw.inputTokens !== undefined ? raw.inputTokens : raw.uncachedInputTokens);
			const hit = num(raw.cacheReadTokens);
			const write = num(raw.cacheWriteTokens);
			const out = num(raw.outputTokens);
			const reasoning = num(raw.reasoningTokens);
			if (miss + hit + write + out === 0) return null;
			return {
				uncachedInputTokens: miss,
				cacheReadTokens: hit,
				cacheWriteTokens: write,
				outputTokens: out,
				reasoningTokens: reasoning
			};
		}

		/** Route reported for one settled assistant step, when the projection carries it. */
		function routeOfStep(data) {
			const final = data === null || data === undefined ? undefined : data.finalNode;
			if (final !== null && final !== undefined) {
				const config = final.requestConfig;
				if (config !== null && config !== undefined && typeof config.model === 'string' && config.model.length > 0) {
					return { provider: typeof config.provider === 'string' ? config.provider : '', model: config.model };
				}
				const provenance = final.provenance;
				if (provenance !== null && provenance !== undefined && typeof provenance.model === 'string' && provenance.model.length > 0) {
					return { provider: typeof provenance.provider === 'string' ? provenance.provider : '', model: provenance.model };
				}
			}
			return null;
		}

		/** Route of one trajectory request row: effective prompt config first, then provenance. */
		function routeOfRequest(request) {
			const config = request.requestConfig;
			if (config !== null && config !== undefined && typeof config.model === 'string' && config.model.length > 0) {
				return { provider: typeof config.provider === 'string' ? config.provider : '', model: config.model };
			}
			const provenance = request.provenance;
			if (
				provenance !== null &&
				provenance !== undefined &&
				typeof provenance.model === 'string' &&
				provenance.model.length > 0
			) {
				return { provider: typeof provenance.provider === 'string' ? provenance.provider : '', model: provenance.model };
			}
			const prompt = request.prompt;
			const promptConfig = prompt === null || prompt === undefined ? undefined : prompt.config;
			if (
				promptConfig !== null &&
				promptConfig !== undefined &&
				typeof promptConfig.model === 'string' &&
				promptConfig.model.length > 0
			) {
				return {
					provider: typeof promptConfig.provider === 'string' ? promptConfig.provider : '',
					model: promptConfig.model
				};
			}
			return { provider: '', model: 'unknown' };
		}

		/** Costliest model of one per-turn model→USD map. */
		function dominantModel(usdByModel) {
			let best = 'unknown';
			let seen = -1;
			for (const entry of usdByModel) {
				if (entry[1] > seen) {
					seen = entry[1];
					best = entry[0];
				}
			}
			return best;
		}

		/**
		 * Fold one Chat snapshot into the cost ledger: every billed request, every
		 * turn, every tool call, and the model split.
		 *
		 * A turn's exact per-turn accounting (`turn-tail.tokenUsage`, provider
		 * reported for the whole turn) is preferred; when the loaded window cannot
		 * prove it, the turn is rebuilt by summing its settled `assistant-step`
		 * usages and flagged `approximate`.
		 *
		 * Pure and cheap enough to memoize by snapshot identity.
		 */
		function deriveStats(chat, trajectory) {
			if (chat === null || chat === undefined) return EMPTY_STATS;
			const order = Array.isArray(chat.order) ? chat.order : [];
			const store = chat.nodes;
			const timeline = chat.timeline;
			const turnsMap = timeline !== null && timeline !== undefined ? timeline.turns : undefined;
			const turnOrder =
				timeline !== null && timeline !== undefined && Array.isArray(timeline.turnOrder) ? timeline.turnOrder : [];
			const exactByTurn = new Map();
			const messageByTurn = new Map();
			const tools = new Map();
			const toolsByStep = new Map();
			const requests = [];
			const fallbackRequests = [];
			let nodes = 0;

			// One row per billed model request, from the trajectory target: unlike the
			// chat rows it carries the exact provider usage AND the route the request
			// was actually sent to, which is what prices a request correctly.
			if (Array.isArray(trajectory)) {
				for (const request of trajectory) {
					if (request === null || typeof request !== 'object' || request.purpose !== 'assistant') continue;
					const usage = normalizeUsage(request.usage);
					if (usage === null) continue;
					const route = routeOfRequest(request);
					requests.push({
						turn: typeof request.turn === 'number' ? request.turn : -1,
						step: typeof request.step === 'number' ? request.step : -1,
						time: typeof request.startedAt === 'number' ? request.startedAt : 0,
						completedAt: typeof request.completedAt === 'number' ? request.completedAt : undefined,
						model: route.model,
						provider: route.provider,
						cost: costOfUsage(usage, route.model)
					});
				}
			}

			for (const key of order) {
				if (store === null || store === undefined || typeof store.get !== 'function') continue;
				const node = store.get(key);
				if (node === null || node === undefined) continue;
				nodes += 1;
				const data = node.data;
				if (node.kind === 'turn-tail') {
					// Every completed turn records its closing assistant message here, so the
					// message-scoped action entry can find the turn that owns it.
					const closing = data === null || data === undefined ? undefined : data.closing;
					const finalNode = closing === null || closing === undefined ? undefined : closing.finalNode;
					if (finalNode !== null && finalNode !== undefined && typeof finalNode.messageId === 'string') {
						messageByTurn.set(data.turn, finalNode.messageId);
					}
					const usage = data === null || data === undefined ? undefined : data.tokenUsage;
					if (usage === null || usage === undefined) continue;
					exactByTurn.set(data.turn, { usage, ttftMs: data.ttftMs, tps: data.tokensPerSecond });
				} else if (node.kind === 'tool-call') {
					const root = data === null || data === undefined ? undefined : data.root;
					collectTool(root, tools);
					const stepKey = stepKeyOf(node, data);
					if (stepKey !== null) {
						let names = toolsByStep.get(stepKey);
						if (names === undefined) {
							names = new Set();
							toolsByStep.set(stepKey, names);
						}
						collectToolNames(root, names);
					}
				} else if (node.kind === 'assistant-step') {
					// Fallback only: used when no trajectory target supplied the ledger.
					if (data === null || data === undefined) continue;
					const final = data.finalNode;
					const usage = normalizeUsage(
						data.usage !== undefined ? data.usage : final !== null && final !== undefined ? final.usage : undefined
					);
					if (usage === null) continue;
					const route = routeOfStep(data);
					const model = route === null ? 'unknown' : route.model;
					fallbackRequests.push({
						turn: data.turn,
						step: data.step,
						time: data.time,
						completedAt: typeof data.time === 'number' ? data.time : undefined,
						model,
						provider: route === null ? '' : route.provider,
						cost: costOfUsage(usage, model)
					});
				}
			}
			if (requests.length === 0) for (const request of fallbackRequests) requests.push(request);
			requests.sort((left, right) => left.turn - right.turn || left.step - right.step);

			// Attribute every request to the kind of action it performed, then fold the
			// attribution per turn and per session.
			for (const request of requests) {
				request.category = categorize(toolsByStep.get(String(request.turn) + ':' + String(request.step)));
			}

			// Per-turn rebuilding from the request ledger, used when the exact
			// per-turn accounting is not inside the loaded window.
			const requestsByTurn = new Map();
			for (const request of requests) {
				let bucket = requestsByTurn.get(request.turn);
				if (bucket === undefined) {
					bucket = {
						usage: {
							uncachedInputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							reasoningTokens: 0
						},
						usdByModel: new Map(),
						requests: 0,
						firstStart: undefined,
						lastEnd: undefined,
						categories: { reasoning: emptyCategory(), read: emptyCategory(), tools: emptyCategory() }
					};
					requestsByTurn.set(request.turn, bucket);
				}
				if (typeof request.time === 'number' && request.time > 0) {
					if (bucket.firstStart === undefined || request.time < bucket.firstStart) bucket.firstStart = request.time;
				}
				if (typeof request.completedAt === 'number') {
					if (bucket.lastEnd === undefined || request.completedAt > bucket.lastEnd) bucket.lastEnd = request.completedAt;
				}
				bucket.usage.uncachedInputTokens += request.cost.tokens.miss;
				bucket.usage.cacheReadTokens += request.cost.tokens.hit;
				bucket.usage.cacheWriteTokens += request.cost.tokens.write;
				bucket.usage.outputTokens += request.cost.tokens.out;
				bucket.usage.reasoningTokens += request.cost.tokens.reasoning;
				bucket.usdByModel.set(request.model, (bucket.usdByModel.get(request.model) || 0) + request.cost.usd.total);
				bucket.requests += 1;
				const category = bucket.categories[request.category];
				category.usd += request.cost.usd.total;
				category.tokens += request.cost.tokens.total;
				category.requests += 1;
			}

			const turnNumbers = [];
			const seenTurn = new Set();
			const consider = (turn) => {
				if (seenTurn.has(turn)) return;
				seenTurn.add(turn);
				turnNumbers.push(turn);
			};
			for (const turn of turnOrder) if (exactByTurn.has(turn) || requestsByTurn.has(turn)) consider(turn);
			for (const turn of exactByTurn.keys()) consider(turn);
			for (const turn of requestsByTurn.keys()) consider(turn);
			turnNumbers.sort((left, right) => left - right);

			const turns = [];
			for (const turnNumber of turnNumbers) {
				const exact = exactByTurn.get(turnNumber);
				const bucket = requestsByTurn.get(turnNumber);
				let usage;
				let model;
				let provider = '';
				let mixed = false;
				let approximate = false;
				if (exact !== undefined) {
					const route = routeOf(exact.usage);
					usage = exact.usage;
					model = route.model;
					provider = route.provider;
					mixed = route.mixed;
				} else if (bucket !== undefined) {
					usage = bucket.usage;
					model = dominantModel(bucket.usdByModel);
					mixed = bucket.usdByModel.size > 1;
					approximate = true;
				} else {
					continue;
				}
				const cost = costOfUsage(usage, model);
				const location =
					turnsMap !== undefined && typeof turnsMap.get === 'function' ? turnsMap.get(turnNumber) : undefined;
				const startTime = location !== undefined && location.start !== undefined ? location.start.time : undefined;
				const endTime = location !== undefined && location.end !== undefined ? location.end.time : undefined;
				// Turn wall time prefers the engine's own turn boundaries; when the loaded
				// window no longer carries them, the request span is the honest substitute.
				let wallMs =
					typeof startTime === 'number' && typeof endTime === 'number' ? Math.max(0, endTime - startTime) : undefined;
				if (
					wallMs === undefined &&
					bucket !== undefined &&
					typeof bucket.firstStart === 'number' &&
					typeof bucket.lastEnd === 'number' &&
					bucket.lastEnd >= bucket.firstStart
				) {
					wallMs = bucket.lastEnd - bucket.firstStart;
				}
				turns.push({
					turn: turnNumber,
					cost,
					provider,
					mixed,
					approximate,
					requests: bucket === undefined ? 0 : bucket.requests,
					ttftMs: exact === undefined ? undefined : exact.ttftMs,
					tps: exact === undefined ? undefined : exact.tps,
					wallMs,
					categories:
						bucket === undefined
							? { reasoning: emptyCategory(), read: emptyCategory(), tools: emptyCategory() }
							: bucket.categories
				});
			}

			const modelMap = new Map();
			const totals = {
				usd: 0,
				miss: 0,
				hit: 0,
				write: 0,
				out: 0,
				reasoning: 0,
				tokens: 0,
				usdMiss: 0,
				usdHit: 0,
				usdWrite: 0,
				usdOut: 0,
				requests: requests.length,
				wallMs: 0,
				timedTurns: 0,
				cacheHitPercent: null,
				categories: { reasoning: emptyCategory(), read: emptyCategory(), tools: emptyCategory() }
			};
			let cacheable = 0;
			let cached = 0;
			for (const turn of turns) {
				totals.usd += turn.cost.usd.total;
				totals.miss += turn.cost.tokens.miss;
				totals.hit += turn.cost.tokens.hit;
				totals.write += turn.cost.tokens.write;
				totals.out += turn.cost.tokens.out;
				totals.reasoning += turn.cost.tokens.reasoning;
				totals.tokens += turn.cost.tokens.total;
				totals.usdMiss += turn.cost.usd.miss;
				totals.usdHit += turn.cost.usd.hit;
				totals.usdWrite += turn.cost.usd.write;
				totals.usdOut += turn.cost.usd.out;
				if (turn.wallMs !== undefined) {
					totals.wallMs += turn.wallMs;
					totals.timedTurns += 1;
				}
				cacheable += turn.cost.tokens.miss + turn.cost.tokens.hit;
				cached += turn.cost.tokens.hit;
				let record = modelMap.get(turn.cost.model);
				if (record === undefined) {
					record = { model: turn.cost.model, provider: turn.provider, usd: 0, tokens: 0, turns: 0, out: 0 };
					modelMap.set(turn.cost.model, record);
				}
				record.usd += turn.cost.usd.total;
				record.tokens += turn.cost.tokens.total;
				record.out += turn.cost.tokens.out;
				record.turns += 1;
				for (const name of Object.keys(totals.categories)) {
					const source = turn.categories[name];
					const target = totals.categories[name];
					target.usd += source.usd;
					target.tokens += source.tokens;
					target.requests += source.requests;
				}
			}
			totals.cacheHitPercent = cacheable > 0 ? Math.round((cached / cacheable) * 100) : null;
			// Token-weighted effective tariff of the loaded turns: lets the whole-session
			// projection — which carries no route attribution — be priced consistently.
			const blend = {
				miss: totals.miss > 0 ? (totals.usdMiss / totals.miss) * 1e6 : FALLBACK_PRICE.miss,
				hit: totals.hit > 0 ? (totals.usdHit / totals.hit) * 1e6 : FALLBACK_PRICE.hit,
				write: totals.write > 0 ? (totals.usdWrite / totals.write) * 1e6 : FALLBACK_PRICE.write,
				out: totals.out > 0 ? (totals.usdOut / totals.out) * 1e6 : FALLBACK_PRICE.out
			};
			const byTurn = new Map();
			const byMessage = new Map();
			for (const turn of turns) {
				byTurn.set(turn.turn, turn);
				const messageId = messageByTurn.get(turn.turn);
				if (messageId !== undefined) byMessage.set(messageId, turn.turn);
			}
			return {
				turns,
				byTurn,
				byMessage,
				requests,
				tools: Array.from(tools.values()).sort((left, right) => right.calls - left.calls || right.ms - left.ms),
				models: Array.from(modelMap.values()).sort((left, right) => right.usd - left.usd),
				totals,
				blend,
				nodes
			};
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  4. Токены темы / design tokens (with sane fallbacks)
		 * ════════════════════════════════════════════════════════════════════ */
		const C = {
			text: 'var(--dsw-alias-label-primary, #e8e8ea)',
			dim: 'var(--dsw-alias-label-caption, #9d9da6)',
			dim2: 'var(--dsw-alias-label-dimmed, #7b7b85)',
			border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.30))',
			border1: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
			layer1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
			layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.11))',
			layer3: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.18))',
			brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
			ok: 'var(--dsw-alias-state-success-primary, #2ec27e)',
			warn: 'var(--dsw-alias-state-warn-primary, #e5a50a)',
			err: 'var(--dsw-alias-state-error-primary, #e5484d)',
			info: 'var(--dsw-alias-state-business-primary, #3f8ae0)',
			mono: 'var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'
		};

		const SEGMENT_COLORS = { miss: C.brand, hit: C.ok, write: C.warn, out: C.info };

		const S = {
			root: {
				display: 'flex',
				flexDirection: 'column',
				gap: '18px',
				padding: '20px 24px 48px',
				height: '100%',
				boxSizing: 'border-box',
				overflowY: 'auto',
				fontSize: '13px',
				lineHeight: 1.5,
				color: C.text
			},
			header: { display: 'flex', flexDirection: 'column', gap: '4px' },
			h1: { margin: 0, fontSize: '19px', fontWeight: 650, letterSpacing: '-0.01em' },
			sub: { margin: 0, fontSize: '12px', color: C.dim },
			section: { display: 'flex', flexDirection: 'column', gap: '10px' },
			sectionTitle: { fontSize: '12px', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.dim2 },
			card: { border: '1px solid ' + C.border1, background: C.layer1, borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
			kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))', gap: '10px' },
			kpi: { border: '1px solid ' + C.border1, background: C.layer1, borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '3px' },
			kpiLabel: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: C.dim2 },
			kpiValue: { fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em' },
			kpiSub: { fontSize: '11px', color: C.dim },
			split: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '14px' },
			columns: { display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-start', gap: '3px', height: '124px', padding: '4px 0' },
			column: {
				flex: '1 1 0',
				minWidth: '4px',
				maxWidth: '28px',
				display: 'flex',
				flexDirection: 'column-reverse',
				height: '100%',
				borderRadius: '3px',
				overflow: 'hidden',
				background: C.layer1
			},
			segment: { width: '100%' },
			barRow: { display: 'flex', flexDirection: 'column', gap: '4px' },
			barHead: { display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12px' },
			barTrack: { position: 'relative', height: '8px', borderRadius: '4px', background: C.layer2, overflow: 'hidden' },
			barFill: { position: 'absolute', inset: '0 auto 0 0', borderRadius: '4px' },
			list: { display: 'flex', flexDirection: 'column', gap: '8px' },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
			th: { textAlign: 'left', fontWeight: 600, color: C.dim2, padding: '6px 8px', borderBottom: '1px solid ' + C.border1, whiteSpace: 'nowrap' },
			td: { padding: '6px 8px', borderBottom: '1px solid ' + C.border1, verticalAlign: 'top' },
			tdNum: { padding: '6px 8px', borderBottom: '1px solid ' + C.border1, textAlign: 'right', fontFamily: C.mono, whiteSpace: 'nowrap' },
			legend: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', fontSize: '11px', color: C.dim },
			legendItem: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
			dot: { width: '9px', height: '9px', borderRadius: '3px', display: 'inline-block' },
			chipRoot: { display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px', margin: '2px 0' },
			/* The in-row pill: flat, in the action row's own type style, parked at the
			 * row's right edge via flex order + an auto left margin. */
			pillRoot: {
				display: 'inline-flex',
				flexDirection: 'column',
				alignItems: 'flex-end',
				gap: '8px',
				marginLeft: 'auto',
				order: 99,
				paddingLeft: '10px',
				minWidth: 0,
				flexShrink: 0
			},
			pillButton: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '6px',
				background: 'none',
				border: 'none',
				padding: 0,
				margin: 0,
				cursor: 'pointer',
				color: 'var(--dsw-alias-label-tertiary, #8a8a93)',
				font: 'inherit',
				fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
				lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
				whiteSpace: 'nowrap',
				fontVariantNumeric: 'tabular-nums'
			},
			pillTotal: { color: 'var(--dsw-alias-label-secondary, #b9b9c1)', fontWeight: 600 },
			pillItem: { color: 'inherit' },
			pillSep: { opacity: 0.45 },
			/* One icon + one price; the icons carry the labels, the tooltips keep them readable. */
			catItem: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: 'none' },
			/* Account balance: after the category chips, walled off so it does not read as a
			 * fourth category. */
			balanceChip: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '4px',
				flex: 'none',
				paddingLeft: '8px',
				borderLeft: '1px solid ' + C.border1,
				fontVariantNumeric: 'tabular-nums'
			},
			balanceLabel: { color: C.dim2 },
			balanceValue: { color: C.ok },
			/* Session summary: a sibling of the shipped stats pills under the composer. */
			summaryRoot: {
				boxSizing: 'border-box',
				maxWidth: '100%',
				display: 'inline-flex',
				alignItems: 'center',
				gap: '10px',
				padding: '1px 8px',
				color: 'var(--dsw-alias-label-tertiary, #8a8a93)',
				fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
				whiteSpace: 'nowrap',
				fontVariantNumeric: 'tabular-nums'
			},
			pillPanel: {
				border: '1px solid ' + C.border1,
				background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
				borderRadius: '10px',
				padding: '10px 12px',
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				minWidth: '430px',
				maxWidth: '560px',
				textAlign: 'left',
				whiteSpace: 'normal'
			},
			/* Fallback placement for the no-DOM path (the smoke test): anchored to the pill
			 * itself. In the browser the panel is portalled to `document.body` and placed
			 * with a fixed position, because the chat's message rows are stacking contexts
			 * of their own and an absolutely positioned panel sinks beneath the next row. */
			pillPanelInline: { position: 'absolute', right: 0, top: '100%', marginTop: '6px', zIndex: 40 },
			pillPanelHead: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: '11px', color: C.dim },
			/* Interactive timeline: the plot is one SVG (preserveAspectRatio none), so all
			 * readable text lives in HTML layers on top of it instead of inside the SVG. */
			timelineBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' },
			timelineMeta: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: '12px', color: C.dim },
			timelineBox: {
				position: 'relative',
				height: '170px',
				margin: '14px 0 18px 54px',
				cursor: 'crosshair',
				touchAction: 'none',
				userSelect: 'none'
			},
			timelineY: {
				position: 'absolute',
				left: '-54px',
				top: 0,
				width: '48px',
				height: '170px',
				fontSize: '10px',
				color: C.dim2,
				textAlign: 'right',
				pointerEvents: 'none'
			},
			timelineX: {
				position: 'relative',
				margin: '0 0 0 54px',
				height: '14px',
				fontSize: '10px',
				color: C.dim2,
				pointerEvents: 'none'
			},
			timelineTip: {
				position: 'absolute',
				top: 0,
				transform: 'translateX(-50%)',
				display: 'flex',
				flexDirection: 'column',
				gap: '2px',
				padding: '6px 8px',
				borderRadius: '8px',
				border: '1px solid ' + C.border1,
				background: 'var(--dsw-alias-bg-layer-3, rgba(20,20,22,0.94))',
				fontSize: '11px',
				whiteSpace: 'nowrap',
				pointerEvents: 'none',
				zIndex: 2
			},
			toggle: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '4px',
				padding: '2px 8px',
				borderRadius: '999px',
				border: '1px solid ' + C.border1,
				background: 'none',
				color: C.dim,
				fontSize: '11px',
				cursor: 'pointer',
				lineHeight: '18px'
			},
			toggleActive: { background: C.layer2, color: C.text, borderColor: C.border },
			chip: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '7px',
				padding: '2px 9px',
				borderRadius: '999px',
				border: '1px solid ' + C.border1,
				background: C.layer1,
				color: C.dim,
				fontSize: '11px',
				fontFamily: C.mono,
				cursor: 'pointer',
				lineHeight: '18px'
			},
			chipUsd: { color: C.warn, fontWeight: 700 },
			chipPanel: { border: '1px solid ' + C.border1, background: C.layer1, borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '520px' },
			note: { fontSize: '11px', color: C.dim2 },
			link: { background: 'none', border: 'none', color: C.brand, cursor: 'pointer', fontSize: '12px', padding: 0, textAlign: 'left' },
			empty: { fontSize: '12px', color: C.dim, padding: '14px 0' },
			pill: { display: 'inline-block', padding: '1px 6px', borderRadius: '4px', background: C.layer2, color: C.dim, fontSize: '10px', fontFamily: C.mono }
		};

		/* ════════════════════════════════════════════════════════════════════
		 *  5. Примитивы отрисовки / presentation atoms
		 * ════════════════════════════════════════════════════════════════════ */
		function Kpi(props) {
			return e(
				'div',
				{ style: S.kpi },
				e('span', { style: S.kpiLabel }, props.label),
				e('span', { style: { ...S.kpiValue, color: props.accent === undefined ? C.text : props.accent } }, props.value),
				props.sub === undefined ? null : e('span', { style: S.kpiSub }, props.sub)
			);
		}

		function Section(props) {
			return e('section', { style: S.section }, e('h2', { style: S.sectionTitle }, props.title), props.children);
		}

		/** Horizontal bar list: label, value, optional ratio bar behind the row. */
		function Bars(props) {
			const rows = props.rows;
			const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0);
			const color = props.color === undefined ? C.brand : props.color;
			if (rows.length === 0) return e('div', { style: S.empty }, props.emptyLabel);
			return e(
				'div',
				{ style: S.list },
				rows.map((row, index) =>
					e(
						'div',
						{ key: String(row.key === undefined ? index : row.key), style: S.barRow, title: row.title },
						e(
							'div',
							{ style: S.barHead },
							e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
							e('span', { style: { color: C.dim, fontFamily: C.mono, whiteSpace: 'nowrap' } }, row.display)
						),
						e(
							'div',
							{ style: S.barTrack },
							e('div', {
								style: {
									...S.barFill,
									width: (max > 0 ? Math.max(1.5, (row.value / max) * 100) : 0) + '%',
									background: row.color === undefined ? color : row.color
								}
							})
						)
					)
				)
			);
		}

		/** Stacked token columns, one column per turn. */
		function StackedColumns(props) {
			const turns = props.turns.slice(-props.limit);
			if (turns.length === 0) return e('div', { style: S.empty }, props.emptyLabel);
			const max = turns.reduce((acc, turn) => Math.max(acc, turn.cost.tokens.total), 0);
			const label = (turn) =>
				props.t('turn') +
				' ' +
				String(turn.turn) +
				' · ' +
				fmtTokens(turn.cost.tokens.total) +
				' ' +
				props.t('unit.tokens') +
				' · ' +
				fmtUsd(turn.cost.usd.total);
			return e(
				'div',
				{ style: S.columns },
				turns.map((turn) =>
					e(
						'div',
						{
							key: 'turn-' + String(turn.turn),
							style: S.column,
							title: label(turn)
						},
						['out', 'write', 'hit', 'miss'].map((bucket) => {
							const value = turn.cost.tokens[bucket];
							if (value <= 0) return null;
							const share = max > 0 ? (value / max) * 100 : 0;
							return e('div', {
								key: bucket,
								style: { ...S.segment, height: share + '%', background: SEGMENT_COLORS[bucket] }
							});
						})
					)
				)
			);
		}

		/** Cost columns, one column per turn, scaled to the most expensive turn. */
		function CostColumns(props) {
			const turns = props.turns.slice(-props.limit);
			if (turns.length === 0) return e('div', { style: S.empty }, props.emptyLabel);
			const max = turns.reduce((acc, turn) => Math.max(acc, turn.cost.usd.total), 0);
			return e(
				'div',
				{ style: S.columns },
				turns.map((turn) =>
					e(
						'div',
						{ key: 'cost-' + String(turn.turn), style: { ...S.column, background: 'transparent', justifyContent: 'flex-end' } },
						e('div', {
							title: props.t('turn') + ' ' + String(turn.turn) + ' · ' + fmtUsd(turn.cost.usd.total) + ' · ' + turn.cost.model,
							style: {
								width: '100%',
								height: (max > 0 ? Math.max(1.5, (turn.cost.usd.total / max) * 100) : 0) + '%',
								background: 'linear-gradient(180deg, ' + C.warn + ', ' + C.err + ')',
								borderRadius: '3px 3px 0 0',
								minHeight: '2px'
							}
						})
					)
				)
			);
		}

		/** Donut of mutually exclusive token buckets. */
		function Donut(props) {
			const size = 132;
			const thickness = 18;
			const radius = (size - thickness) / 2;
			const circumference = 2 * Math.PI * radius;
			const segments = props.segments.filter((segment) => segment.value > 0);
			const total = segments.reduce((acc, segment) => acc + segment.value, 0);
			let offset = 0;
			const arcs = [];
			for (const segment of segments) {
				const length = (segment.value / total) * circumference;
				arcs.push(
					e('circle', {
						key: segment.key,
						cx: size / 2,
						cy: size / 2,
						r: radius,
						fill: 'none',
						stroke: segment.color,
						strokeWidth: thickness,
						strokeDasharray: String(length) + ' ' + String(Math.max(0, circumference - length)),
						strokeDashoffset: String(-offset),
						transform: 'rotate(-90 ' + String(size / 2) + ' ' + String(size / 2) + ')'
					})
				);
				offset += length;
			}
			return e(
				'div',
				{ style: { position: 'relative', width: size + 'px', height: size + 'px', flex: '0 0 auto' } },
				e(
					'svg',
					{ width: size, height: size, viewBox: '0 0 ' + String(size) + ' ' + String(size) },
					e('circle', {
						cx: size / 2,
						cy: size / 2,
						r: radius,
						fill: 'none',
						stroke: C.layer2,
						strokeWidth: thickness
					}),
					arcs
				),
				e(
					'div',
					{
						style: {
							position: 'absolute',
							inset: 0,
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							gap: '1px',
							pointerEvents: 'none'
						}
					},
					e('span', { style: { fontSize: '15px', fontWeight: 700 } }, props.centerValue),
					e('span', { style: { fontSize: '10px', color: C.dim } }, props.centerLabel)
				)
			);
		}

		function Legend(props) {
			return e(
				'div',
				{ style: S.legend },
				props.items.map((item) =>
					e(
						'span',
						{ key: item.key, style: S.legendItem },
						e('span', { style: { ...S.dot, background: item.color } }),
						item.label
					)
				)
			);
		}

		/** One aligned token/price/cost table used by both the chip and the tab. */
		function CostTable(props) {
			const buckets = [
				{ key: 'miss', label: props.t('row.miss'), tokens: props.cost.tokens.miss, usd: props.cost.usd.miss, price: props.cost.price.miss },
				{ key: 'hit', label: props.t('row.hit'), tokens: props.cost.tokens.hit, usd: props.cost.usd.hit, price: props.cost.price.hit },
				{ key: 'write', label: props.t('row.write'), tokens: props.cost.tokens.write, usd: props.cost.usd.write, price: props.cost.price.write },
				{ key: 'out', label: props.t('row.out'), tokens: props.cost.tokens.out, usd: props.cost.usd.out, price: props.cost.price.out }
			].filter((bucket) => bucket.tokens > 0 || bucket.key === 'miss' || bucket.key === 'out');
			const rows = buckets.map((bucket) =>
				e(
					'tr',
					{ key: bucket.key },
					e('td', { style: S.td }, bucket.label),
					e('td', { style: S.tdNum }, fmtTokens(bucket.tokens)),
					e('td', { style: S.tdNum }, String(bucket.price)),
					e('td', { style: S.tdNum }, fmtUsd(bucket.usd))
				)
			);
			if (props.cost.tokens.reasoning > 0) {
				rows.push(
					e(
						'tr',
						{ key: 'reasoning' },
						e('td', { style: { ...S.td, color: C.dim } }, props.t('row.reasoning')),
						e('td', { style: { ...S.tdNum, color: C.dim } }, fmtTokens(props.cost.tokens.reasoning)),
						e('td', { style: S.tdNum }, '—'),
						e('td', { style: { ...S.tdNum, color: C.dim } }, props.t('row.inOutput'))
					)
				);
			}
			rows.push(
				e(
					'tr',
					{ key: 'total' },
					e('td', { style: { ...S.td, fontWeight: 650 } }, props.t('row.total')),
					e('td', { style: { ...S.tdNum, fontWeight: 650 } }, fmtTokens(props.cost.tokens.total)),
					e('td', { style: S.tdNum }, ''),
					e('td', { style: { ...S.tdNum, fontWeight: 700, color: C.warn } }, fmtUsd(props.cost.usd.total))
				)
			);
			return e(
				'table',
				{ style: S.table },
				e(
					'thead',
					null,
					e(
						'tr',
						null,
						e('th', { style: S.th }, props.t('col.bucket')),
						e('th', { style: { ...S.th, textAlign: 'right' } }, props.t('col.tokens')),
						e('th', { style: { ...S.th, textAlign: 'right' } }, props.t('col.price')),
						e('th', { style: { ...S.th, textAlign: 'right' } }, props.t('col.cost'))
					)
				),
				e('tbody', null, rows)
			);
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  6. Стоимость в чате / the per-turn cost pill
		 * ════════════════════════════════════════════════════════════════════ */
		/** Category order used by the pill, the panel and the view. */
		const CATEGORY_ORDER = ['tools', 'reasoning', 'read'];
		const CATEGORY_COLORS = { tools: C.info, reasoning: C.brand, read: C.ok };
		/**
		 * Shell glyph per category — the pictograms the shipped UI already uses for the
		 * same ideas: a tool (gear), the chat's own «Думать» glyph, and browsing data.
		 * Falls back to the category's first letter if the icon set changes.
		 */
		const CATEGORY_ICONS = {
			tools: ['IconSettingsOutline16', 'И'],
			reasoning: ['IconThinkOutline14', 'Р'],
			read: ['IconBrowseOutline16', 'Ч']
		};

		/** Icon + price for one category, the shape both the pill and the summary use. */
		function categoryChip(t, name, entry, size) {
			const glyph = CATEGORY_ICONS[name] === undefined ? ['', '?'] : CATEGORY_ICONS[name];
			return e(
				'span',
				{ key: name, style: S.catItem, title: t('cat.' + name) + ' ' + fmtUsd(entry.usd), 'data-cat': name },
				iconOf(glyph[0], glyph[1], size),
				e('span', null, fmtUsd(entry.usd))
			);
		}

		/** Does any category carry money? Exact-only turns have no attribution. */
		function hasCategorySpend(categories) {
			if (categories === null || categories === undefined) return false;
			for (const name of CATEGORY_ORDER) {
				const entry = categories[name];
				if (entry !== undefined && entry.usd > 0) return true;
			}
			return false;
		}

		/**
		 * The pill: flat, in the action row's own type style, parked at the row's right
		 * edge. It carries the total and what each kind of action cost; the click-open
		 * panel carries the token and bucket detail.
		 */
		function CostPill(props) {
			const [open, setOpen] = useState(false);
			const [anchor, setAnchor] = useState(null);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const t = props.t;
			const cost = props.cost;
			const tokens = cost.tokens;
			const categories = props.categories;
			const split = hasCategorySpend(categories);

			// A fixed panel must not outlive the position it was measured at, and it must
			// close for the same gestures the shell's own popovers do.
			react.useEffect(() => {
				if (open !== true) return undefined;
				if (typeof document === 'undefined' || document === null) return undefined;
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				const onDown = (event) => {
					const root = rootRef.current;
					const panel = panelRef.current;
					if (root !== null && root !== undefined && root.contains(event.target)) return;
					if (panel !== null && panel !== undefined && panel.contains(event.target)) return;
					setOpen(false);
				};
				const onMove = () => {
					setOpen(false);
				};
				document.addEventListener('keydown', onKey);
				document.addEventListener('mousedown', onDown);
				window.addEventListener('resize', onMove);
				window.addEventListener('scroll', onMove, true);
				return () => {
					document.removeEventListener('keydown', onKey);
					document.removeEventListener('mousedown', onDown);
					window.removeEventListener('resize', onMove);
					window.removeEventListener('scroll', onMove, true);
				};
			}, [open]);

			/** Place the panel under the pill, or above it when the viewport runs out. */
			const toggle = () => {
				if (open === true) {
					setOpen(false);
					return;
				}
				const el = rootRef.current;
				if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function' || typeof window === 'undefined') {
					setAnchor(null);
					setOpen(true);
					return;
				}
				const rect = el.getBoundingClientRect();
				// The panel is fixed to the viewport, so its width has to fit the viewport,
				// not the pill: a 560px panel anchored by a 120px pill would hang off the edge.
				const width = Math.max(320, Math.min(560, window.innerWidth - 16));
				const left = Math.max(8, Math.min(rect.left - width + rect.width, window.innerWidth - width - 8));
				setAnchor({
					left,
					width,
					below: window.innerHeight - rect.bottom >= 320,
					top: rect.bottom + 8,
					bottom: window.innerHeight - rect.top + 8
				});
				setOpen(true);
			};

			const panelStyle =
				anchor === null
					? { ...S.pillPanel, ...S.pillPanelInline }
					: {
							...S.pillPanel,
							position: 'fixed',
							left: anchor.left + 'px',
							width: anchor.width + 'px',
							top: anchor.below ? anchor.top + 'px' : 'auto',
							bottom: anchor.below ? 'auto' : anchor.bottom + 'px',
							maxHeight: '70vh',
							overflowY: 'auto',
							boxShadow: '0 14px 36px rgba(0, 0, 0, 0.38)',
							zIndex: 2147483000
						};

			const children = [
				e(
					'span',
					{ key: 'total', style: S.pillTotal, title: t('kpi.usd') },
					(props.approximate === true ? '≈ ' : '') + fmtUsd(cost.usd.total)
				)
			];
			const label = [t('chip.title') + ': ' + fmtUsd(cost.usd.total)];
			if (split) {
				for (const name of CATEGORY_ORDER) {
					const usd = categories[name].usd;
					if (usd <= 0) continue;
					children.push(categoryChip(t, name, categories[name], 14));
					label.push(t('cat.' + name) + ' ' + fmtUsd(usd));
				}
			} else {
				children.push(e('span', { key: 'sep-tokens', style: S.pillSep }, '·'));
				children.push(e('span', { key: 'tokens', style: S.pillItem }, fmtTokens(tokens.total)));
				label.push(fmtTokens(tokens.total) + ' ' + t('unit.tokens'));
			}
			return e(
				'span',
				{ style: S.pillRoot, ref: rootRef },
				e(
					'button',
					{
						type: 'button',
						style: S.pillButton,
						'aria-expanded': open,
						'aria-label': label.join(', '),
						title:
							t('chip.title') +
							' · ' +
							cost.model +
							' · ' +
							fmtTokens(tokens.total) +
							' ' +
							t('unit.tokens') +
							(props.approximate === true ? ' · ' + t('note.approxShort') : ''),
						onClick: toggle
					},
					children
				),
				open === true
					? e(
							FloatingLayer,
							null,
							e(
								'div',
								{ style: panelStyle, ref: panelRef },
								e(
									'div',
									{ style: S.pillPanelHead },
								e('span', null, t('col.model') + ': ' + cost.model + (props.mixed === true ? ' (' + t('misc.mixed') + ')' : '')),
								e('span', null, t('turn') + ': ' + String(props.turn)),
								props.wallMs === undefined ? null : e('span', null, fmtDuration(props.wallMs)),
								props.ttftMs === undefined ? null : e('span', null, 'TTFT ' + fmtDuration(props.ttftMs)),
								props.tps === undefined ? null : e('span', null, fmtTps(props.tps))
							),
							split
								? e(
										'table',
										{ style: S.table },
										e(
											'thead',
											null,
											e(
												'tr',
												null,
												e('th', { style: S.th }, t('col.action')),
												e('th', { style: { ...S.th, textAlign: 'right' } }, t('col.requests')),
												e('th', { style: { ...S.th, textAlign: 'right' } }, t('col.tokens')),
												e('th', { style: { ...S.th, textAlign: 'right' } }, t('col.cost'))
											)
										),
										e(
											'tbody',
											null,
											CATEGORY_ORDER.map((name) =>
												e(
													'tr',
													{ key: name },
													e('td', { style: { ...S.td, color: CATEGORY_COLORS[name] } }, t('cat.' + name)),
													e('td', { style: S.tdNum }, String(categories[name].requests)),
													e('td', { style: S.tdNum }, fmtTokens(categories[name].tokens)),
													e('td', { style: { ...S.tdNum, fontWeight: 600 } }, fmtUsd(categories[name].usd))
												)
											)
										)
									)
								: null,
							e(CostTable, { cost, t }),
							props.approximate === true ? e('span', { style: S.note }, t('note.approx')) : null,
							split ? null : e('span', { style: S.note }, t('note.noSplit')),
							e('span', { style: S.note }, t('note.estimate'))
							)
						)
					: null
			);
		}

		/**
		 * Resolve one turn's cost: exact per-turn accounting when the tail carried it,
		 * otherwise the session ledger, which rebuilds the turn from its requests and
		 * marks it approximate.
		 */
		function useTurnCost(useCost, turnNumber, exact, mixed) {
			const stats = typeof useCost === 'function' ? useCost((value) => value) : undefined;
			const ledgerTurn =
				stats === null || stats === undefined || typeof stats.byTurn?.get !== 'function'
					? undefined
					: stats.byTurn.get(turnNumber);
			if (exact !== null && exact !== undefined) {
				return { cost: exact, approximate: false, mixed: mixed === true, turn: ledgerTurn };
			}
			if (ledgerTurn === undefined) return null;
			return {
				cost: ledgerTurn.cost,
				approximate: ledgerTurn.approximate === true,
				mixed: ledgerTurn.mixed === true,
				turn: ledgerTurn
			};
		}

		/** Session-scope price of the whole-log token projection under an effective tariff. */
		function priceSessionTokens(tokenUsage, blend) {
			if (tokenUsage === null || tokenUsage === undefined) return null;
			const miss = num(tokenUsage.uncachedInputTokens);
			const hit = num(tokenUsage.cacheReadTokens);
			const write = num(tokenUsage.cacheWriteTokens);
			const out = num(tokenUsage.outputTokens);
			if (miss + hit + write + out === 0) return 0;
			const price = blend === null || blend === undefined ? FALLBACK_PRICE : blend;
			return (miss * price.miss + hit * price.hit + write * price.write + out * price.out) / 1e6;
		}

		/**
		 * Session cost under the composer, as a sibling of the shipped stats pills
		 * (`conversation.composer.dock`, where the chat registers its own `stats` entry).
		 * Same three category icons as the per-turn pill.
		 */
		function CostSummary(props) {
			// Every hook first, unconditionally. The composer dock renders once before any
			// conversation data exists, so an early return above a hook would change the
			// hook count on the next render and React rejects that ("rendered fewer hooks
			// than expected") — which is exactly how this summary used to vanish after a
			// page reload while looking fine under HMR.
			const useCost = props.useCost;
			const stats = typeof useCost === 'function' ? useCost((value) => value) : undefined;
			const tokenUsage = typeof props.useProjection === 'function' ? props.useProjection('tokenUsage') : undefined;
			const [balance, setBalance] = useState(undefined);
			// What is left on the account, straight from the provider (through the host
			// half, which owns the key). Polled slowly: a balance is not a live counter,
			// and every ask is a network round trip.
			react.useEffect(() => {
				let alive = true;
				if (typeof fetch !== 'function') return undefined;
				const load = () => {
					fetch(BALANCE_ROUTE, { headers: { accept: 'application/json' } })
						.then((response) =>
							response.ok ? response.json() : Promise.reject(new Error('http ' + String(response.status)))
						)
						.then((payload) => {
							if (!alive) return;
							setBalance(
								payload !== null && payload !== undefined && typeof payload.total === 'number' && Number.isFinite(payload.total)
									? payload
									: null
							);
						})
						.catch(() => {
							if (alive) setBalance(null);
						});
				};
				load();
				const timer = setInterval(load, BALANCE_REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			if (stats === null || stats === undefined || stats.totals === undefined) return null;
			const totals = stats.totals;
			if (totals.usd <= 0) return null;
			const t = props.t;
			const categories = [];
			const label = [t('summary.total') + ' ' + fmtUsd(totals.usd)];
			for (const name of CATEGORY_ORDER) {
				const entry = totals.categories[name];
				if (entry === undefined || entry.usd <= 0) continue;
				categories.push(categoryChip(t, name, entry, 14));
				label.push(t('cat.' + name) + ' ' + fmtUsd(entry.usd));
			}
			if (categories.length === 0) return null;
			const sessionUsd = priceSessionTokens(tokenUsage, stats.blend);
			const balanceChip =
				balance === null || balance === undefined
					? null
					: e(
							'span',
							{
								key: 'balance',
								style: S.balanceChip,
								title:
									t('balance.title') +
									' · ' +
									fmtUsd(balance.total) +
									(balance.currency === undefined ? '' : ' ' + balance.currency) +
									(balance.toppedUp > 0 ? ' · ' + t('balance.toppedUp') + ' ' + fmtUsd(balance.toppedUp) : '') +
									(balance.granted > 0 ? ' · ' + t('balance.granted') + ' ' + fmtUsd(balance.granted) : '')
							},
							e('span', { style: S.balanceLabel }, t('balance.label')),
							e('span', { style: S.balanceValue }, fmtUsd(balance.total))
						);
			if (balanceChip !== null) label.push(t('balance.label') + ' ' + fmtUsd(balance.total));
			return e(
				'span',
				{
					style: S.summaryRoot,
					'aria-label': label.join(', '),
					title:
						t('summary.title') +
						' · ' +
						label.join(' · ') +
						(sessionUsd === null ? '' : ' · ' + t('kpi.session') + ' ' + fmtUsd(sessionUsd))
				},
				e('span', { style: S.pillTotal }, fmtUsd(totals.usd)),
				categories,
				balanceChip
			);
		}

		/** Turn-tail list occupant: rendered only when no action row exists for the turn. */
		function TurnCostChip(props) {
			/* 0.2.0: `conversation.chat.turnTail` is a LIST seat, so its owner props carry the
			 * TurnLocation itself (`props.turn`); 0.1.5 chained a selector's value in as
			 * `matched`. The selector therefore runs here, and a declined turn renders
			 * nothing. The hook stays unconditional so the render order never changes. */
			const matched = selectTurnCost(props) ?? undefined;
			const resolved = useTurnCost(
				props.useCost,
				matched === undefined ? undefined : matched.turn,
				matched === undefined ? undefined : matched.exact,
				matched === undefined ? undefined : matched.mixed
			);
			if (resolved === null) return null;
			const ledgerTurn = resolved.turn;
			return e(CostPill, {
				t: props.t,
				turn: matched.turn,
				cost: resolved.cost,
				approximate: resolved.approximate,
				mixed: resolved.mixed,
				categories: ledgerTurn === undefined ? undefined : ledgerTurn.categories,
				wallMs: ledgerTurn === undefined ? undefined : ledgerTurn.wallMs,
				ttftMs: matched.ttftMs === undefined ? (ledgerTurn === undefined ? undefined : ledgerTurn.ttftMs) : matched.ttftMs,
				tps: matched.tps === undefined ? (ledgerTurn === undefined ? undefined : ledgerTurn.tps) : matched.tps
			});
		}

		/**
		 * Assistant-message action-list occupant: this is the reliable seat, because the
		 * turn-tail chain stops at its first accepting selector and the shipped
		 * deliverables selector claims every turn that wrote files.
		 */
		function TurnCostAction(props) {
			const useCost = props.useCost;
			const stats = typeof useCost === 'function' ? useCost((value) => value) : undefined;
			const messageId = props.messageId;
			const turnNumber =
				stats === null || stats === undefined || typeof stats.byMessage?.get !== 'function'
					? undefined
					: stats.byMessage.get(messageId);
			if (turnNumber === undefined) return null;
			const ledgerTurn = typeof stats.byTurn?.get === 'function' ? stats.byTurn.get(turnNumber) : undefined;
			if (ledgerTurn === undefined) return null;
			return e(CostPill, {
				t: props.t,
				turn: turnNumber,
				cost: ledgerTurn.cost,
				approximate: ledgerTurn.approximate === true,
				mixed: ledgerTurn.mixed === true,
				categories: ledgerTurn.categories,
				wallMs: ledgerTurn.wallMs,
				ttftMs: ledgerTurn.ttftMs,
				tps: ledgerTurn.tps
			});
		}

		/**
		 * Chain-slot selector. It declines every turn that the message action list can
		 * price, so the pill never appears twice: the action list is the primary seat and
		 * covers every turn whose closing assistant carries a message id. Only a turn
		 * without one — where no action row exists at all — falls through to here.
		 */
		function selectTurnCost(owner) {
			/* The 0.2.0 list seat hands the TurnLocation over directly; a render without one
			 * must decline rather than throw. */
			const location = owner === null || owner === undefined ? undefined : owner.turn;
			if (location === null || location === undefined || typeof location.data?.get !== 'function') return null;
			const data = location.data.get('turn-tail');
			if (data === null || data === undefined) return null;
			const closing = data.closing;
			const finalNode = closing === null || closing === undefined ? undefined : closing.finalNode;
			if (finalNode !== null && finalNode !== undefined && typeof finalNode.messageId === 'string') return null;
			const usage = data.tokenUsage;
			if (usage !== null && usage !== undefined) {
				const route = routeOf(usage);
				return {
					turn: data.turn,
					exact: costOfUsage(usage, route.model),
					mixed: route.mixed,
					ttftMs: data.ttftMs,
					tps: data.tokensPerSecond
				};
			}
			// Without exact accounting the component looks the turn up in the ledger, so
			// the turn is claimed with no exact cost and may still render nothing.
			return { turn: data.turn, exact: null, mixed: false };
		}


		/* ════════════════════════════════════════════════════════════════════
		 *  7. Вкладка «Расход» / the cost & statistics view
		 * ════════════════════════════════════════════════════════════════════ */
		const MAX_COLUMNS = 60;

		function RatingTable(props) {
			if (props.rows.length === 0) return e('div', { style: S.empty }, props.emptyLabel);
			return e(
				'table',
				{ style: S.table },
				e(
					'thead',
					null,
					e(
						'tr',
						null,
						props.columns.map((column, index) =>
							e(
								'th',
								{ key: column.key, style: index === 0 ? S.th : { ...S.th, textAlign: 'right' } },
								column.label
							)
						)
					)
				),
				e(
					'tbody',
					null,
					props.rows.map((row) =>
						e(
							'tr',
							{ key: row.key },
							props.columns.map((column, index) =>
								e(
									'td',
									{ key: column.key, style: index === 0 ? S.td : S.tdNum },
									column.render(row)
								)
							)
						)
					)
				)
			);
		}

		/* ── interactive time line ─────────────────────────────────────────── */

		/** Metrics the timeline can plot; rates are always expressed per minute. */
		const TIMELINE_METRICS = [
			{ key: 'usd', label: 'metric.usd', color: C.warn, kind: 'bar' },
			{ key: 'requests', label: 'metric.requests', color: C.info, kind: 'bar' },
			{ key: 'tokens', label: 'metric.tokens', color: C.brand, kind: 'bar' },
			{ key: 'cumulative', label: 'metric.cumulative', color: C.ok, kind: 'area' }
		];
		/** Bucket widths offered for the time axis, in seconds. */
		/** Window presets: the whole point of the host series is reaching days. */
		const TIMELINE_RANGES = [
			{ key: '1h', ms: 3600000 },
			{ key: '6h', ms: 6 * 3600000 },
			{ key: '24h', ms: 24 * 3600000 },
			{ key: '7d', ms: 7 * 24 * 3600000 },
			{ key: 'all', ms: 0 }
		];
		/** Host route serving the whole-corpus request series. */
		const SERIES_ROUTE = '/cost-stats/series';
		/** Host route serving the provider account balance (the key stays on the host). */
		const BALANCE_ROUTE = '/cost-stats/balance';
		/** How often the balance is re-read; a balance is not a live counter. */
		const BALANCE_REFRESH_MS = 300000;
		/** Category codes carried in `series.rows[6]`, kept in step with the host half. */
		const SERIES_CATEGORY = ['reasoning', 'read', 'tools'];
		/** Idle stretches at least this long collapse into one slot when compressing. */
		const IDLE_MS = 20 * 60 * 1000;

		const two = (value) => (value < 10 ? '0' : '') + String(value);

		/** `HH:MM:SS` of a wall-clock millisecond. */
		function clockOf(ms) {
			const date = new Date(ms);
			return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
		}

		/** `HH:MM` of a wall-clock millisecond. */
		function clockShort(ms) {
			const date = new Date(ms);
			return two(date.getHours()) + ':' + two(date.getMinutes());
		}

		/** Round an axis maximum up to 1/2/5×10ⁿ so labels stay readable. */
		function niceMax(value) {
			if (!(value > 0)) return 1;
			const exponent = Math.floor(Math.log10(value));
			const base = Math.pow(10, exponent);
			const scaled = value / base;
			const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
			return step * base;
		}

		/** Bucket widths the step picker can hold, from ten seconds to a day. */
		const STEP_CHOICES = [
			{ key: 'auto', sec: null },
			{ key: '10s', sec: 10 },
			{ key: '1m', sec: 60 },
			{ key: '15m', sec: 900 },
			{ key: '1h', sec: 3600 }
		];
		/** Nice bucket widths the auto step snaps to. */
		const STEP_LADDER = [
			1000, 5000, 10000, 30000, 60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000, 43200000, 86400000
		];
		/** Upper bound on buckets per window: the plot stays readable and cheap. */
		const MAX_BUCKETS = 600;

		/** Pick a bucket width that keeps roughly 160 bars in view. */
		function autoStep(span) {
			const target = span / 160;
			for (const step of STEP_LADDER) if (step >= target) return step;
			return STEP_LADDER[STEP_LADDER.length - 1];
		}

		/** Human duration for the step label: `45 с`, `15 мин`, `6 ч`, `1 д`. */
		function fmtStep(ms) {
			if (ms < 60000) return String(Math.round(ms / 1000)) + ' с';
			if (ms < 3600000) return String(Math.round(ms / 60000)) + ' мин';
			if (ms < 86400000) return trimNumber(ms / 3600000) + ' ч';
			return trimNumber(ms / 86400000) + ' д';
		}

		/** Human duration for an idle stretch. */
		function fmtSpan(ms) {
			if (ms < 3600000) return String(Math.round(ms / 60000)) + ' мин';
			if (ms < 86400000) return trimNumber(ms / 3600000) + ' ч';
			return trimNumber(ms / 86400000) + ' сут'
		}

		/**
		 * Fold the request ledger into equal buckets over the visible window.
		 *
		 * `idleMs` asks for idle runs at least that long to be replaced by a single
		 * `gap` slot: a session corpus spans days, and a linear axis would spend most
		 * of its width on the nights. Gaps carry no requests, so the cumulative total
		 * simply carries across them.
		 */
		function buildBuckets(requests, bucketMs, start, span, idleMs) {
			const count = Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(span / bucketMs)));
			const step = span / count;
			const raw = [];
			for (let index = 0; index < count; index += 1) {
				raw.push({ at: start + index * step, requests: 0, usd: 0, tokens: 0, out: 0, cumulative: 0 });
			}
			let outside = 0;
			for (const request of requests) {
				const at = typeof request.time === 'number' && request.time > 0 ? request.time : undefined;
				if (at === undefined) continue;
				const floor = Math.floor((at - start) / step);
				// The last request can land exactly on the window edge, which floors to
				// `count`; it belongs to the final bucket, not outside the window.
				const index = floor >= count ? count - 1 : floor;
				if (index < 0) {
					outside += 1;
					continue;
				}
				const bucket = raw[index];
				bucket.requests += 1;
				bucket.usd += request.cost.usd.total;
				bucket.tokens += request.cost.tokens.total;
				bucket.out += request.cost.tokens.out;
			}

			const items = [];
			let index = 0;
			while (index < raw.length) {
				const bucket = raw[index];
				if (bucket.requests > 0 || bucket.usd > 0 || idleMs === 0) {
					items.push(bucket);
					index += 1;
					continue;
				}
				let end = index;
				while (end < raw.length && raw[end].requests === 0 && raw[end].usd === 0) end += 1;
				const idle = raw.slice(index, end);
				const idleSpan = idle.length * step;
				// Trailing idle is noise, and a run shorter than the threshold is just a lull.
				if (idleSpan >= idleMs && end < raw.length) {
					items.push({
						at: idle[0].at,
						until: idle[idle.length - 1].at + step,
						gap: true,
						requests: 0,
						usd: 0,
						tokens: 0,
						out: 0,
						cumulative: 0
					});
				} else {
					for (const empty of idle) items.push(empty);
				}
				index = end;
			}

			let running = 0;
			for (const bucket of items) {
				running += bucket.usd;
				bucket.cumulative = running;
			}
			return {
				items,
				step,
				total: running,
				requests: items.reduce((sum, bucket) => sum + bucket.requests, 0),
				outside,
				gaps: items.filter((bucket) => bucket.gap === true).length
			};
		}

		/** Value of one bucket under the selected metric, rates normalised to a minute. */
		function metricOf(bucket, metric, stepMs) {
			const perMinute = 60000 / stepMs;
			if (metric === 'usd') return bucket.usd * perMinute;
			if (metric === 'requests') return bucket.requests * perMinute;
			if (metric === 'tokens') return bucket.tokens * perMinute;
			return bucket.cumulative;
		}

		/**
		 * Zoomable, pannable, hoverable time line over the request ledger.
		 *
		 * Wheel zooms around the cursor, dragging pans, a double click resets. Rates
		 * are always per minute, so widening or narrowing the bucket keeps the unit
		 * the same; every bar carries its own numbers in the tooltip.
		 */
		function TimelineChart(props) {
			const t = props.t;
			const localRequests = Array.isArray(props.requests) ? props.requests : [];
			const [remote, setRemote] = useState(undefined);
			const [reload, setReload] = useState(0);
			const [metric, setMetric] = useState('usd');
			const [stepSec, setStepSec] = useState(null);
			const [rangeKey, setRangeKey] = useState('all');
			const [view, setView] = useState(null);
			const [compress, setCompress] = useState(true);
			const [hovered, setHovered] = useState(null);
			const boxRef = react.useRef(null);
			const dragRef = react.useRef(null);

			// The conversation window is hours deep at best; the durable session logs hold
			// days. The host half serves them at SERIES_ROUTE, and when that route is not
			// there (older host half, non-web profile) the timeline quietly falls back to
			// the loaded history instead.
			react.useEffect(() => {
				let alive = true;
				if (typeof fetch !== 'function') {
					setRemote(null);
					return undefined;
				}
				setRemote(undefined);
				fetch(SERIES_ROUTE, { headers: { accept: 'application/json' } })
					.then((response) =>
						response.ok ? response.json() : Promise.reject(new Error('http ' + String(response.status)))
					)
					.then((payload) => {
						if (alive) setRemote(payload !== null && payload !== undefined && Array.isArray(payload.rows) ? payload : null);
					})
					.catch(() => {
						if (alive) setRemote(null);
					});
				return () => {
					alive = false;
				};
			}, [reload]);

			// Log rows priced with the same table as everything else, plus the local
			// ledger's tail: the host caches its scan, so the newest calls may lag behind.
			const requests = useMemo(() => {
				if (remote === null || remote === undefined || !Array.isArray(remote.rows)) return localRequests;
				const models = Array.isArray(remote.models) ? remote.models : [];
				const merged = [];
				let newest = 0;
				for (const row of remote.rows) {
					const time = row[0];
					if (typeof time !== 'number') continue;
					const model = models[row[1]] ?? 'unknown';
					merged.push({
						time,
						model,
						category: SERIES_CATEGORY[row[6]] ?? 'tools',
						cost: costOfUsage(
							{
								uncachedInputTokens: row[2],
								cacheReadTokens: row[3],
								cacheWriteTokens: row[4],
								outputTokens: row[5]
							},
							model
						)
					});
					if (time > newest) newest = time;
				}
				for (const request of localRequests) {
					if (typeof request.time === 'number' && request.time > newest) merged.push(request);
				}
				return merged;
			}, [remote, localRequests]);

			const stamps = requests
				.map((request) => (typeof request.time === 'number' && request.time > 0 ? request.time : undefined))
				.filter((value) => value !== undefined);
			const first = stamps.length === 0 ? 0 : Math.min(...stamps);
			const lastStamp = stamps.length === 0 ? 0 : Math.max(...stamps);
			const end = Math.max(lastStamp, first + 60000);
			const full = { start: first, span: Math.max(end - first, 60000) };
			const win = view === null ? full : view;
			const requestedStep = stepSec === null ? autoStep(win.span) : stepSec * 1000;
			const idleMs = compress ? IDLE_MS : 0;
			const series = useMemo(
				() => buildBuckets(requests, requestedStep, win.start, win.span, idleMs),
				[requests, requestedStep, win.start, win.span, idleMs]
			);
			const definition = TIMELINE_METRICS.find((entry) => entry.key === metric) ?? TIMELINE_METRICS[0];
			const values = series.items.map((bucket) => metricOf(bucket, metric, series.step));
			const max = niceMax(Math.max(0, ...values));
			const perMinute = 60000 / series.step;
			// The window's average rate divides the whole span, not one bucket — dividing by
			// the bucket step would inflate it by the bucket count.
			const usdPerMinute = win.span > 0 ? series.total / (win.span / 60000) : 0;
			const peakUsdPerMinute = Math.max(0, ...series.items.map((bucket) => bucket.usd * perMinute));
			const minSpan = Math.max(requestedStep * 2, 20000);

			// An idle slot keeps a fixed slice of the axis however long it really was, so a
			// three-day corpus is not mostly nights; every other slot is one weight unit.
			// All x geometry goes through these weights, which keeps one code path for the
			// compressed and the linear axis (compression off means every weight is 1).
			const gapWeight = Math.max(2, Math.round(series.items.length / 40));
			const weights = series.items.map((bucket) => (bucket.gap === true ? gapWeight : 1));
			const offsets = [];
			let totalWeight = 0;
			for (const weight of weights) {
				offsets.push(totalWeight);
				totalWeight += weight;
			}
			if (totalWeight <= 0) totalWeight = 1;
			const leftOf = (index) => (offsets[index] / totalWeight) * 1000;
			const widthOf = (index) => (weights[index] / totalWeight) * 1000;
			const slotAtRatio = (ratio) => {
				const target = ratio * totalWeight;
				for (let index = 0; index < offsets.length; index += 1) {
					if (target >= offsets[index] && target < offsets[index] + weights[index]) return index;
				}
				return Math.max(0, offsets.length - 1);
			};

			const applyRange = (ms) => {
				if (!(ms > 0)) {
					setRangeKey('all');
					setView(null);
					return;
				}
				const to = full.start + full.span;
				const from = Math.max(full.start, to - ms);
				setRangeKey(String(ms));
				setView({ start: from, span: to - from });
			};

			const clampView = (next) => {
				const span = Math.max(minSpan, Math.min(full.span, next.span));
				const start = Math.max(full.start, Math.min(full.start + full.span - span, next.start));
				return { start, span };
			};

			const zoomAt = (ratio, factor) => {
				const point = win.start + ratio * win.span;
				const span = win.span * factor;
				setView(clampView({ start: point - ratio * span, span }));
			};

			// A native listener with passive:false: React's own wheel handler is passive,
			// so preventDefault there would be ignored and the page would scroll instead.
			react.useLayoutEffect(() => {
				const el = boxRef.current;
				if (el === null || el === undefined) return undefined;
				const onWheel = (event) => {
					event.preventDefault();
					const rect = el.getBoundingClientRect();
					const width = rect.width > 0 ? rect.width : 1;
					const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / width));
					zoomAt(ratio, event.deltaY > 0 ? 1.25 : 0.8);
				};
				el.addEventListener('wheel', onWheel, { passive: false });
				return () => {
					el.removeEventListener('wheel', onWheel);
				};
			}, [win.start, win.span, requestedStep, full.start, full.span]);

			const ratioAt = (clientX) => {
				const el = boxRef.current;
				if (el === null || el === undefined) return 0;
				const rect = el.getBoundingClientRect();
				const width = rect.width > 0 ? rect.width : 1;
				return Math.max(0, Math.min(1, (clientX - rect.left) / width));
			};

			const onPointerDown = (event) => {
				dragRef.current = { x: event.clientX, start: win.start, span: win.span, moved: false };
			};
			const onPointerMove = (event) => {
				const drag = dragRef.current;
				const ratio = ratioAt(event.clientX);
				setHovered(slotAtRatio(ratio));
				if (drag === null || drag === undefined) return;
				const el = boxRef.current;
				const width = el === null || el === undefined ? 1 : el.getBoundingClientRect().width || 1;
				const shift = -((event.clientX - drag.x) / width) * drag.span;
				if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true;
				setView(clampView({ start: drag.start + shift, span: drag.span }));
			};
			const onPointerUp = () => {
				dragRef.current = null;
			};

			const hoveredBucket = hovered === null || hovered === undefined ? undefined : series.items[hovered];
			const hoveredValue = hoveredBucket === undefined ? 0 : metricOf(hoveredBucket, metric, series.step);

			const barGap = series.items.length > 120 ? 0.4 : 1.2;
			const bars = [];
			const gapBands = [];
			for (let index = 0; index < series.items.length; index += 1) {
				const bucket = series.items[index];
				const left = leftOf(index);
				const width = widthOf(index);
				if (bucket.gap === true) {
					gapBands.push(
						e('rect', {
							key: 'gap-' + String(index),
							x: left,
							y: 0,
							width: Math.max(width, 1),
							height: 160,
							fill: C.layer2,
							opacity: 0.55
						})
					);
					gapBands.push(
						e('line', {
							key: 'gap-edge-' + String(index),
							x1: left,
							y1: 0,
							x2: left,
							y2: 160,
							stroke: C.border1,
							strokeWidth: 1,
							strokeDasharray: '3 3'
						})
					);
					continue;
				}
				const value = values[index];
				if (!(value > 0)) continue;
				const height = Math.max((value / max) * 150, 0.8);
				bars.push(
					e('rect', {
						key: 'bar-' + String(index),
						x: left + barGap / 2,
						y: 160 - height,
						width: Math.max(width - barGap, 0.6),
						height,
						fill: definition.color,
						opacity: hovered === index ? 1 : 0.82
					})
				);
			}
			let area = null;
			if (definition.kind === 'area') {
				const points = series.items.map((bucket, index) => {
					const center = leftOf(index) + widthOf(index) / 2;
					return String(center) + ',' + String(160 - (metricOf(bucket, metric, series.step) / max) * 150);
				});
				area = [
					e('polygon', {
						key: 'area',
						points: '0,160 ' + points.join(' ') + ' 1000,160',
						fill: definition.color,
						opacity: 0.18
					}),
					e('polyline', {
						key: 'line',
						points: points.join(' '),
						fill: 'none',
						stroke: definition.color,
						strokeWidth: 2,
						vectorEffect: 'non-scaling-stroke'
					})
				];
			}

			const gridLines = [];
			for (let step = 0; step <= 4; step += 1) {
				const y = 160 - (step / 4) * 150;
				gridLines.push(e('line', { key: 'g' + String(step), x1: 0, y1: y, x2: 1000, y2: y, stroke: C.border1, strokeWidth: 1 }));
			}
			// Ticks are placed on the drawn axis, not on the clock: with idle stretches
			// compressed those two are not the same thing, and a label has to point at the
			// bar it belongs to.
			const xLabels = [];
			for (let tick = 0; tick <= 4; tick += 1) {
				const index = slotAtRatio(tick / 4);
				const bucket = series.items[index];
				xLabels.push(
					e(
						'span',
						{
							key: 'x' + String(tick),
							style: { position: 'absolute', left: (offsets[index] / totalWeight) * 100 + '%', transform: 'translateX(-50%)' }
						},
						bucket !== undefined && bucket.gap === true ? '⋯' : clockShort(bucket === undefined ? win.start : bucket.at)
					)
				);
			}
			const yLabels = [];
			for (let step = 0; step <= 4; step += 1) {
				const value = (max / 4) * step;
				const text = metric === 'usd' ? fmtUsd(value) : metric === 'cumulative' ? fmtUsd(value) : fmtTokens(value);
				yLabels.push(
					e(
						'span',
						{ key: 'y' + String(step), style: { position: 'absolute', bottom: (step / 4) * 100 + '%', left: 0 } },
						text
					)
				);
			}

			const metricButtons = TIMELINE_METRICS.map((entry) =>
				e(
					'button',
					{
						key: entry.key,
						type: 'button',
						style: entry.key === metric ? { ...S.toggle, ...S.toggleActive, color: entry.color } : S.toggle,
						'aria-pressed': entry.key === metric,
						onClick: () => {
							setMetric(entry.key);
						}
					},
					t(entry.label)
				)
			);
			const stepButtons = STEP_CHOICES.map((entry) =>
				e(
					'button',
					{
						key: entry.key,
						type: 'button',
						style: entry.sec === stepSec ? { ...S.toggle, ...S.toggleActive } : S.toggle,
						'aria-pressed': entry.sec === stepSec,
						onClick: () => {
							setStepSec(entry.sec);
						}
					},
					entry.sec === null ? t('step.auto') : fmtStep(entry.sec * 1000)
				)
			);
			const rangeButtons = TIMELINE_RANGES.map((entry) =>
				e(
					'button',
					{
						key: entry.key,
						type: 'button',
						style: (entry.ms > 0 ? String(entry.ms) === rangeKey : rangeKey === 'all')
							? { ...S.toggle, ...S.toggleActive }
							: S.toggle,
						'aria-pressed': entry.ms > 0 ? String(entry.ms) === rangeKey : rangeKey === 'all',
						onClick: () => {
							applyRange(entry.ms);
						}
					},
					t('range.' + entry.key)
				)
			);

			return e(
				'div',
				{ style: { ...S.card, gap: '12px' } },
				e('div', { style: S.timelineBar }, e('span', { style: S.sectionTitle }, t('metric.label')), metricButtons),
				e(
					'div',
					{ style: S.timelineBar },
					e('span', { style: S.sectionTitle }, t('range.label')),
					rangeButtons,
					e('span', { style: { width: '10px' } }),
					e('span', { style: S.sectionTitle }, t('step.label')),
					stepButtons,
					e('span', { style: { flex: '1 1 auto' } }),
					e(
						'button',
						{
							type: 'button',
							style: compress ? { ...S.toggle, ...S.toggleActive } : S.toggle,
							'aria-pressed': compress,
							title: t('compress.hint'),
							onClick: () => {
								setCompress(!compress);
							}
						},
						t('compress.label')
					),
					e(
						'button',
						{ type: 'button', style: S.toggle, title: t('refresh'), onClick: () => { setReload(reload + 1); } },
						'⟳'
					)
				),
				e(
					'div',
					{ style: S.timelineBar },
					e(
						'button',
						{ type: 'button', style: S.toggle, onClick: () => { zoomAt(0.5, 0.7); }, title: t('zoom.in') },
						'+'
					),
					e(
						'button',
						{ type: 'button', style: S.toggle, onClick: () => { zoomAt(0.5, 1.45); }, title: t('zoom.out') },
						'−'
					),
					e(
						'button',
						{ type: 'button', style: S.toggle, onClick: () => { setView(null); setRangeKey('all'); }, title: t('zoom.reset') },
						t('zoom.reset')
					)
				),
				e(
					'div',
					{ style: S.timelineMeta },
					e('span', null, t('window.range') + ': ' + clockOf(win.start) + ' – ' + clockOf(win.start + win.span)),
					e('span', null, t('window.step') + ': ' + fmtStep(series.step)),
					e('span', null, t('window.requests') + ': ' + String(series.requests)),
					e('span', null, t('window.usd') + ': ' + fmtUsd(series.total)),
					e('span', null, t('window.avg') + ': ' + fmtUsd(usdPerMinute) + t('unit.perMin')),
					e('span', null, t('window.peak') + ': ' + fmtUsd(peakUsdPerMinute) + t('unit.perMin')),
					series.gaps === 0 ? null : e('span', null, t('gap.count') + ': ' + String(series.gaps)),
					series.outside === 0 ? null : e('span', null, t('window.outside') + ': ' + String(series.outside)),
					e(
						'span',
						{ style: { color: C.dim2 } },
						remote === undefined
							? t('source.loading')
							: remote === null
								? t('source.window') + ' · ' + t('source.hint')
								: t('source.logs') +
									': ' +
									String(remote.sessions) +
									' ' +
									t('source.sessions') +
									' · ' +
									fmtSpan(full.span)
					)
				),
				e(
					'div',
					{ style: S.timelineBox, ref: boxRef, onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp, onDoubleClick: () => { setView(null); setRangeKey('all'); } },
					e(
						'svg',
						{ viewBox: '0 0 1000 170', preserveAspectRatio: 'none', style: { width: '100%', height: '170px', display: 'block' } },
						gridLines,
						gapBands,
						definition.kind === 'area' ? area : bars,
						hovered === null || hovered === undefined
							? null
							: e('line', {
									x1: leftOf(hovered) + widthOf(hovered) / 2,
									y1: 10,
									x2: leftOf(hovered) + widthOf(hovered) / 2,
									y2: 160,
									stroke: C.text,
									strokeWidth: 1,
									opacity: 0.35,
									vectorEffect: 'non-scaling-stroke'
								})
					),
					e('div', { style: S.timelineY }, yLabels),
					hoveredBucket === undefined
						? null
						: e(
								'div',
								{
									style: {
										...S.timelineTip,
										left: Math.min(78, Math.max(0, (leftOf(hovered) + widthOf(hovered) / 2) / 10)) + '%'
									}
								},
								hoveredBucket.gap === true
									? [
											e(
												'span',
												{ key: 'gap', style: { color: C.text, fontWeight: 600 } },
												t('gap.label') + ': ' + fmtSpan(hoveredBucket.until - hoveredBucket.at)
											),
											e(
												'span',
												{ key: 'edges', style: { color: C.dim } },
												clockOf(hoveredBucket.at) + ' → ' + clockOf(hoveredBucket.until)
											)
										]
									: [
											e('span', { key: 'at', style: { color: definition.color, fontWeight: 600 } }, clockOf(hoveredBucket.at)),
											e('span', { key: 'requests' }, t('col.requests') + ': ' + String(hoveredBucket.requests)),
											e('span', { key: 'cost' }, t('col.cost') + ': ' + fmtUsd(hoveredBucket.usd)),
											e('span', { key: 'tokens' }, t('col.tokens') + ': ' + fmtTokens(hoveredBucket.tokens)),
											metric === 'cumulative'
												? null
												: e(
														'span',
														{ key: 'rate' },
														t('window.value') +
															': ' +
															(metric === 'tokens' ? fmtTokens(hoveredValue) : fmtUsd(hoveredValue)) +
															t('unit.perMin')
													)
										]
						)
				),
				e('div', { style: S.timelineX }, xLabels),
				e('span', { style: S.note }, t('note.timeline'))
			);
		}

		function CostView(props) {
			const t = props.t;
			const useCost = props.useCost;
			const useProjection = props.useProjection;
			const useSession = props.useSession;
			const stats = useCost((value) => value);
			const tokenUsage = useProjection('tokenUsage');
			const sessionStats = useProjection('sessionStats');
			const contextBreakdown = useProjection('contextBreakdown');
			const hasMore = useSession((state) => state.hasMore);
			const totals = stats.totals;

			// The host keeps ONE view area for every conversation tab, so it carries the
			// scroll position of whichever tab was showing — opening this one from the
			// bottom of the chat landed on the bottom of the report. Reset before paint
			// (layout effect, not effect) so the top is what actually gets drawn.
			const rootRef = react.useRef(null);
			react.useLayoutEffect(() => {
				const el = rootRef.current;
				if (el === null || el === undefined) return;
				if (typeof el.scrollTop === 'number') el.scrollTop = 0;
				for (let node = el.parentElement; node !== null && node !== undefined; node = node.parentElement) {
					if (typeof node.scrollTop !== 'number' || node.scrollTop <= 0) continue;
					let scrolls = true;
					try {
						const style = window.getComputedStyle(node);
						scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
					} catch (error) {
						scrolls = false;
					}
					if (scrolls) node.scrollTop = 0;
				}
			}, []);

			const sessionTokens = useMemo(() => {
				if (tokenUsage === null || tokenUsage === undefined) return null;
				const miss = num(tokenUsage.uncachedInputTokens);
				const hit = num(tokenUsage.cacheReadTokens);
				const write = num(tokenUsage.cacheWriteTokens);
				const out = num(tokenUsage.outputTokens);
				return { miss, hit, write, out, total: miss + hit + write + out };
			}, [tokenUsage]);

			const sessionUsd = useMemo(() => {
				if (sessionTokens === null) return null;
				if (sessionTokens.total === 0) return 0;
				// The whole-session projection carries no route attribution, so it is
				// priced with the token-weighted effective tariff of the loaded turns.
				const price = stats.blend === undefined ? FALLBACK_PRICE : stats.blend;
				return (
					(sessionTokens.miss * price.miss +
						sessionTokens.hit * price.hit +
						sessionTokens.write * price.write +
						sessionTokens.out * price.out) /
					1e6
				);
			}, [sessionTokens, stats]);

			const toolRows = stats.tools.slice(0, 12).map((tool) => ({
				key: tool.name,
				label: tool.name,
				value: tool.calls,
				display: String(tool.calls) + (tool.ms > 0 ? ' · ' + fmtDuration(tool.ms) : '') + (tool.errors > 0 ? ' · ⚠' + String(tool.errors) : ''),
				title: tool.name,
				color: tool.errors > 0 ? C.err : C.info
			}));

			const expensiveTurns = stats.turns
				.slice()
				.sort((left, right) => right.cost.usd.total - left.cost.usd.total)
				.slice(0, 10);

			const expensiveRequests = stats.requests
				.slice()
				.sort((left, right) => right.cost.usd.total - left.cost.usd.total)
				.slice(0, 10);

			const approximateTurns = stats.turns.reduce((count, turn) => count + (turn.approximate === true ? 1 : 0), 0);

			const timeRows = [];
			if (sessionStats !== null && sessionStats !== undefined) {
				if (num(sessionStats.llmMs) > 0) timeRows.push({ key: 'llm', label: t('state.llm'), value: sessionStats.llmMs, display: fmtDuration(sessionStats.llmMs), color: C.brand });
				if (num(sessionStats.toolMs) > 0) timeRows.push({ key: 'tools', label: t('state.tools'), value: sessionStats.toolMs, display: fmtDuration(sessionStats.toolMs), color: C.info });
			}

			const contextRows = [];
			if (contextBreakdown !== null && contextBreakdown !== undefined) {
				const items = [
					{ key: 'system', label: t('ctx.system'), value: num(contextBreakdown.systemTokens), color: C.warn },
					{ key: 'tools', label: t('ctx.tools'), value: num(contextBreakdown.toolsTokens), color: C.info },
					{ key: 'messages', label: t('ctx.messages'), value: num(contextBreakdown.messageTokens), color: C.brand }
				];
				for (const item of items) contextRows.push({ ...item, display: fmtTokens(item.value) });
			}

			const composition = [
				{ key: 'miss', label: t('row.miss'), value: totals.miss, color: SEGMENT_COLORS.miss },
				{ key: 'hit', label: t('row.hit'), value: totals.hit, color: SEGMENT_COLORS.hit },
				{ key: 'write', label: t('row.write'), value: totals.write, color: SEGMENT_COLORS.write },
				{ key: 'out', label: t('row.out'), value: totals.out, color: SEGMENT_COLORS.out }
			];

			const priceRows = Object.keys(PRICES).map((model) => ({ model, price: PRICES[model] }));

			const kpis = [
				e(Kpi, {
					key: 'usd',
					label: t('kpi.usd'),
					value: fmtUsd(totals.usd),
					sub: fmtTokens(totals.tokens) + ' ' + t('unit.tokens') + ' · ' + t('kpi.turnsLoaded') + ': ' + String(stats.turns.length),
					accent: C.warn
				}),
				e(Kpi, {
					key: 'session',
					label: t('kpi.session'),
					value: sessionUsd === null ? '—' : fmtUsd(sessionUsd),
					sub: sessionTokens === null ? '—' : fmtTokens(sessionTokens.total) + ' ' + t('unit.tokens')
				}),
				e(Kpi, {
					key: 'requests',
					label: t('kpi.requests'),
					value: String(totals.requests),
					sub: totals.requests > 0 ? '≈ ' + fmtUsd(totals.usd / totals.requests) + ' ' + t('kpi.perRequest') : ''
				}),
				e(Kpi, {
					key: 'reasoning',
					label: t('kpi.reasoning'),
					value: fmtTokens(totals.reasoning),
					sub: totals.out > 0 ? String(Math.round((totals.reasoning / totals.out) * 100)) + '% ' + t('row.inOutput') : ''
				}),
				e(Kpi, {
					key: 'cache',
					label: t('kpi.cache'),
					value: totals.cacheHitPercent === null ? '—' : String(totals.cacheHitPercent) + '%',
					sub: fmtTokens(totals.hit) + ' / ' + fmtTokens(totals.miss + totals.hit),
					accent: totals.cacheHitPercent !== null && totals.cacheHitPercent > 50 ? C.ok : undefined
				}),
				e(Kpi, {
					key: 'speed',
					label: t('kpi.speed'),
					value:
						sessionStats === null || sessionStats === undefined || num(sessionStats.decodeMs) === 0
							? '—'
							: fmtTps(sessionStats.decodeTokens / (sessionStats.decodeMs / 1000)),
					sub: t('kpi.speedSub')
				}),
				e(Kpi, {
					key: 'ttft',
					label: t('kpi.ttft'),
					value:
						sessionStats === null || sessionStats === undefined || num(sessionStats.ttftSteps) === 0
							? '—'
							: fmtDuration(sessionStats.ttftMs / sessionStats.ttftSteps),
					sub: t('kpi.ttftSub')
				}),
				e(Kpi, {
					key: 'wall',
					label: t('kpi.wall'),
					value: fmtDuration(totals.wallMs),
					sub: t('kpi.turnsLoaded') + ': ' + String(totals.timedTurns)
				})
			];

			return e(
				'div',
				{ style: S.root, ref: rootRef, 'data-cost-view': true },
				e(
					'header',
					{ style: S.header },
					e('h1', { style: S.h1 }, t('view.title')),
					e('p', { style: S.sub }, t('view.subtitle'))
				),
				e('div', { style: S.kpis }, kpis),
				e(Section, { title: t('section.timeline') }, e(TimelineChart, { requests: stats.requests, t })),
				e(
					Section,
					{ title: t('section.tokensByTurn') },
					e(
						'div',
						{ style: S.card },
						e(StackedColumns, { turns: stats.turns, limit: MAX_COLUMNS, emptyLabel: t('note.none'), t }),
						e(Legend, {
							items: [
								{ key: 'miss', label: t('row.miss'), color: SEGMENT_COLORS.miss },
								{ key: 'hit', label: t('row.hit'), color: SEGMENT_COLORS.hit },
								{ key: 'write', label: t('row.write'), color: SEGMENT_COLORS.write },
								{ key: 'out', label: t('row.out'), color: SEGMENT_COLORS.out }
							]
						}),
						e('span', { style: S.note }, t('note.loaded') + ': ' + String(stats.turns.length) + ' · ' + t('note.window'))
					)
				),
				e(
					Section,
					{ title: t('section.usdByTurn') },
					e('div', { style: S.card }, e(CostColumns, { turns: stats.turns, limit: MAX_COLUMNS, emptyLabel: t('note.none'), t }))
				),
				e(
					'div',
					{ style: S.split },
					e(
						Section,
						{ title: t('section.composition') },
						e(
							'div',
							{ style: { ...S.card, flexDirection: 'row', alignItems: 'center', gap: '18px', flexWrap: 'wrap' } },
							e(Donut, {
								segments: composition,
								centerValue: fmtUsd(totals.usd),
								centerLabel: t('kpi.usd')
							}),
							e(
								'div',
								{ style: { flex: '1 1 190px', minWidth: '190px' } },
								e(Bars, {
									rows: composition.map((segment) => ({
										key: segment.key,
										label: segment.label,
										value: segment.value,
										display: fmtTokens(segment.value),
										color: segment.color
									})),
									emptyLabel: t('note.none')
								})
							)
						)
					),
					e(
						Section,
						{ title: t('section.time') },
						e(
							'div',
							{ style: S.card },
							e(Bars, { rows: timeRows, color: C.brand, emptyLabel: t('note.noTiming') }),
							contextRows.length === 0
								? null
								: e(
										'div',
										{ style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
										e('span', { style: S.sectionTitle }, t('section.context')),
										e(Bars, { rows: contextRows, color: C.info })
									)
						)
					)
				),
				e(
					Section,
					{ title: t('section.actions') },
					e(
						'div',
						{ style: { ...S.card, gap: '14px' } },
						e(Bars, {
							rows: CATEGORY_ORDER.map((name) => ({
								key: name,
								label: t('cat.' + name),
								value: totals.categories[name].usd,
								display:
									fmtUsd(totals.categories[name].usd) +
									' · ' +
									String(totals.categories[name].requests) +
									' ' +
									t('col.requests'),
								color: CATEGORY_COLORS[name]
							})),
							emptyLabel: t('note.noRequests')
						}),
						e(RatingTable, {
							emptyLabel: t('note.noRequests'),
							rows: CATEGORY_ORDER.map((name) => ({ key: name, name })),
							columns: [
								{ key: 'action', label: t('col.action'), render: (row) => t('cat.' + row.name) },
								{ key: 'requests', label: t('col.requests'), render: (row) => String(totals.categories[row.name].requests) },
								{ key: 'tokens', label: t('col.tokens'), render: (row) => fmtTokens(totals.categories[row.name].tokens) },
								{ key: 'usd', label: t('col.cost'), render: (row) => fmtUsd(totals.categories[row.name].usd) },
								{
									key: 'share',
									label: t('col.share'),
									render: (row) =>
										totals.usd > 0
											? String(Math.round((totals.categories[row.name].usd / totals.usd) * 100)) + '%'
											: '—'
								}
							]
						}),
						e('span', { style: S.note }, t('note.actions'))
					)
				),
				e(
					'div',
					{ style: S.split },
					e(
						Section,
						{ title: t('section.ratingTurns') },
						e(
							'div',
							{ style: S.card },
							e(RatingTable, {
								emptyLabel: t('note.none'),
								rows: expensiveTurns.map((turn, index) => ({
									key: 'exp-' + String(turn.turn),
									rank: index + 1,
									turn
								})),
								columns: [
									{
										key: 'rank',
										label: t('col.turn'),
										render: (row) =>
											'#' +
											String(row.rank) +
											' · ' +
											t('turn') +
											' ' +
											String(row.turn.turn) +
											(row.turn.approximate === true ? ' ≈' : '')
									},
									{ key: 'usd', label: t('col.cost'), render: (row) => fmtUsd(row.turn.cost.usd.total) },
									{ key: 'req', label: t('col.requests'), render: (row) => String(row.turn.requests) },
									{ key: 'tokens', label: t('col.tokens'), render: (row) => fmtTokens(row.turn.cost.tokens.total) },
									{ key: 'out', label: t('col.out'), render: (row) => fmtTokens(row.turn.cost.tokens.out) },
									{ key: 'reasoning', label: t('col.reasoning'), render: (row) => fmtTokens(row.turn.cost.tokens.reasoning) },
									{ key: 'wall', label: t('col.time'), render: (row) => fmtDuration(row.turn.wallMs) }
								]
							}),
							approximateTurns > 0 ? e('span', { style: S.note }, t('note.approx')) : null
						)
					),
					e(
						Section,
						{ title: t('section.ratingTools') },
						e('div', { style: S.card }, e(Bars, { rows: toolRows, color: C.info, emptyLabel: t('note.noTools') }))
					)
				),
				e(
					Section,
					{ title: t('section.ratingRequests') },
					e(
						'div',
						{ style: S.card },
						e(RatingTable, {
							emptyLabel: t('note.noRequests'),
							rows: expensiveRequests.map((request, index) => ({
								key: 'req-' + String(request.turn) + '-' + String(request.step),
								rank: index + 1,
								request
							})),
							columns: [
								{
									key: 'rank',
									label: t('col.request'),
									render: (row) =>
										'#' +
										String(row.rank) +
										' · ' +
										t('turn') +
										' ' +
										String(row.request.turn) +
										'.' +
										String(row.request.step)
								},
								{ key: 'usd', label: t('col.cost'), render: (row) => fmtUsd(row.request.cost.usd.total) },
								{ key: 'model', label: t('col.model'), render: (row) => row.request.model },
								{ key: 'tokens', label: t('col.tokens'), render: (row) => fmtTokens(row.request.cost.tokens.total) },
								{ key: 'miss', label: t('row.miss'), render: (row) => fmtTokens(row.request.cost.tokens.miss) },
								{ key: 'hit', label: t('row.hit'), render: (row) => fmtTokens(row.request.cost.tokens.hit) },
								{ key: 'out', label: t('col.out'), render: (row) => fmtTokens(row.request.cost.tokens.out) },
								{ key: 'reasoning', label: t('col.reasoning'), render: (row) => fmtTokens(row.request.cost.tokens.reasoning) }
							]
						})
					)
				),
				e(
					Section,
					{ title: t('section.ratingModels') },
					e(
						'div',
						{ style: S.card },
						e(RatingTable, {
							emptyLabel: t('note.none'),
							rows: stats.models,
							columns: [
								{ key: 'model', label: t('col.model'), render: (row) => row.model + (row.provider.length > 0 ? ' · ' + row.provider : '') },
								{ key: 'turns', label: t('kpi.turns'), render: (row) => String(row.turns) },
								{ key: 'tokens', label: t('col.tokens'), render: (row) => fmtTokens(row.tokens) },
								{ key: 'out', label: t('col.out'), render: (row) => fmtTokens(row.out) },
								{ key: 'usd', label: t('col.cost'), render: (row) => fmtUsd(row.usd) },
								{ key: 'share', label: t('col.share'), render: (row) => (totals.usd > 0 ? String(Math.round((row.usd / totals.usd) * 100)) + '%' : '—') }
							]
						})
					)
				),
				e(
					Section,
					{ title: t('section.prices') },
					e(
						'div',
						{ style: S.card },
						e(
							'table',
							{ style: S.table },
							e(
								'thead',
								null,
								e(
									'tr',
									null,
									e('th', { style: S.th }, t('col.model')),
									e('th', { style: { ...S.th, textAlign: 'right' } }, t('row.miss')),
									e('th', { style: { ...S.th, textAlign: 'right' } }, t('row.hit')),
									e('th', { style: { ...S.th, textAlign: 'right' } }, t('row.write')),
									e('th', { style: { ...S.th, textAlign: 'right' } }, t('row.out'))
								)
							),
							e(
								'tbody',
								null,
								priceRows.map((row) =>
									e(
										'tr',
										{ key: row.model },
										e('td', { style: S.td }, row.model),
										e('td', { style: S.tdNum }, String(row.price.miss)),
										e('td', { style: S.tdNum }, String(row.price.hit)),
										e('td', { style: S.tdNum }, String(row.price.write)),
										e('td', { style: S.tdNum }, String(row.price.out))
									)
								)
							)
						),
						e('span', { style: S.note }, t('note.prices'))
					)
				),
				hasMore === true && typeof props.loadOlder === 'function'
					? e(
							'button',
							{
								type: 'button',
								style: S.link,
								onClick: () => {
									props.loadOlder();
								}
							},
							t('action.loadEarlier')
						)
					: null
			);
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  8. Словари / dictionaries
		 * ════════════════════════════════════════════════════════════════════ */
		const NS = 'cost';
		const ru = {
			'view.cost': 'Расход',
			'view.title': 'Расход и статистика',
			'view.subtitle': 'Считается из токенов, которые вернул провайдер, и локальной таблицы тарифов. Это оценка, а не счёт.',
			'kpi.usd': 'Стоимость ходов',
			'kpi.session': 'Вся сессия',
			'kpi.turns': 'Ходов',
			'kpi.steps': 'шагов',
			'kpi.requests': 'Запросов',
			'kpi.perRequest': 'за запрос',
			'kpi.turnsLoaded': 'загружено ходов',
			'kpi.reasoning': 'Рассуждения',
			'kpi.cache': 'Кэш',
			'kpi.speed': 'Скорость',
			'kpi.speedSub': 'выходных токенов в секунду',
			'kpi.ttft': 'TTFT',
			'kpi.ttftSub': 'среднее до первого токена',
			'kpi.wall': 'Время ходов',
			'section.tokensByTurn': 'Токены по ходам',
			'section.usdByTurn': 'Стоимость по ходам',
			'section.composition': 'Из чего состоит расход',
			'section.time': 'Куда уходит время',
			'section.context': 'Состав контекста',
			'section.ratingTurns': 'Рейтинг: самые дорогие ходы',
			'section.ratingTools': 'Рейтинг инструментов',
			'section.ratingRequests': 'Рейтинг: самые дорогие запросы',
			'section.ratingModels': 'Рейтинг моделей',
			'section.prices': 'Таблица тарифов (USD за 1 млн токенов)',
			'turn': 'ход',
			'chip.aria': 'Стоимость хода',
			'chip.title': 'Стоимость хода',
			'row.miss': 'Ввод без кэша',
			'row.hit': 'Ввод из кэша',
			'row.write': 'Запись в кэш',
			'row.out': 'Вывод',
			'row.reasoning': 'из них рассуждения',
			'row.inOutput': 'от вывода',
			'row.total': 'Итого',
			'col.bucket': 'Категория',
			'col.action': 'Действие',
			'cat.tools': 'Инструменты',
			'cat.reasoning': 'Размышления',
			'cat.read': 'Чтение и анализ',
			'section.actions': 'По чём действия',
			'section.timeline': 'Динамика: запросы, деньги и накопление',
			'metric.label': 'Метрика',
			'metric.usd': '$ в минуту',
			'metric.requests': 'Запросов в минуту',
			'metric.tokens': 'Токенов в минуту',
			'metric.cumulative': 'Накопленная стоимость',
			'bucket.label': 'Шаг',
			'range.label': 'Диапазон',
			'range.1h': '1 ч',
			'range.6h': '6 ч',
			'range.24h': '24 ч',
			'range.7d': '7 дн',
			'range.all': 'Всё',
			'step.label': 'Шаг',
			'step.auto': 'авто',
			'compress.label': 'Сжимать простои',
			'compress.hint': 'Простои длиннее 20 минут занимают фиксированную долю оси, а не всю свою длину',
			'gap.label': 'Простой',
			'gap.count': 'Простоев',
			'refresh': 'Перечитать логи',
			'source.loading': 'Источник: читаю логи…',
			'source.logs': 'Источник: логи сессий',
			'source.sessions': 'сессий',
			'source.window': 'Источник: загруженная история',
			'source.hint': 'маршрут /cost-stats/series недоступен — нужен перезапуск GUI после обновления хост-половины',
			'window.step': 'Шаг',
			'zoom.in': 'Приблизить',
			'zoom.out': 'Отдалить',
			'zoom.reset': 'Сброс',
			'window.range': 'Окно',
			'window.requests': 'Запросов',
			'window.usd': 'Стоимость окна',
			'window.avg': 'Средний темп',
			'window.peak': 'Пик',
			'window.value': 'Темп',
			'window.outside': 'Вне окна',
			'unit.perMin': '/мин',
			'note.timeline':
				'Колесо мыши — приблизить вокруг курсора, перетаскивание — сдвинуть окно, двойной щёлчок — сброс. Наведение показывает значения шага. Метрики «в минуту» нормированы на минуту при любом шаге; накопление считается от начала окна.',
			'summary.total': 'Стоимость',
			'summary.title': 'Стоимость сессии',
			'balance.label': 'На счёте',
			'balance.title': 'Остаток на счёте провайдера',
			'balance.toppedUp': 'пополнено',
			'balance.granted': 'бонус',
			'note.actions': 'Каждый запрос к модели отнесён к тому, что он делал: вызов инструмента, размышление без инструментов или чтение данных и их анализ. Цена запроса целиком идёт в одну категорию, поэтому сумма долей равна общей стоимости.',
			'note.noSplit': 'Разбивки по действиям нет: у хода не сохранились отдельные запросы.',
			'col.tokens': 'Токены',
			'col.price': 'USD / 1M',
			'col.cost': 'Стоимость',
			'col.model': 'Модель',
			'col.turn': 'Место',
			'col.requests': 'Запросов',
			'col.request': 'Место',
			'col.time': 'Время',
			'col.out': 'Вывод',
			'col.reasoning': 'Мысли',
			'col.share': 'Доля',
			'note.estimate': 'Оценка по локальному тарифу: DSH отдаёт только токены, деньги считает плагин.',
			'note.loaded': 'Загружено',
			'note.window': 'показаны последние 60 ходов',
			'note.none': 'Пока нет завершённых ходов с точным учётом токенов.',
			'note.noTiming': 'Провайдер не сообщил тайминги.',
			'note.noTools': 'В загруженной истории нет вызовов инструментов.',
			'note.noRequests': 'В загруженной истории нет запросов с учётом токенов.',
			'note.approx': '≈ — ход собран из своих шагов: точный учёт провайдера для него не попал в загруженную историю.',
			'note.approxShort': 'ход собран из запросов',
			'note.prices': 'Правьте PRICES в lib/client.js этого плагина — цифры подхватятся после перезагрузки плагина.',
			'action.loadEarlier': 'Загрузить раннюю историю',
			'state.llm': 'Время модели',
			'state.tools': 'Время инструментов',
			'ctx.system': 'Системный промпт',
			'ctx.tools': 'Схемы инструментов',
			'ctx.messages': 'Сообщения',
			'unit.tokens': 'токенов',
			'misc.mixed': 'смешанные маршруты'
		};
		const en = {
			'view.cost': 'Cost',
			'view.title': 'Cost & statistics',
			'view.subtitle': 'Computed from provider-reported tokens and the local price table. An estimate, not an invoice.',
			'kpi.usd': 'Turn cost',
			'kpi.session': 'Whole session',
			'kpi.turns': 'Turns',
			'kpi.steps': 'steps',
			'kpi.requests': 'Requests',
			'kpi.perRequest': 'per request',
			'kpi.turnsLoaded': 'turns loaded',
			'kpi.reasoning': 'Reasoning',
			'kpi.cache': 'Cache',
			'kpi.speed': 'Speed',
			'kpi.speedSub': 'output tokens per second',
			'kpi.ttft': 'TTFT',
			'kpi.ttftSub': 'average to first token',
			'kpi.wall': 'Turn time',
			'section.tokensByTurn': 'Tokens per turn',
			'section.usdByTurn': 'Cost per turn',
			'section.composition': 'What the spend is made of',
			'section.time': 'Where the time goes',
			'section.context': 'Context composition',
			'section.ratingTurns': 'Rating: most expensive turns',
			'section.ratingTools': 'Tool rating',
			'section.ratingRequests': 'Rating: most expensive requests',
			'section.ratingModels': 'Model rating',
			'section.prices': 'Price table (USD per 1M tokens)',
			'turn': 'turn',
			'chip.aria': 'Turn cost details',
			'chip.title': 'Turn cost',
			'row.miss': 'Uncached input',
			'row.hit': 'Cached input',
			'row.write': 'Cache write',
			'row.out': 'Output',
			'row.reasoning': 'of which reasoning',
			'row.inOutput': 'of output',
			'row.total': 'Total',
			'col.bucket': 'Bucket',
			'col.action': 'Action',
			'cat.tools': 'Tools',
			'cat.reasoning': 'Reasoning',
			'cat.read': 'Reading & analysis',
			'section.actions': 'What each action costs',
			'section.timeline': 'Over time: requests, money, accumulation',
			'metric.label': 'Metric',
			'metric.usd': '$ per minute',
			'metric.requests': 'Requests per minute',
			'metric.tokens': 'Tokens per minute',
			'metric.cumulative': 'Cumulative cost',
			'bucket.label': 'Step',
			'range.label': 'Range',
			'range.1h': '1 h',
			'range.6h': '6 h',
			'range.24h': '24 h',
			'range.7d': '7 d',
			'range.all': 'All',
			'step.label': 'Step',
			'step.auto': 'auto',
			'compress.label': 'Compress idle',
			'compress.hint': 'Idle stretches longer than 20 minutes take a fixed slice of the axis instead of their real length',
			'gap.label': 'Idle',
			'gap.count': 'Idle gaps',
			'refresh': 'Re-read the logs',
			'source.loading': 'Source: reading logs…',
			'source.logs': 'Source: session logs',
			'source.sessions': 'sessions',
			'source.window': 'Source: loaded history',
			'source.hint': 'the /cost-stats/series route is unavailable — the GUI needs a restart after a host-half update',
			'window.step': 'Step',
			'zoom.in': 'Zoom in',
			'zoom.out': 'Zoom out',
			'zoom.reset': 'Reset',
			'window.range': 'Window',
			'window.requests': 'Requests',
			'window.usd': 'Window cost',
			'window.avg': 'Average rate',
			'window.peak': 'Peak',
			'window.value': 'Rate',
			'window.outside': 'Outside window',
			'unit.perMin': '/min',
			'note.timeline':
				'Wheel zooms around the cursor, dragging pans the window, double click resets. Hover shows one step. Rates are per minute whatever the step; accumulation is measured from the window start.',
			'summary.total': 'Cost',
			'summary.title': 'Session cost',
			'balance.label': 'Account',
			'balance.title': 'Remaining balance on the provider account',
			'balance.toppedUp': 'topped up',
			'balance.granted': 'granted',
			'note.actions': 'Every model request is attributed to what it did: calling a tool, thinking without tools, or reading and analysing data. A request’s whole price lands in one category, so the shares add up to the total.',
			'note.noSplit': 'No action split: this turn kept no per-request ledger.',
			'col.tokens': 'Tokens',
			'col.price': 'USD / 1M',
			'col.cost': 'Cost',
			'col.model': 'Model',
			'col.turn': 'Rank',
			'col.requests': 'Requests',
			'col.request': 'Rank',
			'col.time': 'Time',
			'col.out': 'Output',
			'col.reasoning': 'Reasoning',
			'col.share': 'Share',
			'note.estimate': 'Estimated with the local price table: DSH reports tokens, the plugin does the money.',
			'note.loaded': 'Loaded',
			'note.window': 'showing the last 60 turns',
			'note.none': 'No completed turn with exact token accounting yet.',
			'note.noTiming': 'The provider reported no timings.',
			'note.noTools': 'No tool calls in the loaded history.',
			'note.noRequests': 'No requests with token accounting in the loaded history.',
			'note.approx': '≈ — the turn is summed from its steps: its exact provider accounting is not in the loaded history.',
			'note.approxShort': 'turn summed from its requests',
			'note.prices': 'Edit PRICES in this plugin’s lib/client.js — the numbers follow a plugin reload.',
			'action.loadEarlier': 'Load earlier history',
			'state.llm': 'Model time',
			'state.tools': 'Tool time',
			'ctx.system': 'System prompt',
			'ctx.tools': 'Tool schemas',
			'ctx.messages': 'Messages',
			'unit.tokens': 'tokens',
			'misc.mixed': 'mixed routes'
		};

		/* ════════════════════════════════════════════════════════════════════
		 *  9. Плагин / plugin body
		 * ════════════════════════════════════════════════════════════════════ */
		/** Required services: slot registry, locale registry, conversation targets, session sources. */
		const inject = ['slots', 'locale', 'uiConversation', 'uiSession', 'sessions'];

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-cost-stats: dictionaries');

				/* Per-session cost ledger over the Conversation targets: the Chat target
				 * supplies exact per-turn accounting and the tool ledger, the Trajectory
				 * target supplies exact per-request usage with route attribution. The
				 * fold is memoized by target-snapshot identity, so it is a stable uSES
				 * source for every consumer. */
				const sources = new WeakMap();
				const costSource = (binding) => {
					let source = sources.get(binding);
					if (source !== undefined) return source;
					const targetOf = (name) => {
						try {
							return ctx.uiConversation.binding(binding).target(name);
						} catch (error) {
							ctx.logger.warn('dsh-cost-stats: conversation target "' + name + '" unavailable', error);
							return undefined;
						}
					};
					const chat = targetOf('chat');
					const trajectory = targetOf('trajectory');
					let lastChat;
					let lastRequests;
					let lastStats = EMPTY_STATS;
					source = {
						getSnapshot: () => {
							if (chat === undefined) return EMPTY_STATS;
							let chatSnapshot;
							try {
								chatSnapshot = chat.getSnapshot();
							} catch (error) {
								return EMPTY_STATS;
							}
							if (chatSnapshot === undefined || chatSnapshot === null) return EMPTY_STATS;
							let requests;
							if (trajectory !== undefined) {
								try {
									const snapshot = trajectory.getSnapshot();
									requests = snapshot === null || snapshot === undefined ? undefined : snapshot.requests;
								} catch (error) {
									requests = undefined;
								}
							}
							if (chatSnapshot !== lastChat || requests !== lastRequests) {
								lastChat = chatSnapshot;
								lastRequests = requests;
								try {
									lastStats = deriveStats(chatSnapshot, requests);
								} catch (error) {
									ctx.logger.warn('dsh-cost-stats: derivation failed', error);
									lastStats = EMPTY_STATS;
								}
							}
							return lastStats;
						},
						subscribe: (listener) => {
							const disposers = [];
							for (const target of [chat, trajectory]) {
								if (target === undefined) continue;
								try {
									disposers.push(target.subscribe(listener));
								} catch (error) {
									// A target that cannot be subscribed simply stops contributing.
								}
							}
							return () => {
								for (const dispose of disposers) {
									try {
										dispose();
									} catch (error) {
										// Unsubscribing twice is not an error worth surfacing.
									}
								}
							};
						}
					};
					sources.set(binding, source);
					return source;
				};

				ctx.uiSession.provide({
					hooks: ['cost'],
					resolve: (binding) => ({ hooks: { cost: costSource(binding) } })
				});

				const t = ctx.locale.bind(NS);

				/* The chat-side pill. The action list is the reliable seat: the turn-tail
				 * chain stops at its first accepting selector, and the shipped deliverables
				 * selector claims every turn that produced files. The chain entry stays as
				 * a fallback for turns nothing else claims. */
				ctx.slots.inject('conversation.chat.assistant-actions', () =>
					ctx.slots.register(
						{
							name: 'conversation.chat.assistant-actions',
							id: 'cost-stats',
							locale: NS
						},
						TurnCostAction
					)
				);
				/* Session scope under the composer, to the right of the shipped stats pills. */
				ctx.slots.inject('conversation.composer.dock', () =>
					ctx.slots.register(
						{
							name: 'conversation.composer.dock',
							id: 'cost-stats',
							order: 10,
							locale: NS
						},
						CostSummary
					)
				);
				ctx.slots.inject('conversation.chat.turnTail', () =>
					ctx.slots.register(
						{
							name: 'conversation.chat.turnTail',
							id: 'cost-stats',
							locale: NS
						},
						TurnCostChip
					)
				);

				/* The tab next to the action graph (chat = 0, trajectory = 10). */
				ctx.slots.inject('conversation.view', () =>
					ctx.slots.register(
						{
							name: 'conversation.view',
							id: 'cost',
							order: 20,
							locale: NS,
							label: () => t('view.cost'),
							inject: (sessionId) => {
								let session;
								try {
									session = ctx.sessions.binding(sessionId)?.session;
								} catch (error) {
									session = undefined;
								}
								return {
									loadOlder: async () => {
										if (session === undefined) return;
										await session.loadOlder();
									}
								};
							}
						},
						CostView
					)
				);
			} catch (error) {
				ctx.logger.error('dsh-cost-stats: mount failed', error);
			}
		}

		exports.name = 'dsh-cost-stats';
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
