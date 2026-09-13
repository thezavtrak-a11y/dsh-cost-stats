/**
 * dsh-cost-stats — host half.
 *
 * The feature is browser-only. This Node half exists so the host loader can
 * mount the package (via `cordis.patch.yml`) and the client-modules scanner can
 * find its `dsh.client` declaration and serve `lib/client.js` to the browser,
 * where the per-turn cost chip and the cost/statistics view tab register
 * against the official DSH slot, session-source and locale registries.
 *
 * Nothing on the host is patched: no upstream file, no installation
 * `node_modules`. Pricing lives in the browser bundle (`lib/client.js`,
 * `PRICES`) because DSH reports token counts but never a monetary amount.
 *
 * @module dsh-cost-stats
 */

/** Stable plugin name used by the cordis loader row. */
export const name = 'dsh-cost-stats'

/**
 * Host-side body. There is nothing to do on the host: token accounting arrives
 * in the browser through the existing `tokenUsage` / `sessionStats` session
 * projections, and every price table entry is a client-side constant.
 */
export function apply() {
  // Intentionally empty on the host side.
}
