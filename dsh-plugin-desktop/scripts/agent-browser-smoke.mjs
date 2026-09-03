#!/usr/bin/env node
/**
 * P8 agent-browser real-composition smoke (design §6 B1 acceptance, committed
 * per the B1 review P2).
 *
 * Boots the REAL Electron this package pins and drives the real composition
 * the unit fakes can only model: `DesktopAgentBrowserWindowHost` opens a
 * sandboxed embedder, the `<webview partition>` guest attaches,
 * `webContents.debugger` carries the CDP session, and
 * `DesktopAgentBrowserSession` navigates/snapshots a local fixture page.
 *
 * Asserted end to end:
 *   1. guest session identity  — `guest.session === session.fromPartition(token)`
 *      and `!== session.defaultSession` (spike finding 2: Electron's Session
 *      exposes no `.partition` string, identity is the assertion);
 *   2. P0 default-session isolation — the userData directory listing is
 *      byte-identical before/after a full open→snapshot→close cycle (the
 *      guest's cookies/cache live in its one-shot partition, which is
 *      in-memory and never touches disk);
 *   3. snapshot masking — password fields seal, the plain value stays, and
 *      hidden CSRF tokens never enter the model context (B1 review P3).
 *
 * Run it headless exactly like the B1 spike did:
 *   xvfb-run -a node_modules/electron/dist/electron --no-sandbox \
 *     scripts/agent-browser-smoke.mjs
 * (`corepack yarn build` first — the script drives lib/, not src/.)
 * tests/agent-browser-composition.spec.ts runs this under DSH_XVFB=1.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { app, session as electronSession } from 'electron'
import { DesktopAgentBrowserSession } from '../lib/agent-browser-session.js'
import { DesktopAgentBrowserWindowHost } from '../lib/agent-browser-window.js'

/** Login-shaped fixture the masking assertions read. */
const FIXTURE_HTML = `<!doctype html>
<html><head><title>Smoke Fixture</title></head><body>
<h1>Company sign-in</h1>
<form method="get" action="./">
  <input type="hidden" name="csrf" value="csrf-secret-token-smoke">
  <input type="text" name="user" value="alice@example.test" autocomplete="username">
  <input type="text" name="user_password" value="should-never-project">
  <input type="password" name="pass" value="hunter2-smoke" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>
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
    // partition (in-memory; step 2 pins the identity).
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
      assert(snapshot.tree.includes('Sign in'), 'the submit button is missing')
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
 * NO top-level await: ESM top-level await deadlocks Electron's `ready`
 * dispatch in the main process (the await blocks the very message pump that
 * fires `ready`), so the entry hands the async body to the loop instead.
 */
main().catch(cause => {
  process.stdout.write(
    `agent-browser smoke: FAILED (unexpected) ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`,
  )
  app.exit(1)
})
