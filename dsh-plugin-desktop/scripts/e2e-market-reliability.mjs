/**
 * Headless E2E reliability batch for the b91 device failure classes.
 *
 * Entirely localhost-only (no corporate network, no Electron UI, no packaged
 * artifact), this batch pins the two regressions today's fixes closed, in the
 * shape the devices actually hit them — real HTTP servers on ephemeral
 * loopback ports, real `fetch` clients, and real child processes — following
 * the `scripts/e2e-install-smoke.mjs` pattern:
 *
 *   E1 — a market response survives a generation abort (the "uninstall
 *        spinner" class). The real market host routes
 *        (`registerMarketRoutes`) run on a real Node http server. A client
 *        POSTs one package-operation execute whose install payload is
 *        deliberately slow; the market generation is disposed mid-operation
 *        (what unloading the plugin does on a real device). The client must
 *        still receive an answer within a hard bound — never a hang:
 *          e1a  work that completes anyway answers 200 (the route answers
 *               committed work whenever the response is writable, even
 *               though the generation aborted), and
 *          e1b  work the generation cancels answers the explicit 502
 *               cancellation error (`operation-failed` / "cancelled").
 *
 *   E3 — the locked plugin-add gate against a local origin (the "stale
 *        floor" class). A real child process runs the real
 *        `authorizeLockedPluginAdd` with a launcher-staged manifest file
 *        (`stagedManifestFile`) and the real `fetch` transport against a
 *        local http origin serving signed manifest bytes:
 *          e3a  the floors come from the REAL caller-side derivation
 *               (`lockedPluginAddSequenceFloors`, desktop-cli.ts) reading a
 *               settings.yaml written in the affected-machine shape —
 *               stable install receipts at 27, the legacy single ratchet
 *               the beta channel raised to 29, beta channel evidence 29.
 *               That document must derive the per-channel floors stable 27 /
 *               beta 29 (the pre-split single floor it yields is 29), under
 *               which staged stable bytes at sequence 27 — the tester steady
 *               state the per-channel split exists to keep installable —
 *               ALLOW without arming the stale retry (zero origin requests).
 *               The floors are derived, never handed to the gate pre-split:
 *               the historical mixed-floor bug lived in exactly this
 *               derivation, which a direct-floor scenario bypasses (it
 *               stays green on the pre-split code), and
 *          e3b  staged bytes at 25 under the stable floor 27 (injected
 *               directly — this scenario pins gate-side retry semantics)
 *               must DENY with the stale-sequence reason after exactly one
 *               network retry (the retry re-reads the live origin and stays
 *               stale), and
 *          e3c  a STALLED origin — a TCP server that accepts the connection
 *               and never answers, force-closed only at 10.5 s, past the
 *               gate's 8 s bound — plus stale staged bytes must DENY within
 *               that bound: the denial is the bound doing its job, and the
 *               elapsed time is asserted against the pinned 8 s contract
 *               (with the bound removed the retry waits for the 10.5 s
 *               force-close and the elapsed assertion goes red). A
 *               connection-refused origin cannot pin this — it fails in
 *               ~80 ms whether or not any bound exists — which is why the
 *               fast-failure case is its own scenario, and
 *          e3d  an unreachable origin (connection refused) plus stale staged
 *               bytes must DENY fast, quoting the retry's own transport
 *               failure in the reason.
 *
 * Children vs sources: every workspace import happens inside spawned child
 * processes (`node --experimental-transform-types` plus the resolver hook in
 * `e2e-market-reliability.resolver.mjs`), so the batch always exercises the
 * checked-out sources — the market package's built `lib/` tree can be stale
 * (it is rebuilt on demand), and pinning yesterday's build would silently
 * test nothing. The parent orchestrator imports no workspace module.
 *
 * The children run CONCURRENTLY (they share nothing but the temp root, and
 * every fixture path is scenario-scoped): e3c must wait out the gate's real
 * 8 s bound by design, and serializing the other sub-second children behind
 * it would double the batch's wall clock for no signal.
 *
 * Seams (the only non-production code, both documented host seams):
 *   - E1's deliberately slow payload rides the `MarketInstallServiceProvider`
 *     seam (the Desktop host injects the install service); the routes, the
 *     abort propagation, and the response discipline under test are real.
 *   - E3's origin is a local http server reached through a fetch boundary
 *     that rewrites the policy's fictional pinned https origin
 *     (`https://market.company.example/...`) to the loopback origin and then
 *     performs a real `fetch`. The pinned-origin https contract itself is
 *     still enforced by `fetchCompanyManifestText` before the boundary runs;
 *     the alternative (a self-signed TLS origin plus
 *     `NODE_TLS_REJECT_UNAUTHORIZED=0`) would have weakened TLS validation
 *     instead of just redirecting the transport. e3a's settings document is
 *     real production input, not a seam: `lockedPluginAddSequenceFloors`
 *     parses it exactly as a device boot would (a JSON body is valid YAML,
 *     the same fixture spelling tests/desktop-cli.spec.ts uses).
 *
 * Exit semantics: 0 when every scenario passed, 1 on any failure (failures
 * name their scenario id). Runtime is ~9 s passing — dominated by e3c's
 * deliberate wait on the real 8 s bound — and a failing run still reports
 * within ~25 s (each child is capped, and the caps — not any hang — are the
 * worst case). Every port is ephemeral and every fixture lives under one
 * fresh temp directory, so consecutive runs are stable. Set
 * `DSH_E2E_KEEP=1` to keep that directory.
 *
 * Usage (repository root):
 *   node dsh-plugin-desktop/scripts/e2e-market-reliability.mjs
 *   yarn e2e:market-reliability
 *
 * CI: the "E2E market reliability batch" step of .github/workflows/ci.yml
 * (the `check` job) runs this script after `yarn check`.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(scriptRoot)
const repoRoot = dirname(packageRoot)
const resolverModule = pathToFileURL(join(scriptRoot, 'e2e-market-reliability.resolver.mjs')).href
const marketRoutesModule = pathToFileURL(join(repoRoot, 'dsh-community-market', 'src', 'host', 'routes.ts')).href
const desktopGateModule = pathToFileURL(join(packageRoot, 'src', 'cli-install-channel.ts')).href
const desktopCliModule = pathToFileURL(join(packageRoot, 'src', 'desktop-cli.ts')).href
const desktopPolicyModule = pathToFileURL(join(packageRoot, 'src', 'desktop-policy.ts')).href

/** Environment key selecting the child role when this script re-executes itself. */
const CHILD_ROLE_ENV = 'DSH_E2E_MARKET_RELIABILITY_ROLE'
/** Child switches: silence the transform-types warning; enable TS transformation (market src uses parameter properties). */
const CHILD_SWITCHES = ['--no-warnings', '--experimental-transform-types']
/** Whole-assertion bound for one E1 client fetch (the "never a hang" guarantee under test). */
const E1_RESPONSE_BOUND_MS = 15_000
/** Deliberate slowness of the e1a payload: comfortably longer than the mid-operation dispose. */
const E1_COMMITTED_PAYLOAD_MS = 300
/** Worst-case E1 child (one sub-second pass, one bounded failure path); the cap, never a hang, is the worst case. */
const E1_CHILD_TIMEOUT_MS = E1_RESPONSE_BOUND_MS + 5_000
/** Worst-case E3 child: e3c legitimately spends the 8 s bound plus child startup, and its red path waits for the stalled origin's 10.5 s force-close. */
const E3_CHILD_TIMEOUT_MS = 15_000
/**
 * The gate's documented stale-retry bound, pinned here on purpose (review
 * P1): e3c asserts the denial lands within THIS number — not within whatever
 * `STALE_STAGED_MANIFEST_RETRY_TIMEOUT_MS` currently says — so stubbing the
 * bound away inside the gate produces a red e3c instead of a silently
 * rescaled assertion. The child still reports the constant it read, and the
 * scenario asserts the two agree.
 */
