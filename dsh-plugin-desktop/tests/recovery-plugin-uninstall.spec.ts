import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatRecoveryPluginRemoveFailure,
  RecoveryPluginUninstallError,
  removeRecoveryPlugin,
} from '../src/recovery-plugin-uninstall.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recovery-plugin-uninstall-'))
  roots.push(root)
  const profileDir = join(root, 'home', 'profiles', 'desktop')
  const nodeBinDir = join(root, 'runtime', 'node-bin')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(nodeBinDir, { recursive: true })
  const dshBootstrapPath = join(root, 'desktop-cli.mjs')
  writeFileSync(dshBootstrapPath, source)
  return {
    appExecutable: process.execPath,
    dshBootstrapPath,
    profileName: 'desktop',
    profileDir,
    homeDir: join(root, 'home'),
    nodeBinDir,
    nodeShimPath: join(nodeBinDir, 'node'),
    electronVersion: '43.4.0',
    packageName: 'third-party-plugin',
  }
}

describe('pre-Host recovery plugin uninstall command', () => {
  it('runs the packaged official dsh plugin remove argv for the selected Profile', async () => {
    const options = fixture(`process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), home: process.env.DSH_HOME }))\n`)
    const result = await removeRecoveryPlugin(options)
    expect(JSON.parse(result.stdout)).toEqual({
      argv: [
        'plugin',
        '--profile',
        'desktop',
        '--config.minimumReleaseAge=0',
        'remove',
        'third-party-plugin',
      ],
      home: options.homeDir,
    })
    expect(result).toMatchObject({
      packageName: 'third-party-plugin',
      profileName: 'desktop',
      exitCode: 0,
    })
  })

  it('retains bounded command diagnostics when dsh plugin remove fails', async () => {
    const options = fixture(`process.stderr.write('simulated remove failure\\n'); process.exitCode = 7\n`)
    let failure: unknown
    try { await removeRecoveryPlugin(options) } catch (cause) { failure = cause }
    expect(failure).toBeInstanceOf(RecoveryPluginUninstallError)
    const detail = formatRecoveryPluginRemoveFailure(failure)
    expect(detail).toContain('dsh plugin --profile desktop --config.minimumReleaseAge=0 remove third-party-plugin')
    expect(detail).toContain('Exit status: 7')
    expect(detail).toContain('simulated remove failure')
  })
})
