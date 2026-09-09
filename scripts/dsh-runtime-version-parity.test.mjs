import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
// desktop test or typecheck could see it. These gates give the same "bump one
// literal, CI goes red" guarantee with no coupling, and they live beside the
// other cross-workspace invariant (market-dependency-direction) under
// `yarn check:layout` / `yarn test:architecture-gates`.
//
// Two invariants live here:
//
// 1. The constant pair: `DSH_RUNTIME_VERSION` (market install gate) equals
//    `DESKTOP_BOOT_DSH_RUNTIME_VERSION` (desktop boot classification).
// 2. The runtime-window predicate pair: `entryAcceptsDshRuntime` exists once
//    per workspace (the market copy is the single shared implementation for
//    the catalog view and the signed-manifest install gate; the desktop copy
//    in boot-verification must stay — the cross-package direction ban
//    forbids sharing one function), and both copies must accept the same
//    (runtime, range) samples with the same verdicts. Each side's extracted
//    implementation is evaluated against the semver build that side actually
//    resolves, so a comparator drift (dropped includePrerelease, swapped
//    arguments, a semver major bump on one side) goes red here — pinned to
//    an absolute expected table, not just mutual agreement, so a symmetric
//    drift on both sides is caught too.

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

// --- Runtime-window predicate parity -------------------------------------

/** The (runtime, range) sample table both workspace predicates must agree on. */
const RUNTIME_WINDOW_SAMPLES = [
  // The current line's own pin — the prerelease acceptance only
  // `includePrerelease` grants; dropping the flag flips this to false.
  { runtimeVersion: '0.1.2-rc.1', range: '^0.1.2-rc.1', accepted: true },
  // The old-line boundary shape the fleet fixtures use: the upper bound
  // must exclude the new prerelease line explicitly.
  { runtimeVersion: '0.1.2-rc.1', range: '>=0.1.1 <0.1.2-rc.1', accepted: false },
  { runtimeVersion: '0.1.1', range: '>=0.1.1 <0.1.2-rc.1', accepted: true },
  // A pin of another runtime line is simply incompatible.
  { runtimeVersion: '0.1.2-rc.1', range: '^0.1.3', accepted: false },
  { runtimeVersion: '0.1.1', range: '^0.1.2-rc.1', accepted: false },
  // The includePrerelease discriminator: the pinned runtime is itself a
  // prerelease, so a plain caret range of the older line — no explicit
  // upper bound — accepts this machine only through the flag; dropping
  // `includePrerelease` flips both of these to false.
  { runtimeVersion: '0.1.2-rc.1', range: '^0.1.1', accepted: true },
  { runtimeVersion: '0.1.3-alpha.1', range: '<0.2.0', accepted: true },
  // Composite ranges and prerelease tilde matches.
  { runtimeVersion: '0.2.0', range: '^0.1.2-rc.1 || ^0.2.0', accepted: true },
  { runtimeVersion: '0.1.2-rc.2', range: '~0.1.2-rc.1', accepted: true },
  // Inputs the comparator refuses are "incompatible", never a failure.
  { runtimeVersion: 'garbage-version', range: '^0.1.2-rc.1', accepted: false },
  { runtimeVersion: '0.1.2-rc.1', range: 'not a range', accepted: false },
]

/**
 * Extract the `entryAcceptsDshRuntime` implementation of one TypeScript
 * source file and evaluate it as plain JavaScript against the given
 * `satisfies`. The extraction is deliberately dumb — signature types
 * stripped, body brace-counted — so any refactor that renames, moves, or
 * rewrites the predicate fails this gate loudly instead of silently
 * desynchronizing the two comparators.
 */
function extractedRuntimePredicate(path, satisfies) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const signature = /function\s+entryAcceptsDshRuntime\s*\(([^)]*)\)\s*(?::[^{]*)?\{/u
  const match = source.match(signature)
  assert.ok(
    match !== null,
    `${path} must declare function entryAcceptsDshRuntime with a plain function signature for this gate to read`,
  )
  const parameters = match[1].split(',').map(parameter => (parameter.split(':')[0] ?? '').trim())
  const bodyStart = match.index + match[0].length
  let depth = 1
  let bodyEnd = bodyStart
  while (depth > 0 && bodyEnd < source.length) {
    const character = source[bodyEnd]
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    bodyEnd += 1
  }
  const body = source.slice(bodyStart, bodyEnd - 1)
  assert.ok(body.includes('satisfies('), `${path}: the extracted predicate body looks truncated`)
  const factory = new Function('satisfies', `return function (${parameters.join(', ')}) {\n${body}\n }`)
  return factory(satisfies)
}

test('market and desktop runtime-window predicates render the same verdicts on the same (runtime, range) samples', () => {
  const marketPath = 'dsh-community-market/src/catalog/company-provider.ts'
  const desktopPath = 'dsh-plugin-desktop/src/boot-verification.ts'
  // Each side is evaluated with the semver build that workspace actually
  // resolves, so the gate also catches a one-sided semver major drift.
  const marketSatisfies = createRequire(resolve(root, 'dsh-community-market/package.json'))('semver').satisfies
  const desktopSatisfies = createRequire(resolve(root, 'dsh-plugin-desktop/package.json'))('semver').satisfies
  const marketPredicate = extractedRuntimePredicate(marketPath, marketSatisfies)
  const desktopPredicate = extractedRuntimePredicate(desktopPath, desktopSatisfies)

  for (const { runtimeVersion, range, accepted } of RUNTIME_WINDOW_SAMPLES) {
    const entry = { runtime: { dshRuntimeVersion: range } }
    for (const [path, predicate] of [
      [marketPath, marketPredicate],
      [desktopPath, desktopPredicate],
    ]) {
      assert.equal(
        predicate(entry, runtimeVersion),
        accepted,
        `${path}: entryAcceptsDshRuntime must ${accepted ? 'accept' : 'reject'} runtime ${runtimeVersion} `
          + `against range ${range} — the market catalog view, the market install gate, and the desktop boot `
          + 'classification would disagree about this machine; mirror the comparator change on both sides',
      )
    }
  }
})
