/**
 * Reference-environment tree-digest measurement for the company catalog.
 *
 * Measures the `treeDigest` the signed manifest pins for allowlist entries:
 * for every entry without one (or every entry with `--all`), install the exact
 * version into a temporary profile that mirrors what a DSH Desktop profile
 * looks like — the upstream scaffold (package.json + pnpm-workspace.yaml with
 * the hoisted linker) plus the build-approval merge — using the repository's
 * pinned pnpm (the dsh-plugin-desktop `pnpm` dependency, the same release the
 * desktop ships) against the pinned official registry, then hash the installed
 * package tree with the compiled boot-verification chunk's
 * `computeDesktopBootTreeRootDigest` — the exact function the desktop's boot
 * verification and install receipts use. Plain Node script, no build step of
 * its own; run it from the repository root after `corepack yarn install` and
 * `corepack yarn workspace dsh-plugin-desktop build` (or point --desktop-lib
 * at an unpacked packaged artifact's lib tree).
 *
 * Output: `[{packageName, version, treeDigest}, …]` written to --out (the
 * `measure-and-publish --digest-file` input) plus a console table. The
 * reviewed allowlist is never modified; landing a measured digest in it stays
 * a human review commit.
 *
 * Usage:
 *   node tools/company-catalog/measure.mjs [--allowlist <path>] [--out <json>]
 *                                          [--desktop-lib <dir>] [--all]
 *                                          [--electron-target <version>] [--keep]
 *
 * `--electron-target` mirrors the desktop's pnpm runtime (npm_config_runtime=
 * electron + headers disturl) for plugins whose dependencies ship prebuilt
 * native binaries; pure-JS plugins measure identically without it.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { entryKey, loadAllowlist } from './lib/allowlist.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const NPM_REGISTRY = 'https://registry.npmjs.org/'
const INSTALL_TIMEOUT_MS = 600_000
/** Environment keys stripped from the pnpm child (runner/ambient pollution). */
const STRIPPED_ENVIRONMENT_PATTERN = /^(?:ELECTRON_RUN_AS_NODE|NPM_CONFIG_REGISTRY|npm_config_registry|NPM_CONFIG_RUNTIME|npm_config_runtime|NPM_CONFIG_TARGET|npm_config_target|NPM_CONFIG_DISTURL|npm_config_disturl|DSH_HOME|DSH_DESKTOP_.*)$/i
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

const USAGE = `Usage: node tools/company-catalog/measure.mjs [options]

Options:
  --allowlist <path>        Allowlist file (default: tools/company-catalog/allowlist.json);
                            entries without a treeDigest are measured
  --out <json>              Write the digest records here (the measure-and-publish
                            --digest-file input); always written, even when empty
  --desktop-lib <dir>       Compiled desktop lib tree holding the boot-verification
                            chunk (default: <repo>/dsh-plugin-desktop/lib; a packaged
                            artifact's resources/app.asar.unpacked/lib works too)
  --all                     Re-measure every entry, including ones that already pin a
                            treeDigest; a mismatch against the reviewed value fails
  --electron-target <ver>   Mirror the desktop pnpm runtime for native prebuilds
  --keep                    Keep the temporary profiles for inspection
  help                      Show this help`

const fail = (message) => {
  console.error(`company-catalog-measure: ${message}`)
  process.exitCode = 1
}

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`. */
function parseArgs(argv) {
  const flags = {}
  const valueFlags = new Set(['allowlist', 'out', 'desktop-lib', 'electron-target'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument '${argument}'`)
    const equals = argument.indexOf('=')
    const name = (equals === -1 ? argument.slice(2) : argument.slice(2, equals))
    if (!valueFlags.has(name)) {
      if (equals !== -1) throw new Error(`--${name} does not take a value`)
      flags[name] = true
      continue
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined) throw new Error(`--${name} requires a value`)
    if (equals === -1) index += 1
    flags[name] = value
  }
  return flags
}

/** The upstream profile scaffold a fresh desktop profile ships (E2E c-step template). */
function scaffoldProfile(profileDir, name) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
}

/** Sanitized child environment (no ambient DSH/registry/runtime overrides). */
function childEnvironment(electronTarget) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENVIRONMENT_PATTERN.test(key)) continue
    env[key] = value
  }
  if (electronTarget !== undefined) {
    env.npm_config_runtime = 'electron'
    env.npm_config_target = electronTarget
    env.npm_config_disturl = ELECTRON_HEADERS_URL
  }
  return env
}

