/**
 * P8 agent-browser real-composition acceptance (B1 review P2): the smoke
 * that ran under the pinned Electron during B1 now lives in the repository.
 *
 * `scripts/agent-browser-smoke.mjs` boots the real Electron (43.4.0,
 * `xvfb-run -a electron --no-sandbox`, exactly the day-1 spike invocation)
 * and asserts the composition the headless fakes can only model — guest
 * session identity (`guest.session === session.fromPartition(token)`), the
 * P0 default-session zero-entry isolation, snapshot secret masking, and
 * (B4) the §5.1 classifier's real-Chromium behavior: an untyped `<button>`
 * reports the IDL default `type=submit`, and a label click forwards to the
 * label's associated control (`for=` or first nested control).
 *
 * The suite runs ONLY under `DSH_XVFB=1` (a desktop/Xvfb is a hard
 * prerequisite for a BrowserWindow); everywhere else it is the visible
 * skipped spec that keeps the acceptance honest. `corepack yarn check` runs
 * build before test, so the lib/ entry points exist when this executes.
 *
 * `--disable-gpu` rides along: software GL rasterization under a bare Xvfb
 * (no DRI) can stall renderer startup in containers, and the composition
 * under test — webview attach, debugger transport, snapshot walk — never
 * touches the GPU path.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const electronBinary = `${packageRoot}node_modules/electron/dist/electron`
const smokeScript = `${packageRoot}scripts/agent-browser-smoke.mjs`

describe.runIf(process.env.DSH_XVFB !== undefined)('agent-browser real composition (DSH_XVFB)', () => {
  it(
    'boots the real Electron smoke: partition identity, default-session zero entries, secret masking, real-IDL submit classification',
    () => {
      expect(existsSync(electronBinary)).toBe(true)
      expect(existsSync(smokeScript)).toBe(true)

      // The B1 spike invocation: xvfb-run when no display is inherited,
      // otherwise the electron binary directly against the existing display.
      const useXvfb = process.env.DSH_XVFB === '1' || process.env.DSH_XVFB === 'xvfb-run'
      const command = useXvfb ? 'xvfb-run' : electronBinary
      const args = useXvfb
        ? ['-a', electronBinary, '--no-sandbox', '--disable-gpu', smokeScript]
        : ['--no-sandbox', '--disable-gpu', smokeScript]

      const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      })

      expect(result.stdout).toContain('agent-browser smoke: OK')
      expect(result.status).toBe(0)
    },
    150_000,
  )
})
