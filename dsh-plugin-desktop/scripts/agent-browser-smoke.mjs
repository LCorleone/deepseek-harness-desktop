#!/usr/bin/env node
/**
 * P8 agent-browser real-composition smoke (design §6 B1 acceptance, committed
 * per the B1 review P2; extended with the B2 act loop).
 *
 * Boots the REAL Electron this package pins and drives the real composition
 * the unit fakes can only model: `DesktopAgentBrowserWindowHost` opens a
 * sandboxed embedder, the `<webview partition>` guest attaches,
 * `webContents.debugger` carries the CDP session, and
 * `DesktopAgentBrowserSession` navigates/snapshots/acts on a local fixture
 * page — the only place the real CDP behavior of the act commands
 * (describeNode classification, isolated-world focus, Input.insertText,
 * trusted press/release) is exercised end to end.
 *
 * Asserted end to end:
 *   1. guest session identity  — `guest.session === session.fromPartition(token)`
 *      and `!== session.defaultSession` (spike finding 2: Electron's Session
 *      exposes no `.partition` string, identity is the assertion);
 *   2. P0 default-session isolation — the userData directory listing is
 *      byte-identical before/after a full open→act→close cycle (the guest's
 *      cookies/cache live in its one-shot in-memory partition);
 *   3. snapshot masking — password fields seal, the plain value stays, and
 *      hidden CSRF tokens never enter the model context (B1 review P3);
 *   4. the act loop — typing lands in the input (mirrored into an attribute
 *      the snapshot observes), the trusted click fires the page's handler,
 *      and page scroll moves without the wheel fallback erroring;
 *   5. the persist form (B3 §5.2) — enabling persistence mints the UUID once,
 *      the guest rides `persist:dsh-agent-browser-<uuid>`, the partition
 *      directory survives close (the one-shot form leaves none), a fresh
 *      session over the same document reuses the token, and the clear action
 *      removes the directory and rotates the UUID.
 *
 * Run it headless exactly like the B1 spike did:
 *   xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *     --disable-gpu scripts/agent-browser-smoke.mjs
 * (`corepack yarn build` first — the script drives lib/, not src/.)
 * tests/agent-browser-composition.spec.ts runs this under DSH_XVFB=1.
 *
 * No top-level await anywhere: ESM top-level await deadlocks Electron's
 * `ready` dispatch in the main process, so async bodies are handed to the
 * loop instead.
 */

import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { app, session as electronSession } from 'electron'
import { DesktopAgentBrowserSession } from '../lib/agent-browser-session.js'
import { DesktopAgentBrowserWindowHost, clearAgentBrowserPersistedPartition } from '../lib/agent-browser-window.js'
import {
  AgentBrowserLoginFileStore,
  agentBrowserPersistPartition,
} from '../lib/agent-browser-partition.js'

/**
 * Login-plus-act fixture. The `oninput` handler mirrors the typed text into
 * a VALUE ATTRIBUTE — the snapshot walker observes attributes, so the smoke
 * can verify the trusted insert landed without any page-side test harness.
 */
const FIXTURE_HTML = `<!doctype html>
<html><head><title>Smoke Fixture</title></head><body style="margin:0">
<h1>Company sign-in</h1>
<form method="get" action="./">
  <input type="hidden" name="csrf" value="csrf-secret-token-smoke">
  <input type="text" name="user" id="user-input" value="alice@example.test" autocomplete="username"
         oninput="mirror.setAttribute('value', this.value)">
  <input type="text" id="mirror" name="mirror" value="">
  <input type="text" name="user_password" value="should-never-project">
  <input type="password" name="pass" value="hunter2-smoke" autocomplete="current-password">
  <button type="button" id="act-btn" onclick="document.getElementById('act-out').textContent='clicked-ok'">Act target</button>
  <p id="act-out">idle</p>
</form>
<div id="tall" style="height:4000px; background:linear-gradient(#222,#888)">tall content</div>
<p id="footer">footer marker</p>
</body></html>
`