/**
 * Resolve one exported function from a compiled lib module by its original
 * name. Rollup mangles export aliases (and chunk hashes change between
 * builds) while function declarations keep their names; exported namespaces
 * may also carry re-exported namespaces whose properties are accessors, so
 * resolve through plain property access — the E2E smoke's stable contract.
 */
function exportedFunctionFromNamespace(moduleNamespace, name) {
  for (const value of Object.values(moduleNamespace)) {
    if (typeof value === 'function' && value.name === name) return value
    if (value !== null && typeof value === 'object') {
      const nested = value[name]
      if (typeof nested === 'function' && nested.name === name) return nested
    }
  }
  throw new Error(`the compiled lib module does not export a function named ${name}`)
}

/** Find one compiled chunk file below a lib tree by name prefix. */
function libChunk(libDir, prefix) {
  if (!existsSync(libDir)) {
    throw new Error(`desktop lib tree not found: ${libDir} — run 'corepack yarn workspace dsh-plugin-desktop build' or pass --desktop-lib`)
  }
  const candidate = readdirSync(libDir).find((entry) => new RegExp(`^${prefix}.*\\.js$`, 'u').test(entry))
  if (candidate === undefined) {
    throw new Error(`the desktop lib tree ${libDir} has no ${prefix}*.js chunk`)
  }
  return join(libDir, candidate)
}

/**
 * The repository's pinned pnpm: the dsh-plugin-desktop `pnpm` dependency is
 * the exact release the desktop bundles and installs plugins with, so the
 * reference measurement must use it too — never an ambient pnpm.
 */
