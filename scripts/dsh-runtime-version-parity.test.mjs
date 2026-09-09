import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

// The DSH runtime version is pinned by exactly two constants, and they must
// hold the same value: the market install gate (`DSH_RUNTIME_VERSION` in
// dsh-community-market/src/install/service.ts, which classifies every plugin
// install against the runtime family the shipped desktop build supports) and
// the desktop boot classification pin (`DESKTOP_BOOT_DSH_RUNTIME_VERSION` in
// dsh-plugin-desktop/src/boot-verification.ts, which decides update targets
// and the deferred client-update window). A drift makes boot advertise
// updates the install gate then refuses — so the pair is asserted here
// instead of being trusted to release discipline.
//
// Why a text-level cross-assertion and not one shared exported constant: the
// desktop TypeScript program deliberately resolves `dsh-community-market` to
// the local type facade `dsh-plugin-desktop/src/market-signing-types.ts`
// (see that file's header), so a value import would add a third hand-synced
// declaration and require rebuilding the market workspace output before any
// desktop test or typecheck could see it. This gate gives the same "bump one
// literal, CI goes red" guarantee with no coupling, and it lives beside the
// other cross-workspace invariant (market-dependency-direction) under
// `yarn check:layout` / `yarn test:architecture-gates`.

const root = resolve(import.meta.dirname, '..')

/** The pinned string literal of one named `const` declaration in a source file. */
function pinnedLiteral(path, constantName) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${constantName}\\s*=\\s*(['"])([^'"]+)\\1`, 'u')
  const match = source.match(pattern)
  assert.ok(
    match !== null,
    `${path} must declare const ${constantName} with a plain string literal for this gate to read`,
  )
  return match[2]
}

test('desktop boot pin equals the market install-gate DSH runtime version', () => {
  const desktopPath = 'dsh-plugin-desktop/src/boot-verification.ts'
  const marketPath = 'dsh-community-market/src/install/service.ts'
  const desktop = pinnedLiteral(desktopPath, 'DESKTOP_BOOT_DSH_RUNTIME_VERSION')
  const market = pinnedLiteral(marketPath, 'DSH_RUNTIME_VERSION')
  assert.equal(
    desktop,
    market,
    `DSH runtime pin drifted: ${desktopPath} pins ${desktop} while ${marketPath} pins ${market}; `
      + 'boot update prompts and the market install gate would classify installs differently '
      + '— bump both constants in the same change',
  )
})
