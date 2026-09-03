/**
 * Headless E2E install-chain smoke for a packaged DSH Desktop artifact.
 *
 * Runs against the unpacked application directory produced by electron-builder
 * (`dist/win-unpacked` on Windows CI, `dist/linux-unpacked` for a local
 * `--dir` package) and verifies, entirely without a GUI, the install-chain
 * regressions the pilot week surfaced:
 *
 *   a. artifact structure — bundled Node command, in-ASAR policy (locked),
 *      signed company catalog manifest verified by the packaged market lib;
 *   b. CLI policy chain — the packaged policy emitter and parser must
 *      round-trip first (b0, the launcher hand-off truth pair), then the
 *      bundled Node runs `desktop-cli.js` with that launcher-shaped
 *      `DSH_DESKTOP_POLICY_*` hand-off (sentinel trust roots); `--version`
 *      must answer, and a locked `plugin add` outside the signed catalog
 *      must fail closed without touching the network;
 *   c. real install — a temporary `DSH_HOME` profile (upstream template),
 *      `ensureProfilePnpmBuildApproval` through the compiled packaged lib,
 *      then a real `plugin add ms@2.1.3` through pnpm against the npm
 *      registry (SKIP, not FAIL, when the registry is unreachable);
 *   d. boot verification — the packaged boot-verification pure functions
 *      over the temporary profile with a test-keyed signed manifest
 *      (the key-generation pattern of tests/boot-verification.spec.ts).
 *
 * Exit semantics: 0 when every executed step passed (SKIPs do not fail;
 * CI runs with an isolated network must not go red), 1 on any structural
 * failure or a missing artifact. Set `DSH_E2E_INSTALL_DIST` to point at an
 * unpacked application directory that is not auto-detected.
 *
 * Usage (repository root, after `yarn package:dir` or a Windows `dist:win`):
 *   node dsh-plugin-desktop/scripts/e2e-install-smoke.mjs
 *   yarn e2e:install-smoke
 *
 * CI: the "E2E install smoke" step of .github/workflows/windows-package.yml
 * runs this script against the `dist/win-unpacked` tree the installer build
 * already produced; the step is advisory (`continue-on-error`) so a failure
 * stays visible without blocking the artifact upload.
 */