const settle = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** Step harness: every step reports, a failure fails the run. */
const results = []
async function step(name, run) {
  try {
    await run()
    results.push({ name, ok: true })
    process.stdout.write(`agent-browser smoke: ok   ${name}\n`)
  } catch (cause) {
    results.push({ name, ok: false, cause })
    process.stdout.write(`agent-browser smoke: FAIL ${name}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Extract the `#e…` ref of the first tree line matching a marker. */
function refFor(tree, marker) {
  for (const line of tree.split('\n')) {
    if (!line.includes(marker)) continue
    const match = /#(e[0-9a-z]+)/u.exec(line)
    if (match !== null) return match[1]
  }
  throw new Error(`no snapshot ref found for ${marker}`)
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-agent-browser-smoke-'))
  app.setPath('userData', userData)
  // The smoke owns its lifetime: closing the browser window must not trigger
  // Electron's default all-windows-closed quit before the assertions ran.
  app.on('window-all-closed', () => {})
  await app.whenReady()

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(FIXTURE_HTML)
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert(address !== null && typeof address === 'object', 'the fixture server did not bind')
  const fixtureUrl = `http://127.0.0.1:${String(address.port)}/`

  let usedPartitionToken = ''
  let attachedGuest = undefined
  const session_ = new DesktopAgentBrowserSession({
    createWindowHost: options => {
      usedPartitionToken = options.partition
      const inner = new DesktopAgentBrowserWindowHost(options)
      return {
        async open() {
          attachedGuest = await inner.open()
          return attachedGuest
        },
        pushState: state => { inner.pushState(state) },
        close: () => { inner.close() },
        isClosed: () => inner.isClosed(),
      }
    },
    mintPartitionToken: () => `dsh-agent-browser-smoke-${randomUUID()}`,
  })

  let listingBefore = []
  try {
    // Warm cycle: Chromium materializes the DEFAULT session's profile
    // skeleton (Cache/, Code Cache/, Local Storage/, …) lazily when the
    // embedder window — a default-session surface — first loads. A dry
    // open→close cycle against about:blank pays that cost ONCE, so the
    // listing delta around the REAL cycle measures exactly what the GUEST's
    // browsing adds to the default session (the P0 leak surface), not the
    // profile skeleton itself. The guest's own storage lives in its one-shot
    // partition (in-memory; the identity step pins it).
    await session_.open('about:blank', { waitForLoad: true })
    await session_.close()
    await settle(1_500)
    listingBefore = readdirSync(userData).sort()

    await step('opens the window and navigates the fixture (generation 2)', async () => {
      const info = await session_.open(fixtureUrl, { waitForLoad: true })
      assert(info.url === fixtureUrl, `expected the fixture URL, got ${info.url}`)
      // The counter is monotonic across close/reopen (warm cycle = 1).
      assert(info.generation === 2, `expected generation 2, got ${String(info.generation)}`)
    })

    await step('guest session identity is the one-shot token partition', async () => {
      assert(attachedGuest !== undefined, 'the guest webContents never attached')
      const guest = attachedGuest
      const tokenSession = electronSession.fromPartition(usedPartitionToken)
      assert(guest.session === tokenSession, 'guest.session is not session.fromPartition(token)')
      assert(guest.session !== electronSession.defaultSession, 'the guest rode the DEFAULT session')
    })

    await step('snapshot masks secrets and hidden tokens, keeps the plain value', async () => {
      const snapshot = await session_.snapshot(undefined)
      assert(snapshot.generation === 2, `snapshot generation ${String(snapshot.generation)}`)
      assert(snapshot.tree.includes('[password field: value hidden]'), 'the password marker is missing')
      assert(!snapshot.tree.includes('hunter2-smoke'), 'the password value leaked into the tree')
      assert(!snapshot.tree.includes('should-never-project'), 'the secret-shaped name input leaked')
      assert(!snapshot.tree.includes('csrf-secret-token-smoke'), 'the hidden CSRF token leaked')
      assert(snapshot.tree.includes('alice@example.test'), 'the plain input value is missing')
    })

    await step('types into the plain input through trusted input', async () => {
      const snapshot = await session_.snapshot(undefined)
      const ref = refFor(snapshot.tree, 'id="user-input"')
      const outcome = await session_.type({ ref, text: 'smoke@example.test', clear: true, generation: snapshot.generation })
      assert(outcome.performed === true, 'browser_type did not report performed')
      // The page mirrors the live value into an attribute the walker sees.
      const after = await session_.snapshot(undefined)
      assert(after.tree.includes('smoke@example.test'), 'the typed text is not observable in the snapshot')
    })

    await step('refuses to type into the password field with the claimControl pointer', async () => {
      const snapshot = await session_.snapshot(undefined)
      const ref = refFor(snapshot.tree, 'name="pass"')
      try {
        await session_.type({ ref, text: 'never-typed' })
        throw new Error('typing into a password field unexpectedly succeeded')
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        assert(message.includes('DENIED_BY_POLICY'), `expected the policy refusal, got: ${message}`)
        assert(message.includes('claimControl'), 'the refusal does not point at claimControl')
      }
    })

    await step('clicks the button with trusted press/release and observes the effect', async () => {
      const snapshot = await session_.snapshot(undefined)
      const ref = refFor(snapshot.tree, 'id="act-btn"')
      const outcome = await session_.click({ ref, generation: snapshot.generation })
      assert(outcome.performed === true, 'browser_click did not report performed')
      await settle(300)
      const after = await session_.snapshot(undefined)
      assert(after.tree.includes('clicked-ok'), "the page's click handler did not run")
    })

    await step('scrolls the page down through the isolated world', async () => {
      const outcome = await session_.scroll({ direction: 'down', amount: 800 })
      assert(outcome.performed === true, 'browser_scroll did not report performed')
      // The footer marker must still be observable after the scroll, and a
      // ref-based click forces scrollIntoView when the target left the view.
      const snapshot = await session_.snapshot(undefined)
      const ref = refFor(snapshot.tree, 'id="act-btn"')
      const clicked = await session_.click({ ref, generation: snapshot.generation })
      assert(clicked.performed === true, 'the post-scroll click failed')
    })

    await step('default session storage gains zero entries across the cycle', async () => {
      await session_.close()
      await settle(1_500)
      const listingAfter = readdirSync(userData).sort()
      assert(
        listingAfter.length === listingBefore.length
          && listingAfter.every((entry, index) => entry === listingBefore[index]),
        `default session dir changed: before [${listingBefore.join(', ')}] after [${listingAfter.join(', ')}]`,
      )
    })

    // ── B3 §5.2: the persist form, contrasted against the one-shot cycle ──

    await step('the one-shot cycle leaves no agent-browser partition directory', () => {
      const partitions = join(userData, 'Partitions')
      const leftovers = existsSync(partitions)
        ? readdirSync(partitions).filter(entry => entry.startsWith('dsh-agent-browser'))
        : []
      assert(leftovers.length === 0, `one-shot cycle left partition dirs: ${leftovers.join(', ')}`)
    })

    const loginPath = join(userData, 'agent-browser', 'login-state.json')
    const loginStore = new AgentBrowserLoginFileStore(loginPath)
    let mountedPartition = ''
    const loginHarness = () => new DesktopAgentBrowserSession({
      createWindowHost: options => {
        mountedPartition = options.partition
        return new DesktopAgentBrowserWindowHost(options)
      },
      mintPartitionToken: () => `dsh-agent-browser-${randomUUID()}`,
      login: {
        store: loginStore,
        mintUuid: () => randomUUID(),
        wipePersistedPartition: async partition => {
          await clearAgentBrowserPersistedPartition(electronSession, userData, partition)
        },
      },
    })
    let persistedUuid = ''

    await step('enabling persistence mints the UUID once into the login document', async () => {
      const view = await loginHarness().setPersistLogin(true)
      assert(view.persistLogin === true && view.persisted === true, 'persist view after enable')
      const document = loginStore.read()
      persistedUuid = document.persistUuid ?? ''
      assert(persistedUuid.length > 0, 'the login document carries no persist UUID')
      const again = await loginHarness().setPersistLogin(false)
      await loginHarness().setPersistLogin(true)
      assert(again !== undefined, 'toggle round-trip')
      assert(loginStore.read().persistUuid === persistedUuid, 'the UUID re-minted across toggles')
    })

    let persistSession = loginHarness()
    await step('the persist partition mounts and its directory survives close', async () => {
      const info = await persistSession.open(fixtureUrl, { waitForLoad: true })
      assert(info.generation >= 1, 'persist open did not navigate')
      const partition = agentBrowserPersistPartition(persistedUuid)
      assert(mountedPartition === partition, `the guest mounted ${mountedPartition}, expected ${partition}`)
      // Deterministically materialize storage inside the partition.
      await electronSession.fromPartition(partition).cookies.set({ url: fixtureUrl, name: 'dsh-smoke', value: '1' })
      const dir = join(userData, 'Partitions', partition.slice('persist:'.length))
      await persistSession.close()
      await settle(1_500)
      assert(existsSync(dir), `the persist partition directory is missing: ${dir}`)
    })

    await step('a fresh session over the same document reuses the persist partition', async () => {
      persistSession = loginHarness()
      const view0 = persistSession.describeLogin()
      assert(view0.persistLogin === true, 'the login document lost the preference across restart')
      await persistSession.open(fixtureUrl, { waitForLoad: true })
      assert(persistSession.describeLogin().windowOnPersistPartition === true, 'the restarted session did not mount the persist partition')
    })

    await step('clearing login state removes the partition directory and rotates the UUID', async () => {
      const partition = agentBrowserPersistPartition(persistedUuid)
      const dir = join(userData, 'Partitions', partition.slice('persist:'.length))
      assert(existsSync(dir), 'the partition directory vanished before the clear')
      const view = await persistSession.clearLoginState()
      assert(view.persisted === true, 'the clear view lost the partition identity')
      assert(!existsSync(dir), 'the clear action left the partition directory behind')
      const document = loginStore.read()
      assert((document.persistUuid ?? '') !== persistedUuid, 'the clear action did not rotate the UUID')
      assert(document.persistLogin === true, 'clearing uninstallated the preference')
    })

    await step('closes cleanly', () => {
      assert(session_.describe().open === false, 'describe() still reports the surface open')
    })
  } finally {
    server.close()
    rmSync(userData, { recursive: true, force: true })
    const failed = results.filter(result => !result.ok)
    process.stdout.write(
      `agent-browser smoke: ${failed.length === 0 ? 'OK' : 'FAILED'} (${String(results.length - failed.length)}/${String(results.length)} steps)\n`,
    )
    app.exit(failed.length === 0 ? 0 : 1)
  }
}

/**
 * NO top-level await (see the header): hand the async body to the loop.
 */
main().catch(cause => {
  process.stdout.write(
    `agent-browser smoke: FAILED (unexpected) ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`,
  )
  app.exit(1)
})
