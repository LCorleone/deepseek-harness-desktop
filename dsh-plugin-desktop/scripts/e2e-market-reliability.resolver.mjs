/**
 * ESM resolver hook for `scripts/e2e-market-reliability.mjs` child roles.
 *
 * The reliability batch exercises today's fixes at their source of truth: the
 * market host routes (`dsh-community-market/src/host/routes.ts`) and the
 * locked plugin-add gate (`dsh-plugin-desktop/src/cli-install-channel.ts`).
 * The market package's built `lib/` tree can lag those sources (it is built
 * on demand and not committed), so a child that imported the package would
 * silently test yesterday's behavior. This hook keeps the children on the
 * workspace sources instead:
 *
 *   - the bare specifier `dsh-community-market` resolves to the workspace
 *     `src/index.ts`, and
 *   - the market sources' NodeNext relative imports (spelled `./x.js` but
 *     living at `./x.ts`) resolve to their `.ts` files.
 *
 * Everything else keeps Node's default resolution. The children run under
 * `node --experimental-transform-types` (the market sources use parameter
 * properties, which strip-only mode refuses), and only the children register
 * this hook; the parent orchestrator imports no workspace module at all.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const marketPackageSpecifier = 'dsh-community-market'
const marketSrc = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-community-market', 'src') + '/',
).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === marketPackageSpecifier) {
    return { url: `${marketSrc}index.ts`, shortCircuit: true }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../'))
    && specifier.endsWith('.js')
    && context.parentURL !== undefined
    && context.parentURL.startsWith(marketSrc)
  ) {
    const candidate = pathToFileURL(
      join(dirname(fileURLToPath(context.parentURL)), specifier.replace(/\.js$/u, '.ts')),
    ).href
    if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