const E3_EXPECTED_RETRY_BOUND_MS = 8_000
/** Slack over the expected retry bound for the e3c elapsed assertion; small on purpose — the red margin below depends on it. */
const E3_BOUND_SLACK_MS = 1_000
/**
 * When the e3c stalled origin force-closes its sockets: past the expected
 * bound plus slack (the red threshold, 9 s) so a gate that lost its bound —
 * and waits for this close instead — fails the elapsed assertion, while
 * staying under the E3 child cap with startup time to spare.
 */
const E3_STALLED_ORIGIN_CLOSE_MS = 10_500
/** Environment keys stripped from child environments (runner/ambient pollution). */
const STRIPPED_ENVIRONMENT_PATTERN = /^(?:ELECTRON_RUN_AS_NODE|NPM_CONFIG_RUNTIME|NPM_CONFIG_TARGET|NPM_CONFIG_DISTURL|DSH_HOME|DSH_DESKTOP_.*|DSH_COMPANY_.*)$/i

const ROUTE_OPERATION_EXECUTE = '/api/community-market/operations/execute'
const verdicts = []
const failures = []

function pass(id, summary) {
  verdicts.push(`[PASS] ${id} ${summary}`)
}

function fail(id, reason) {
  verdicts.push(`[FAIL] ${id} ${reason}`)
  failures.push({ id, reason })
}