import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { sep as pathSep } from 'node:path'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(scriptRoot)
const FIXTURE_PACKAGE = 'ms'
const FIXTURE_VERSION = '2.1.3'
const BOOT_FIXTURE_PACKAGE = 'dsh-e2e-boot-fixture'
const BOOT_FIXTURE_VERSION = '0.4.2'
const BOOT_FIXTURE_INTEGRITY = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`
const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const REGISTRY_PROBE_TIMEOUT_MS = 10_000
const CLI_SMOKE_TIMEOUT_MS = 60_000
const REAL_INSTALL_TIMEOUT_MS = 300_000
/** Environment keys stripped from child environments (runner/ambient pollution). */
const STRIPPED_ENVIRONMENT_PATTERN = /^(?:ELECTRON_RUN_AS_NODE|NPM_CONFIG_RUNTIME|NPM_CONFIG_TARGET|NPM_CONFIG_DISTURL|DSH_HOME|DSH_DESKTOP_.*)$/i

const passes = []
const skips = []
const failures = []

function pass(id, summary) {
  passes.push(id)
  console.log(`[PASS] ${id} ${summary}`)
}

function skip(id, reason) {
  skips.push({ id, reason })
  console.log(`[SKIP] ${id} ${reason}`)
}

function fail(id, reason) {
  failures.push({ id, reason })
  console.log(`[FAIL] ${id} ${reason}`)
}

function fatal(message) {
  console.error(`dsh-e2e-install-smoke: ${message}`)
  process.exit(1)
}

/** Locate the unpacked application directory and its resources/asar paths. */
function resolveArtifact() {
  const candidates = []
  const override = process.env.DSH_E2E_INSTALL_DIST
  if (override !== undefined && override.length > 0) candidates.push(override)
  candidates.push(join(packageRoot, 'dist', 'win-unpacked'))
  candidates.push(join(packageRoot, 'dist', 'linux-unpacked'))
  // macOS `--dir` output keeps resources under dist/mac/<Name>.app/Contents.
  const macRoot = join(packageRoot, 'dist', 'mac')
  if (existsSync(macRoot)) {
    for (const entry of readdirSync(macRoot)) {
      if (entry.endsWith('.app')) candidates.push(join(macRoot, entry))
    }
  }
  for (const applicationDir of candidates) {
    const asarPath = existsSync(join(applicationDir, 'resources', 'app.asar'))
      ? join(applicationDir, 'resources', 'app.asar')
      : join(applicationDir, 'Contents', 'Resources', 'app.asar')
    if (existsSync(asarPath)) {
      return {
        applicationDir,
        resourcesDir: dirname(asarPath),
        asarPath,
        unpackedRoot: `${asarPath}.unpacked`,
      }
    }
  }
  fatal(
    'no packaged application found (looked for dist/win-unpacked, dist/linux-unpacked, dist/mac/*.app'
    + `${override === undefined ? '' : `, ${override}`}); run 'yarn package:dir' (or a Windows 'yarn workspace dsh-plugin-desktop dist:win') first`,
  )
}

/** Read the pinned bundled-Node version from the packaging hook source. */
function pinnedBundledNodeVersion() {
  const source = readFileSync(join(scriptRoot, 'bundled-node.ts'), 'utf8')
  const pinned = /BUNDLED_NODE_VERSION\s*=\s*'([^']+)'/.exec(source)?.[1]
  if (pinned === undefined) {
    fatal('cannot read BUNDLED_NODE_VERSION from scripts/bundled-node.ts')
  }
  return pinned
}

/** Normalize ASAR listing entries the way scripts/verify-packaged-runtime.ts does. */
function normalizeArchiveEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Windows-packed archives store entry paths with backslashes, so
 * extractFile must receive the stored spelling rather than the normalized
 * POSIX form used for matching.
 */
let archiveEntries = []
function extractArchiveFile(posixPath) {
  const stored = archiveEntries.find(entry => normalizeArchiveEntry(entry) === posixPath)
  if (stored === undefined) {
    throw new Error(`"${posixPath}" was not found in this archive`)
  }
  // @electron/asar 3.x searchNodeFromPath splits on path.sep, so hand it the
  // platform-native separator form (backslashes on Windows) of the entry.
  return extractFile(artifact.asarPath, normalizeArchiveEntry(stored).split('/').join(pathSep))
}

/** Find one compiled chunk file below the packaged lib tree by name prefix. */
function packagedLibChunk(prefix) {
  const candidate = readdirSync(join(artifact.unpackedRoot, 'lib'))
    .find(entry => new RegExp(`^${prefix}.*\\.js$`, 'u').test(entry))
  if (candidate === undefined) {
    throw new Error(`the packaged lib tree has no ${prefix}*.js chunk`)
  }
  return join(artifact.unpackedRoot, 'lib', candidate)
}

/**
 * Path of the packaged desktop-policy module. Builds emit either a plain
 * `desktop-policy.js` or a hash-suffixed shared chunk
 * (`desktop-policy-<hash>.js`), so accept both spellings.
 */
function packagedDesktopPolicyModulePath() {
  const libDir = join(artifact.unpackedRoot, 'lib')
  const candidate = readdirSync(libDir)
    .filter(entry => /^desktop-policy(?:-.*)?\.js$/u.test(entry))
    .sort((left, right) => left.length - right.length)[0]
  if (candidate === undefined) {
    throw new Error('the packaged lib tree has no desktop-policy module')
  }
  return join(libDir, candidate)
}

/** Build a sanitized child environment (no ambient DSH/runner overrides). */
function childEnvironment() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENVIRONMENT_PATTERN.test(key)) continue
    env[key] = value
  }
  return env
}

/**
 * Run one command with a hard timeout; returns stdout, stderr, and status.
 * A timeout surfaces as status null (never a hang).
 */
function runTimed(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs,
    env: options.env,
    cwd: options.cwd,
  })
  if (result.error !== undefined && result.status === null && result.signal === null) {
    return { status: null, stdout: '', stderr: `${result.error.message}` }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.status === null,
  }
}

/** Whether one failed install attempt looks like a network outage. */
function looksLikeNetworkFailure(output) {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNABORTED|EPROTO|CERT|getaddrinfo|network|ERR_PNPM_[A-Z_]*FETCH/iu.test(output)
}

/** Read the Electron version the desktop launcher pins for pnpm shims. */
function readHostElectronVersion() {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

/**
 * Resolve one exported function from a compiled lib module by its original
 * name. Rollup mangles export aliases (and chunk hashes change between
 * builds) while function declarations keep their names, and chunk modules
 * re-export a full original-named namespace, so a name search over the
 * module namespace stays stable across rebuilds.
 */
function exportedFunctionFromNamespace(moduleNamespace, name) {
  for (const value of Object.values(moduleNamespace)) {
    if (typeof value === 'function' && value.name === name) return value
    if (value !== null && typeof value === 'object') {
      const nested = Object.getOwnPropertyDescriptor(value, name)?.value
      if (typeof nested === 'function' && nested.name === name) return nested
    }
  }
  throw new Error(`the packaged lib module does not export a function named ${name}`)
}

/** The upstream profile template files a fresh desktop profile ships. */
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

/** Probe the npm registry; false means the network-dependent steps must SKIP. */
async function registryReachable() {
  try {
    const response = await fetch(`${REGISTRY_ORIGIN}/${FIXTURE_PACKAGE}/${FIXTURE_VERSION}`, {
      signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

const artifact = resolveArtifact()
console.log(`== DSH Desktop E2E install smoke ==`)
console.log(`artifact: ${artifact.applicationDir}`)
const bundledNodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const bundledNode = join(artifact.resourcesDir, 'node-runtime', bundledNodeName)
const desktopCli = join(artifact.unpackedRoot, 'lib', 'desktop-cli.js')

// ---------------------------------------------------------------------------
// (a) Artifact structure
// ---------------------------------------------------------------------------

{
  const expected = `v${pinnedBundledNodeVersion()}`
  if (!existsSync(bundledNode)) {
    fail('a1', `bundled Node command is missing: ${bundledNode}`)
  } else {
    const probe = runTimed(bundledNode, ['--version'], { timeoutMs: CLI_SMOKE_TIMEOUT_MS, env: childEnvironment() })
    if (probe.status === 0 && probe.stdout.trim() === expected) {
      pass('a1', `bundled Node ${probe.stdout.trim()} at resources/node-runtime/${bundledNodeName}`)
    } else {
      fail('a1', `bundled Node --version returned status ${String(probe.status)} stdout ${JSON.stringify(probe.stdout.trim())}; expected ${expected}`)
    }
  }
}

let policy = undefined
{
  let entries
  try {
    archiveEntries = listPackage(artifact.asarPath, { isPack: false })
    entries = new Set(archiveEntries.map(normalizeArchiveEntry))
  } catch (cause) {
    fail('a2', `cannot list ${artifact.asarPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const required = [
    'lib/policy/desktop-policy.json',
    'lib/company-market/catalog-manifest.json',
    'lib/desktop-cli.js',
    'lib/desktop-runtime-environment.js',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/dsh-community-market/lib/index.js',
  ]
  const missing = entries === undefined ? [] : required.filter(entry => !entries.has(entry))
  if (entries === undefined || missing.length > 0) {
    fail('a2', `app.asar is missing install-chain entries: ${missing.join(', ')}`)
  } else {
    pass('a2', `app.asar carries the ${String(required.length)} install-chain entries (policy, manifest, CLI, pnpm, market lib)`)
  }

  try {
    policy = JSON.parse(extractArchiveFile('lib/policy/desktop-policy.json').toString('utf8'))
    if (policy.locked === true) {
      pass('a3', 'in-ASAR lib/policy/desktop-policy.json is locked=true')
    } else {
      fail('a3', `in-ASAR desktop policy has locked=${JSON.stringify(policy.locked)}; a packaged build must be locked`)
      policy = undefined
    }
  } catch (cause) {
    fail('a3', `cannot read the in-ASAR desktop policy: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  try {
    const manifestText = extractArchiveFile('lib/company-market/catalog-manifest.json').toString('utf8')
    const market = await import(pathToFileURL(join(artifact.unpackedRoot, 'node_modules', 'dsh-community-market', 'lib', 'index.js')).href)
    const verification = market.verifyCompanyManifest(manifestText, { trustRoots: policy.trustRoots })
    if (verification.ok) {
      pass('a4', `packaged market lib verified the in-ASAR company manifest (sequence ${String(verification.manifest.sequence)}, keyId ${verification.keyId})`)
    } else {
      fail('a4', `the in-ASAR company manifest did not verify through the packaged market lib (${verification.code}): ${verification.reason}`)
    }
  } catch (cause) {
    fail('a4', `cannot verify the in-ASAR company manifest: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

// ---------------------------------------------------------------------------
// (b) CLI policy chain under the bundled Node
// ---------------------------------------------------------------------------

/**
 * The launcher-shaped policy hand-off: exactly what the packaged emitter
 * produces for the artifact's own embedded policy. Every CLI child below
 * rides a copy of it (with per-step value overrides), so the smoke can never
 * construct a hand-off shape the packaged parser rejects — the exact
 * regression CI run 33754841079 caught (a hand-written six-entry copy beside
 * the seven-entry parser of P8 B1).
 */
let launcherPolicyHandoff = undefined

{
  // b0 truth pair, no mocks: the packaged emitter's output must decode
  // through the packaged parser and re-emit byte-identically. This pins the
  // two sides the real install path composes (the launcher's
  // desktopPolicyEnvironmentEntries -> the CLI child's
  // desktopPolicyFromEnvironment) using the shipped code on both ends.
  try {
    if (policy === undefined) throw new Error('the in-ASAR desktop policy was not readable (see a3)')
    const packagedPolicyModule = await import(pathToFileURL(packagedDesktopPolicyModulePath()).href)
    const parsePackagedPolicy = exportedFunctionFromNamespace(packagedPolicyModule, 'parseDesktopPolicy')
    const emitPackagedPolicyEnvironment = exportedFunctionFromNamespace(packagedPolicyModule, 'desktopPolicyEnvironmentEntries')
    const decodePackagedPolicyEnvironment = exportedFunctionFromNamespace(packagedPolicyModule, 'desktopPolicyFromEnvironment')
    const emitted = emitPackagedPolicyEnvironment(parsePackagedPolicy(policy))
    // desktopPolicyFromEnvironment consumes (deletes) the entries it decodes.
    const reemitted = emitPackagedPolicyEnvironment(decodePackagedPolicyEnvironment({ ...emitted }))
    if (JSON.stringify(reemitted) !== JSON.stringify(emitted)) {
      throw new Error(`the hand-off does not round-trip: ${JSON.stringify(emitted)} -> ${JSON.stringify(reemitted)}`)
    }
    launcherPolicyHandoff = emitted
    pass('b0', `packaged policy emitter round-trips through the packaged parser (${String(Object.keys(emitted).length)} hand-off entries)`)
  } catch (cause) {
    fail('b0', `the packaged policy environment hand-off is not self-consistent: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Resolve one canonical hand-off name inside the packaged emitter's output. */
function handoffEntry(handoff, canonicalName) {
  const key = Object.keys(handoff).find(name => name.toUpperCase() === canonicalName)
  if (key === undefined) {
    throw new Error(`the packaged policy hand-off no longer carries ${canonicalName}; update this smoke`)
  }
  return key
}

/**
 * Sentinel policy hand-off: the launcher-shaped entries with trust roots
 * deliberately NOT the artifact's real roots, so any verification against
 * them must fail closed. The manifest URL points at the shipped content-mode
 * asset so the locked gate reads a real file and refuses it on trust.
 */
function sentinelPolicyEnvironment() {
  if (launcherPolicyHandoff === undefined) throw new Error('no launcher-shaped policy hand-off (see b0)')
  return {
    ...launcherPolicyHandoff,
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_LOCKED')]: '1',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_CATALOG_ORIGIN')]: '-',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_MANIFEST_URL')]: 'company-market/catalog-manifest.json',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_TRUST_ROOTS')]: `e2e-smoke-key-1:${'a'.repeat(64)}`,
  }
}

/**
 * The launcher-shaped hand-off with the unlocked posture the real install
 * needs (locked/managed/SSO off, no trust roots, content-mode manifest).
 */
function unlockedPolicyEnvironment() {
  if (launcherPolicyHandoff === undefined) throw new Error('no launcher-shaped policy hand-off (see b0)')
  return {
    ...launcherPolicyHandoff,
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_LOCKED')]: '0',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_MANAGED_MODELS')]: '0',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_REQUIRE_SSO')]: '0',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_CATALOG_ORIGIN')]: '-',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_MANIFEST_URL')]: 'company-market/catalog-manifest.json',
    [handoffEntry(launcherPolicyHandoff, 'DSH_DESKTOP_POLICY_TRUST_ROOTS')]: '-',
  }
}

{
  if (launcherPolicyHandoff === undefined) {
    fail('b1', 'no launcher-shaped policy hand-off (see b0)')
  } else {
    const sentinel = sentinelPolicyEnvironment()
    const env = childEnvironment()
    Object.assign(env, sentinel)
    const probe = runTimed(bundledNode, ['--expose-internals', desktopCli, '--version'], {
      timeoutMs: CLI_SMOKE_TIMEOUT_MS,
      env,
      cwd: tmpdir(),
    })
    let dshVersion = undefined
    try {
      dshVersion = JSON.parse(extractArchiveFile('node_modules/@deepseek-ai/dsh/package.json').toString('utf8')).version
    } catch {
      dshVersion = undefined
    }
    if (probe.status === 0 && dshVersion !== undefined && probe.stdout.trim() === dshVersion) {
      pass('b1', `desktop-cli --version answered ${dshVersion} under the bundled Node with the ${String(Object.keys(sentinel).length)}-entry DSH_DESKTOP_POLICY_* sentinel hand-off present`)
    } else {
      fail('b1', `desktop-cli --version with the sentinel policy hand-off returned status ${String(probe.status)} stdout ${JSON.stringify(probe.stdout.trim())} stderr ${JSON.stringify(probe.stderr.trim().slice(0, 400))}`)
    }
  }
}

{
  if (launcherPolicyHandoff === undefined) {
    fail('b2', 'no launcher-shaped policy hand-off (see b0)')
  } else {
    // Locked gate, offline and deterministic: the sentinel trust roots do not
    // match the shipped manifest's signing key, so `plugin add` must be denied
    // before the upstream CLI (or any network) is touched. A hand-off the CLI
    // child cannot parse also exits 1 with a `dsh-desktop:`-prefixed line (the
    // bootstrap's top-level catch), so that startup failure must NOT satisfy
    // this denial assertion — it would mask exactly the hand-off regression
    // this smoke exists to catch.
    const env = childEnvironment()
    Object.assign(env, sentinelPolicyEnvironment(), { DSH_DESKTOP_DEFAULT_PROFILE: 'smoke' })
    const probe = runTimed(bundledNode, ['--expose-internals', desktopCli, 'plugin', 'add', `${FIXTURE_PACKAGE}@${FIXTURE_VERSION}`], {
      timeoutMs: CLI_SMOKE_TIMEOUT_MS,
      env,
      cwd: tmpdir(),
    })
    const denied = probe.status !== 0 && /dsh-desktop:/u.test(probe.stderr)
      && !/failed to start packaged dsh/u.test(probe.stderr)
    if (denied) {
      pass('b2', `locked plugin add of ${FIXTURE_PACKAGE}@${FIXTURE_VERSION} failed closed (exit ${String(probe.status)}): ${probe.stderr.trim().split('\n')[0]?.slice(0, 160)}`)
    } else {
      fail('b2', `locked plugin add with sentinel trust roots must be denied with a nonzero exit and a dsh-desktop reason; got status ${String(probe.status)} stderr ${JSON.stringify(probe.stderr.slice(0, 400))}`)
    }
  }
}

// ---------------------------------------------------------------------------
// (c) Real install through the bundled CLI and packaged pnpm
// ---------------------------------------------------------------------------

const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-e2e-install-smoke-'))
const smokeHome = join(smokeRoot, 'home')
const installProfileName = 'smoke'
const installProfileDir = join(smokeHome, 'profiles', installProfileName)
let realInstallSucceeded = false

try {
  scaffoldProfile(installProfileDir, installProfileName)
  const ensureProfilePnpmBuildApproval = exportedFunctionFromNamespace(
    await import(pathToFileURL(packagedLibChunk('profile-pnpm-policy-')).href),
    'ensureProfilePnpmBuildApproval',
  )
  ensureProfilePnpmBuildApproval(installProfileDir)
  const workspaceAfterMerge = readFileSync(join(installProfileDir, 'pnpm-workspace.yaml'), 'utf8')
  if (workspaceAfterMerge.includes('allowBuilds:') && workspaceAfterMerge.includes('node-pty: true')
    && workspaceAfterMerge.includes('onlyBuiltDependencies:') && workspaceAfterMerge.includes('strictDepBuilds:')) {
    pass('c1', 'ensureProfilePnpmBuildApproval (compiled packaged lib) merged both build-approval spellings plus strictDepBuilds into the fresh profile workspace')
  } else {
    fail('c1', `the compiled ensureProfilePnpmBuildApproval left an unexpected pnpm-workspace.yaml:\n${workspaceAfterMerge}`)
  }

  if (!(await registryReachable())) {
    skip('c2', `registry ${REGISTRY_ORIGIN} unreachable; real pnpm install of ${FIXTURE_PACKAGE}@${FIXTURE_VERSION} skipped`)
  } else {
    // Mirror the desktop launcher: packaged pnpm shims driven by the bundled
    // Node, prepended to PATH (the upstream CLI forwards to a PATH `pnpm`).
    const runtimeEnvironment = await import(pathToFileURL(join(artifact.unpackedRoot, 'lib', 'desktop-runtime-environment.js')).href)
    const electronVersion = readHostElectronVersion()
    const installEnv = childEnvironment()
    Object.assign(installEnv, {
      DSH_HOME: smokeHome,
      DSH_DESKTOP_DEFAULT_PROFILE: installProfileName,
      // The launcher-shaped policy hand-off (unlocked posture) instead of a
      // hand-written key list: the emitted entries always match what the
      // packaged CLI parser consumes, whatever future keys join the hand-off.
      ...unlockedPolicyEnvironment(),
      DSH_DESKTOP_INSTALL_RECOVERY_STATE_PATH: join(smokeHome, 'plugin-install-recovery', 'state.json'),
    })
    runtimeEnvironment.installDesktopPnpmRuntime({
      platform: process.platform,
      nodeExecutable: bundledNode,
      pnpmBinPath: join(artifact.unpackedRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      electronVersion,
      stateDir: join(smokeRoot, 'runtime-commands'),
      environment: installEnv,
    })
    const probe = runTimed(
      bundledNode,
      ['--expose-internals', desktopCli, 'plugin', 'add', '--save-exact', `${FIXTURE_PACKAGE}@${FIXTURE_VERSION}`],
      { timeoutMs: REAL_INSTALL_TIMEOUT_MS, env: installEnv, cwd: smokeHome },
    )
    if (probe.status === 0) {
      realInstallSucceeded = true
      pass('c2', `real install: desktop-cli plugin add --save-exact ${FIXTURE_PACKAGE}@${FIXTURE_VERSION} exited 0 through the packaged pnpm under the bundled Node`)
    } else {
      const output = `${probe.stdout}\n${probe.stderr}`
      const tail = output.trim().split('\n').slice(-6).join(' | ').slice(0, 400)
      if (probe.timedOut || looksLikeNetworkFailure(output)) {
        skip('c2', `install failed with network-like symptoms (status ${String(probe.status)}): ${tail}`)
      } else {
        fail('c2', `install exited ${String(probe.status)}: ${tail}`)
      }
    }
  }

  if (realInstallSucceeded) {
    const manifest = JSON.parse(readFileSync(join(installProfileDir, 'package.json'), 'utf8'))
    const installed = readFileSync(join(installProfileDir, 'node_modules', FIXTURE_PACKAGE, 'package.json'), 'utf8')
    const installedVersion = JSON.parse(installed).version
    if (manifest.dependencies?.[FIXTURE_PACKAGE] === FIXTURE_VERSION && installedVersion === FIXTURE_VERSION) {
      pass('c3', `profile package.json pins ${FIXTURE_PACKAGE}: ${FIXTURE_VERSION} and node_modules/${FIXTURE_PACKAGE}@${installedVersion} is installed`)
    } else {
      fail('c3', `unexpected install result: dependency ${JSON.stringify(manifest.dependencies?.[FIXTURE_PACKAGE])}, installed version ${JSON.stringify(installedVersion)}`)
    }
    const workspaceAfterInstall = readFileSync(join(installProfileDir, 'pnpm-workspace.yaml'), 'utf8')
    if (workspaceAfterInstall.includes('allowBuilds:') && workspaceAfterInstall.includes('node-pty: true')) {
      pass('c4', 'pnpm-workspace.yaml still carries allowBuilds after the real install')
    } else {
      fail('c4', `pnpm rewritten the workspace approvals away:\n${workspaceAfterInstall}`)
    }
  } else {
    skip('c3', 'no real install happened (see c2)')
    skip('c4', 'no real install happened (see c2)')
  }

  // -------------------------------------------------------------------------
  // (d) Boot verification pure functions over a test-keyed signed manifest
  // -------------------------------------------------------------------------

  const bootProfileDir = join(smokeHome, 'profiles', 'bootfx')
  scaffoldProfile(bootProfileDir, 'bootfx')
  const bootPackageDir = join(bootProfileDir, 'node_modules', BOOT_FIXTURE_PACKAGE)
  mkdirSync(bootPackageDir, { recursive: true })
  writeFileSync(join(bootPackageDir, 'package.json'), `${JSON.stringify({
    name: BOOT_FIXTURE_PACKAGE,
    version: BOOT_FIXTURE_VERSION,
  }, undefined, 2)}\n`)
  writeFileSync(join(bootProfileDir, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    `      ${BOOT_FIXTURE_PACKAGE}:`,
    `        specifier: ${BOOT_FIXTURE_VERSION}`,
    `        version: ${BOOT_FIXTURE_VERSION}`,
    'packages:',
    `  ${BOOT_FIXTURE_PACKAGE}@${BOOT_FIXTURE_VERSION}:`,
    '    resolution:',
    `      integrity: ${BOOT_FIXTURE_INTEGRITY}`,
    '',
  ].join('\n'))

  const bootVerification = await import(pathToFileURL(packagedLibChunk('boot-verification-')).href)
  const verifyDesktopBootBundles = exportedFunctionFromNamespace(bootVerification, 'verifyDesktopBootBundles')
  const collectDesktopBootBundles = exportedFunctionFromNamespace(bootVerification, 'collectDesktopBootBundles')
  const market = await import(pathToFileURL(join(artifact.unpackedRoot, 'node_modules', 'dsh-community-market', 'lib', 'index.js')).href)

  // Key generation mirrors tests/boot-verification.spec.ts: an ephemeral
  // ed25519 pair whose fingerprint becomes the only trust root.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = 'e2e-boot-smoke-key'
  const trustRoots = [{ keyId, fingerprint: market.ed25519PublicKeyFingerprint(publicKey) }]
  const unsignedManifest = {
    manifestVersion: '1.0.0',
    sequence: 7,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [{
      packageName: BOOT_FIXTURE_PACKAGE,
      version: BOOT_FIXTURE_VERSION,
      integrity: BOOT_FIXTURE_INTEGRITY,
      bundlePatch: './cordis.patch.yml',
      repository: { url: 'https://github.com/example/dsh-e2e-boot-fixture' },
      revoked: false,
      runtime: { dshRuntimeVersion: '*' },
    }],
  }
  const signature = market.createCompanyManifestSignature(unsignedManifest, privateKey, keyId)
  const signedManifest = market.canonicalJsonText({ ...unsignedManifest, signature })
  const bundles = collectDesktopBootBundles(bootProfileDir, [BOOT_FIXTURE_PACKAGE])
  const verification = verifyDesktopBootBundles(signedManifest, bundles, { trustRoots })
  const allowed = verification.allowed.find(entry => entry.packageName === BOOT_FIXTURE_PACKAGE)
  if (verification.manifestTrusted && allowed !== undefined && verification.rejected.length === 0) {
    pass('d1', `boot verification cleared ${BOOT_FIXTURE_PACKAGE}@${BOOT_FIXTURE_VERSION} (evidence ${allowed.evidence}, sequence ${String(allowed.manifestSequence)})`)
  } else {
    fail('d1', `boot verification did not clear the fixture: ${JSON.stringify(verification)}`)
  }

  // Negative control: the same manifest re-signed by an unknown key must
  // reject every bundle (fail closed on trust, never on a crash).
  const { privateKey: untrustedKey } = generateKeyPairSync('ed25519')
  const forgedSignature = market.createCompanyManifestSignature(unsignedManifest, untrustedKey, 'e2e-untrusted-key')
  const forgedManifest = market.canonicalJsonText({ ...unsignedManifest, signature: forgedSignature })
  const forgedVerification = verifyDesktopBootBundles(forgedManifest, bundles, { trustRoots })
  if (!forgedVerification.manifestTrusted && forgedVerification.rejected.length === 1) {
    pass('d2', `boot verification rejected the fixture under an untrusted manifest key (${forgedVerification.manifestFailure.code})`)
  } else {
    fail('d2', `an untrusted manifest must fail closed; got ${JSON.stringify(forgedVerification)}`)
  }
} catch (cause) {
  // A broken artifact can make even the smoke's own lib imports throw; keep
  // the report clean and the exit code structural instead of crashing.
  fail('cd', `unexpected smoke failure: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
} finally {
  if (process.env.DSH_E2E_KEEP === '1') {
    console.log(`keeping the smoke home for inspection: ${smokeRoot}`)
  } else {
    rmSync(smokeRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('----------------------------------------')
console.log(`PASS ${String(passes.length)} · SKIP ${String(skips.length)} · FAIL ${String(failures.length)}`)
for (const { id, reason } of skips) {
  console.log(`  skip ${id}: ${reason}`)
}
if (failures.length > 0) {
  for (const { id, reason } of failures) {
    console.log(`  fail ${id}: ${reason.split('\n')[0]?.slice(0, 200)}`)
  }
  process.exitCode = 1
}