function resolvePinnedPnpm() {
  const desktopPackage = JSON.parse(readFileSync(join(REPO_ROOT, 'dsh-plugin-desktop', 'package.json'), 'utf8'))
  const pin = desktopPackage.dependencies?.pnpm
  if (typeof pin !== 'string') throw new Error('dsh-plugin-desktop does not pin a pnpm dependency')
  for (const moduleDir of [
    join(REPO_ROOT, 'dsh-plugin-desktop', 'node_modules', 'pnpm'),
    join(REPO_ROOT, 'node_modules', 'pnpm'),
  ]) {
    const manifestPath = join(moduleDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version
    if (version !== pin) {
      throw new Error(`the installed pnpm at ${moduleDir} is ${version}, but the repository pins ${pin} — run 'corepack yarn install --immutable'`)
    }
    return { bin: join(moduleDir, 'bin', 'pnpm.mjs'), version, pin }
  }
  throw new Error(`the pinned pnpm ${pin} is not installed (looked in dsh-plugin-desktop/node_modules and the root) — run 'corepack yarn install --immutable' first`)
}

/** Install one exact version into a fresh profile and measure its tree digest. */
function measureEntry({ target, profileDir, pnpm, lib, electronTarget }) {
  scaffoldProfile(profileDir, 'measure')
  // Parity with a real desktop profile: the build-approval merge the launcher
  // applies to every profile before any install (compiled packaged lib).
  lib.ensureProfilePnpmBuildApproval(profileDir)
  const probe = spawnSync(process.execPath, [
    pnpm.bin,
    'add',
    '--save-exact',
    '--registry',
    NPM_REGISTRY,
    `${target.packageName}@${target.version}`,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: INSTALL_TIMEOUT_MS,
    env: childEnvironment(electronTarget),
    cwd: profileDir,
  })
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  if (probe.error !== undefined && probe.status === null) {
    throw new Error(`pnpm ${pnpm.version} could not run (${probe.error.message})`)
  }
  if (probe.status !== 0) {
    throw new Error(`pnpm add ${target.packageName}@${target.version} exited ${String(probe.status)}: ${output.trim().split('\n').slice(-5).join(' | ').slice(0, 500)}`)
  }
  // The hoisted linker places the package at profile/node_modules/<name>;
  // verify the installed manifest before measuring so a resolution surprise
  // can never hash the wrong tree.
  const packageDir = join(profileDir, 'node_modules', ...target.packageName.split('/'))
  const installedPath = join(packageDir, 'package.json')
  if (!existsSync(installedPath)) {
    throw new Error(`${target.packageName} did not land at ${packageDir} after the install`)
  }
  const installed = JSON.parse(readFileSync(installedPath, 'utf8'))
  if (installed.name !== target.packageName || installed.version !== target.version) {
    throw new Error(`installed ${String(installed.name)}@${String(installed.version)} instead of ${entryKey(target)}`)
  }
  const digest = lib.computeDesktopBootTreeRootDigest(packageDir)
  // The profile's dependency must be pinned exactly, exactly like the
  // desktop CLI's audited install.
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  if (profileManifest.dependencies?.[target.packageName] !== target.version) {
    throw new Error(`profile dependency pin for ${target.packageName} is ${JSON.stringify(profileManifest.dependencies?.[target.packageName])}, expected ${target.version}`)
  }
  return digest
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('help') || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const flags = parseArgs(argv)
  if (flags.help === true) {
    console.log(USAGE)
    return
  }
  const allowlistPath = flags.allowlist !== undefined ? resolve(process.cwd(), flags.allowlist) : join(TOOL_DIR, 'allowlist.json')
  const entries = loadAllowlist(allowlistPath)
  const targets = entries.filter((entry) => flags.all === true || entry.treeDigest === undefined)
  const skipped = entries.filter((entry) => !targets.includes(entry))
  if (targets.length === 0) {
    console.log(`measure: every allowlist entry already pins a treeDigest (${entries.map(entryKey).join(', ')}); nothing to measure${flags.all === true ? '' : ' — pass --all to re-measure'}`)
    if (flags.out !== undefined) writeFileSync(resolve(process.cwd(), flags.out), '[]\n', 'utf8')
    return
  }
  const pnpm = resolvePinnedPnpm()
  const libDir = flags['desktop-lib'] !== undefined ? resolve(process.cwd(), flags['desktop-lib']) : join(REPO_ROOT, 'dsh-plugin-desktop', 'lib')
  const bootVerification = await import(pathToFileURL(libChunk(libDir, 'boot-verification-')).href)
  const profilePolicy = await import(pathToFileURL(libChunk(libDir, 'profile-pnpm-policy-')).href)
  const lib = {
    computeDesktopBootTreeRootDigest: exportedFunctionFromNamespace(bootVerification, 'computeDesktopBootTreeRootDigest'),
    ensureProfilePnpmBuildApproval: exportedFunctionFromNamespace(profilePolicy, 'ensureProfilePnpmBuildApproval'),
  }
  const electronTarget = flags['electron-target']
  console.log(`measure: ${String(targets.length)} target(s) with pnpm ${pnpm.version} (repository pin) · registry ${NPM_REGISTRY} · digest from ${libDir}`)
  const root = mkdtempSync(join(tmpdir(), 'company-catalog-measure-'))
  const records = []
  const failures = []
  try {
    for (const [index, target] of targets.entries()) {
      const profileDir = join(root, `profile-${String(index)}-${target.packageName.replace('/', '__')}`)
      try {
        const treeDigest = measureEntry({ target, profileDir, pnpm, lib, electronTarget })
        records.push({ packageName: target.packageName, version: target.version, treeDigest })
        const reviewed = target.treeDigest
        const relation = reviewed === undefined ? 'filled (was missing)' : reviewed === treeDigest ? 'matches the reviewed value' : 'MISMATCH'
        console.log(`  ${entryKey(target)}`)
        console.log(`    treeDigest: ${treeDigest} (${relation})`)
        if (reviewed !== undefined && reviewed !== treeDigest) {
          failures.push(`${entryKey(target)}: measured ${treeDigest} but the allowlist pins ${reviewed}`)
        }
      } catch (error) {
        failures.push(`${entryKey(target)}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (flags.keep === true || process.env.DSH_MEASURE_KEEP === '1') {
          console.log(`    kept profile: ${profileDir}`)
        } else {
          rmSync(profileDir, { recursive: true, force: true })
        }
      }
    }
  } finally {
    if (flags.keep === true || process.env.DSH_MEASURE_KEEP === '1') {
      console.log(`measure: kept the measurement root ${root}`)
    } else {
      rmSync(root, { recursive: true, force: true })
    }
  }
  records.sort((a, b) => (a.packageName === b.packageName ? (a.version < b.version ? -1 : 1) : a.packageName < b.packageName ? -1 : 1))
  if (flags.out !== undefined) {
    const outPath = resolve(process.cwd(), flags.out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    console.log(`measure: ${String(records.length)} digest record(s) written to ${outPath}`)
  }
  console.log('measure: digest records (feed to measure-and-publish --digest-file):')
  for (const record of records) console.log(`  ${record.packageName}@${record.version}  ${record.treeDigest}`)
  if (skipped.length > 0) console.log(`measure: skipped ${String(skipped.length)} entr${skipped.length === 1 ? 'y' : 'ies'} already pinning a treeDigest (${skipped.map(entryKey).join(', ')})`)
  if (failures.length > 0) {
    for (const failure of failures) fail(failure)
    return
  }
  if (records.length === 0) {
    fail('no entry could be measured')
  }
}

await main()