/** Build a sanitized child environment (no ambient DSH/runner overrides). */
function childEnvironment(role) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENVIRONMENT_PATTERN.test(key)) continue
    env[key] = value
  }
  env[CHILD_ROLE_ENV] = role
  return env
}

/**
 * Run one child role to completion and parse its single-line JSON report.
 * Async on purpose (children run concurrently — see the header); a spawn
 * failure or timeout surfaces as `{ ok: false }` — never a hang.
 */
function runChildRole(role, config, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...CHILD_SWITCHES, fileURLToPath(import.meta.url), JSON.stringify(config)],
      { shell: false, env: childEnvironment(role), cwd: packageRoot },
    )
    let stdout = ''
    let stderr = ''
    let killedForTimeout = false
    const timer = setTimeout(() => {
      killedForTimeout = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `the ${role} child could not start: ${error.message}` })
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      if (killedForTimeout || (status === null && signal !== null)) {
        resolve({ ok: false, error: `the ${role} child did not finish within ${String(timeoutMs)} ms (signal ${String(signal)})` })
        return
      }
      const line = stdout.trim().split('\n').filter(entry => entry.length > 0).pop()
      if (line === undefined) {
        resolve({
          ok: false,
          error: `the ${role} child exited ${String(status)} without a report; stderr: ${stderr.trim().slice(0, 400)}`,
        })
        return
      }
      try {
        const report = JSON.parse(line)
        if (report !== null && typeof report === 'object' && typeof report.ok === 'boolean') {
          resolve(report)
          return
        }
      } catch {
        // fall through to the unparsable report below
      }
      resolve({
        ok: false,
        error: `the ${role} child printed an unparsable report (${line.slice(0, 200)}); stderr: ${stderr.trim().slice(0, 400)}`,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Child role E1 — the real market host routes on a real http server
// ---------------------------------------------------------------------------

/** One E1 sub-case: register the routes, POST one execute, dispose mid-operation. */
async function e1Case(name, payload) {
  const { registerMarketRoutes } = await import(marketRoutesModule)
  const handlers = new Map()
  const context = {
    logger: { error: (message) => { process.stderr.write(`[e1 market log] ${String(message).slice(0, 200)}\n`) } },
    webServer: {
      port: 0,
      register(route) {
        handlers.set(route.path, route.handler)
        return () => handlers.delete(route.path)
      },
    },
  }
  const server = (await import('node:http')).createServer((req, res) => {
    const handler = handlers.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'no such market route' }))
      return
    }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    context.webServer.port = port
    const origin = `http://127.0.0.1:${String(port)}`
    let signalStart
    const started = new Promise(resolve => { signalStart = resolve })
    const dispose = registerMarketRoutes(context, {
      get: () => ({ sources: [], installReceipts: [] }),
      update: async () => {},
    }, {
      get: () => ({ executePreview: async (previewId, signal) => payload(signalStart, signal, previewId) }),
    })
    const startedAt = Date.now()
    const responsePromise = fetch(`${origin}${ROUTE_OPERATION_EXECUTE}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ previewId: 'e2e-slow-uninstall' }),
      signal: AbortSignal.timeout(E1_RESPONSE_BOUND_MS),
    })
    // The generation disposal is the device event under test, and it must
    // land mid-operation: after the host accepted the execute and the slow
    // payload began (`started` resolves inside the payload), before it
    // finishes. Disposing here is deterministic on both counts.
    await started
    dispose()
    let fetchReport
    try {
      const response = await responsePromise
      fetchReport = { case: name, status: response.status, body: await response.json() }
    } catch (cause) {
      fetchReport = {
        case: name,
        noResponse: true,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
    const elapsedMs = Date.now() - startedAt
    return { ...fetchReport, elapsedMs }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

/** E1 child body: both sub-cases against fresh servers, report facts only. */
async function childRoleE1() {
  const { register } = await import('node:module')
  register(resolverModule, import.meta.url)
  const committed = await e1Case('e1a', async (signalStart, _signal) => {
    signalStart()
    // Deliberately slow committed work: the generation is disposed while this
    // await is pending, and the operation completes anyway (work the host
    // already accepted). The route must answer it — response still writable.
    await new Promise(resolve => setTimeout(resolve, E1_COMMITTED_PAYLOAD_MS))
    return {
      action: 'uninstall',
      receiptId: 'e2e-reliability-receipt',
      packageName: 'e2e-reliability-plugin',
      restartToken: 'e2e-reliability-restart',
    }
  })
  const cancelled = await e1Case('e1b', (signalStart, signal) => new Promise((_resolve, reject) => {
    signalStart()
    // Work the generation actually cancels: the payload rejects with the
    // generation abort, and the route must answer the explicit cancellation
    // error instead of silence. The timer only guards a missing abort and
    // must never keep the child process alive after the case settled.
    const guard = setTimeout(
      () => reject(new Error('the generation abort never reached the payload')),
      E1_RESPONSE_BOUND_MS,
    )
    signal.addEventListener('abort', () => {
      clearTimeout(guard)
      reject(signal.reason ?? new Error('generation aborted'))
    }, { once: true })
  }))
  return { ok: true, cases: [committed, cancelled] }
}

// ---------------------------------------------------------------------------
// Child role E3 — the real locked plugin-add gate against a local origin
// ---------------------------------------------------------------------------

/** E3 child body for one scenario; reports facts (and the real retry bound) only. */
async function childRoleE3(config) {
  const { register } = await import('node:module')
  register(resolverModule, import.meta.url)
  const { generateKeyPairSync } = await import('node:crypto')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const http = await import('node:http')
  const market = await import('dsh-community-market')
  const { authorizeLockedPluginAdd, STALE_STAGED_MANIFEST_RETRY_TIMEOUT_MS } = await import(desktopGateModule)
  const { parseDesktopPolicy } = await import(desktopPolicyModule)

  // Ephemeral trust root: the market library's own signing helpers produce
  // the manifest bytes a real deployment would publish (same fixture shape
  // as tests/cli-install-channel.spec.ts).
  const keyId = 'e2e-reliability-key'
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const entry = {
    packageName: 'e2e-reliability-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/e2e-reliability-plugin' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
  }
  const signedManifestText = (sequence) => {
    const unsigned = {
      manifestVersion: '1.0.0',
      sequence,
      expiresAt: '2030-01-01T00:00:00Z',
      packages: [entry],
    }
    return market.canonicalJsonText({
      ...unsigned,
      signature: market.createCompanyManifestSignature(unsigned, privateKey, keyId),
    })
  }

  // Origin-mode policy with a fictional pinned https origin; the fetch
  // boundary below redirects the transport to the local http origin after
  // `fetchCompanyManifestText` has enforced the pinned-origin contract.
  const policy = parseDesktopPolicy({
    agentBrowser: { allowOrigins: [], allowPersistLogin: false, enabled: false },
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: 'https://market.company.example',
    companyManifestUrl: 'https://market.company.example/company-market/catalog-manifest.json',
    locked: true,
    managedModels: false,
    pluginResetOnVersionChange: false,
    requireSso: false,
    trustRoots: [{ keyId, fingerprint: market.ed25519PublicKeyFingerprint(publicKey) }],
    usageReport: false,
  })

  const stagedFile = join(config.workDir, `staged-${config.scenario}.json`)
  mkdirSync(config.workDir, { recursive: true })
  writeFileSync(stagedFile, signedManifestText(config.stagedSequence))

  // Scenario e3a derives its floors through the production caller path
  // (`lockedPluginAddSequenceFloors`, desktop-cli.ts) instead of handing the
  // gate pre-split numbers: the historical mixed-floor bug lived in exactly
  // that derivation, which a direct-floor scenario bypasses. The document is
  // the affected-machine shape (the same fixture family as
  // tests/desktop-cli.spec.ts — a JSON body, which the production yaml
  // reader parses natively): stable install receipts at 27, the legacy
  // single ratchet the beta channel raised to 29, and the post-split beta
  // evidence 29. The pre-split single floor it yields is 29; the per-channel
  // floors must come out stable 27 / beta 29.
  let floors = { stable: config.stableFloor, beta: config.betaFloor }
  let derivedFloors = undefined
  if (config.settingsFloors !== undefined) {
    const { lockedPluginAddSequenceFloors } = await import(desktopCliModule)
    const homeDir = join(config.workDir, `home-${config.scenario}`)
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(join(homeDir, 'settings.yaml'), JSON.stringify({
      'dsh-community-market': {
        installReceipts: [{
          receiptId: `e2e-reliability-receipt-${config.scenario}`,
          profileName: 'desktop',
          packageName: 'e2e-reliability-plugin',
          version: '1.0.0',
          integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
          bundlePatch: './cordis.patch.yml',
          sourceRecordId: 'company-catalog',
          providerId: 'com.deepseek.company-catalog',
          itemId: 'npm:e2e-reliability-plugin@1.0.0',
          displayName: 'E2E Reliability Plugin',
          installedAt: '2026-09-11T00:00:00.000Z',
          receiptVersion: 2,
          manifestSequence: config.settingsFloors.receiptSequence,
          keyId,
          treeDigest: { algorithm: 'sha256', files: [], rootDigest: 'ab'.repeat(32) },
          resolved: {
            registryIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
            treeRootDigest: 'ab'.repeat(32),
          },
          decided: { allowedBy: 'signed-company-manifest' },
        }],
        companyManifest: { sequence: config.settingsFloors.legacyRatchet },
        companyManifestChannels: { beta: config.settingsFloors.betaRatchet },
      },
    }, null, 2))
    floors = await lockedPluginAddSequenceFloors(homeDir)
    derivedFloors = { stable: floors.stable, beta: floors.beta }
  }

  let origin = config.origin
  let originHits = 0
  let server = undefined
  let forceCloseStalledSockets = undefined
  if (config.serveSequence !== undefined) {
    const bytes = signedManifestText(config.serveSequence)
    server = http.createServer((req, res) => {
      originHits += 1
      res.setHeader('content-type', 'application/json')
      res.end(bytes)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${String(server.address().port)}`
  } else if (config.stalledOrigin === true) {
    // The b91 stall: an origin that ACCEPTS the connection and never
    // answers. Force-closed only at E3_STALLED_ORIGIN_CLOSE_MS — past the
    // gate's 8 s bound plus assertion slack — so a denial inside the bound
    // can only be the bound itself, while a gate that lost its bound waits
    // for this close and fails the elapsed assertion (the negative check).
    const sockets = new Set()
    server = http.createServer((_req, _res) => {
      originHits += 1
      // Intentionally never answers.
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${String(server.address().port)}`
    forceCloseStalledSockets = setTimeout(() => {
      for (const socket of sockets) socket.destroy()
    }, E3_STALLED_ORIGIN_CLOSE_MS)
  } else if (config.refusedPort !== undefined) {
    // Bind once to reserve a free port, then leave it closed: real fetches
    // to it fail with ECONNREFUSED, the device's dead-origin condition.
    const probe = http.createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    config.refusedPort = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    origin = `http://127.0.0.1:${String(config.refusedPort)}`
  }
  const redirectTransport = async (url, init) => {
    const target = new URL(url)
    return await fetch(`${origin}${target.pathname}${target.search}`, init)
  }

  try {
    const startedAt = Date.now()
    const decision = await authorizeLockedPluginAdd(
      ['e2e-reliability-plugin@1.0.0'],
      policy,
      {
        stagedManifestFile: stagedFile,
        ...(floors.stable === undefined ? {} : { lastSeenSequence: floors.stable }),
        ...(floors.beta === undefined ? {} : { lastSeenBetaSequence: floors.beta }),
        fetch: { request: redirectTransport },
      },
    )
    return {
      ok: true,
      scenario: config.scenario,
      allowed: decision.allowed,
      ...(decision.allowed ? {} : { reason: decision.reason }),
      ...(derivedFloors === undefined ? {} : { derivedFloors }),
      originHits,
      elapsedMs: Date.now() - startedAt,
      retryBoundMs: STALE_STAGED_MANIFEST_RETRY_TIMEOUT_MS,
    }
  } finally {
    if (forceCloseStalledSockets !== undefined) clearTimeout(forceCloseStalledSockets)
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

// ---------------------------------------------------------------------------
// Parent scenarios
// ---------------------------------------------------------------------------

async function scenarioE1() {
  const report = await runChildRole('e1', {}, E1_CHILD_TIMEOUT_MS)
  if (!report.ok) {
    fail('E1', report.error)
    return
  }
  const cases = new Map(report.cases.map(entry => [entry.case, entry]))
  const committed = cases.get('e1a')
  if (
    committed !== undefined && !committed.noResponse && committed.status === 200
    && committed.body?.action === 'uninstall' && typeof committed.body?.restartToken === 'string'
  ) {
    pass('e1a', `committed uninstall answered HTTP 200 in ${String(committed.elapsedMs)} ms although the market generation was disposed mid-operation (never a spinner)`)
  } else {
    fail('e1a', `a committed operation must answer 200 over real HTTP after the generation abort; got ${JSON.stringify(committed).slice(0, 300)}`)
  }
  const cancelled = cases.get('e1b')
  if (
    cancelled !== undefined && !cancelled.noResponse && cancelled.status === 502
    && cancelled.body?.code === 'operation-failed' && /cancelled/u.test(String(cancelled.body?.error))
  ) {
    pass('e1b', `cancelled uninstall answered the explicit 502 cancellation error in ${String(cancelled.elapsedMs)} ms (code operation-failed, "cancelled")`)
  } else {
    fail('e1b', `a cancelled operation must answer the explicit cancellation error over real HTTP; got ${JSON.stringify(cancelled).slice(0, 300)}`)
  }
}

async function scenarioE3(workDir) {
  const scenarios = [
    {
      id: 'e3a',
      summary: 'beta-raised machine settings (receipts 27, legacy ratchet 29, beta evidence 29) derive the per-channel floors stable 27 / beta 29 through the production caller path, and staged stable bytes at 27 are allowed',
      config: {
        scenario: 'a',
        workDir,
        stagedSequence: 27,
        serveSequence: 27,
        settingsFloors: { receiptSequence: 27, legacyRatchet: 29, betaRatchet: 29 },
      },
      assert: (report) => report.derivedFloors?.stable === 27 && report.derivedFloors?.beta === 29
        && report.allowed === true && report.originHits === 0,
      describe: (report) => `the caller derived stable ${String(report.derivedFloors?.stable)} / beta ${String(report.derivedFloors?.beta)} (the pre-split single floor on this document was 29), the gate allowed the add and never armed the stale retry (${String(report.originHits)} origin requests)`,
    },
    {
      id: 'e3b',
      summary: 'stale staged bytes (25 < stable floor 27) denied with the stale reason after exactly one network retry',
      config: { scenario: 'b', workDir, stagedSequence: 25, stableFloor: 27, betaFloor: 29, serveSequence: 25 },
      assert: (report) => report.allowed === false && /stale-sequence/u.test(String(report.reason))
        && /restricted network retry was rejected too/u.test(String(report.reason)) && report.originHits === 1,
      describe: (report) => `denied (${report.reason.slice(0, 140)}…) after exactly ${String(report.originHits)} origin request`,
    },
    {
      id: 'e3c',
      summary: 'stalled origin (accepts, never answers) plus stale staged bytes denied within the gate 8 s retry bound',
      config: { scenario: 'c', workDir, stagedSequence: 25, stableFloor: 27, betaFloor: 29, stalledOrigin: true },
      assert: (report) => report.allowed === false && /stale-sequence/u.test(String(report.reason))
        && /the restricted network retry (?:did not answer within|failed)/u.test(String(report.reason))
        && report.retryBoundMs === E3_EXPECTED_RETRY_BOUND_MS
        && report.elapsedMs <= E3_EXPECTED_RETRY_BOUND_MS + E3_BOUND_SLACK_MS,
      describe: (report) => `denied in ${String(report.elapsedMs)} ms while the origin stayed silent (bound ${String(report.retryBoundMs)} ms, asserted against the pinned ${String(E3_EXPECTED_RETRY_BOUND_MS)} ms contract; without the bound the retry would wait for the ${String(E3_STALLED_ORIGIN_CLOSE_MS)} ms force-close)`,
    },
    {
      id: 'e3d',
      summary: 'unreachable origin (connection refused) plus stale staged bytes denied fast, quoting the retry transport failure',
      config: { scenario: 'd', workDir, stagedSequence: 25, stableFloor: 27, betaFloor: 29, refusedPort: 0 },
      assert: (report) => report.allowed === false && /stale-sequence/u.test(String(report.reason))
        && /restricted network retry failed/u.test(String(report.reason))
        && report.elapsedMs < (report.retryBoundMs ?? Number.POSITIVE_INFINITY),
      describe: (report) => `denied in ${String(report.elapsedMs)} ms (fast network failure, well under the ${String(report.retryBoundMs)} ms bound) with the retry's own failure in the reason`,
    },
  ]
  // The scenarios share nothing but the work directory (distinct staged and
  // home fixture paths), so their children run concurrently: e3c must wait
  // out the gate's real 8 s bound by design, and serializing the other
  // sub-second children behind it would only double the batch's wall clock.
  const settled = await Promise.all(
    scenarios.map(scenario => runChildRole('e3', scenario.config, E3_CHILD_TIMEOUT_MS)
      .then(report => ({ scenario, report }))),
  )
  for (const { scenario, report } of settled) {
    if (!report.ok) {
      fail(scenario.id, `${scenario.summary}: ${report.error}`)
      continue
    }
    if (scenario.assert(report)) {
      pass(scenario.id, `${scenario.summary} — ${scenario.describe(report)}`)
    } else {
      fail(scenario.id, `${scenario.summary}; got ${JSON.stringify(report).slice(0, 400)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function parentMain() {
  console.log('== DSH Desktop E2E market reliability ==')
  console.log(`sources: ${repoRoot}`)
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-market-reliability-'))
  try {
    // E1 and E3 are independent (separate children, ports, and fixture
    // paths), so they run concurrently; the verdicts still print in
    // scenario order below. e3c's real 8 s bound dominates the wall clock.
    await Promise.all([scenarioE1(), scenarioE3(join(root, 'e3'))])
  } finally {
    if (process.env.DSH_E2E_KEEP === '1') {
      console.log(`keeping the batch work directory for inspection: ${root}`)
    } else {
      rmSync(root, { recursive: true, force: true })
    }
  }
  console.log('----------------------------------------')
  for (const line of verdicts) console.log(line)
  console.log(`PASS ${String(verdicts.length - failures.length)} · FAIL ${String(failures.length)}`)
  for (const { id, reason } of failures) {
    console.log(`  fail ${id}: ${reason.split('\n')[0]?.slice(0, 200)}`)
  }
  if (failures.length > 0) process.exitCode = 1
}

async function childMain(role, config) {
  const report = role === 'e1'
    ? await childRoleE1()
    : await childRoleE3(config)
  console.log(JSON.stringify(report))
}

// Child processes re-enter this file with the role environment key set; the
// parent orchestration runs only without it.
if (process.env[CHILD_ROLE_ENV] === 'e1' || process.env[CHILD_ROLE_ENV] === 'e3') {
  const config = JSON.parse(process.argv[2] ?? '{}')
  childMain(process.env[CHILD_ROLE_ENV], config).catch((cause) => {
    console.log(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.stack ?? cause.message : String(cause) }))
    process.exitCode = 1
  })
} else {
  await parentMain()
}
