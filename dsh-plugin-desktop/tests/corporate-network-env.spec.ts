import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCorporateNetworkEnvironment,
  CORPORATE_CA_BUNDLE_FILENAME,
  CORPORATE_PROXY_PROBE_URL,
  exportCorporateCaBundle,
  INTRANET_NO_PROXY_ENTRIES,
  parseCorporateProxyDirective,
  resolveCorporateNetworkEnv,
  type CorporateNetworkApp,
} from '../src/corporate-network-env.ts'

const electronSession = vi.hoisted(() => ({ resolveProxy: vi.fn(async () => 'DIRECT') }))

vi.mock('electron', () => ({
  session: { defaultSession: { resolveProxy: electronSession.resolveProxy } },
}))

const temporaryDirectories: string[] = []

afterEach(() => {
  electronSession.resolveProxy.mockReset()
  electronSession.resolveProxy.mockImplementation(async () => 'DIRECT')
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryUserDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-corporate-network-'))
  temporaryDirectories.push(directory)
  return directory
}

function fakeApp(userDataDir: string): CorporateNetworkApp {
  return { getPath: (name: 'userData') => {
    if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`)
    return userDataDir
  } }
}

type FakeChild = EventEmitter & {
  stderr: EventEmitter
  kill: () => void
}

interface FakePowerShellSpawn {
  spawn: typeof import('node:child_process').spawn
  invocations: Array<{ command: string; args: string[] }>
  child: FakeChild
}

/** A PowerShell stand-in that writes `bundle` (when set) to the WriteAllLines target embedded in the script. */
function fakePowerShellSpawn(options: {
  bundle?: string
  exitCode?: number
  holdUntilKilled?: boolean
}): FakePowerShellSpawn {
  const invocations: FakePowerShellSpawn['invocations'] = []
  let child: FakeChild | undefined
  const spawn = vi.fn((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] })
    const instance = new EventEmitter() as unknown as FakeChild
    instance.stderr = new EventEmitter()
    instance.kill = () => { instance.emit('close', null, 'SIGTERM') }
    child = instance
    if (!options.holdUntilKilled) {
      const target = /WriteAllLines\('([^']*)'/.exec(args.at(-1) ?? '')
      if (target !== null && options.bundle !== undefined) writeFileSync(target[1]!, options.bundle)
      queueMicrotask(() => { instance.emit('close', options.exitCode ?? 0, null) })
    }
    return instance as never
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, invocations, get child() { return child! } }
}

const PEM_FIXTURE = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBvzCCAYWgAwIBAgIUX+corporateRootCA0wCgYIKoZIzj0EAwIw',
  '-----END CERTIFICATE-----',
  '',
].join('\n')

describe('corporate proxy directive parsing', () => {
  it('translates the first directive of a multi-segment resolution', () => {
    expect(parseCorporateProxyDirective('PROXY 10.172.64.36:80;PROXY 10.0.0.2:8080;DIRECT'))
      .toBe('http://10.172.64.36:80')
  })

  it('maps every proxy directive kind onto its URL scheme', () => {
    expect(parseCorporateProxyDirective('PROXY proxy.corp.example:8080')).toBe('http://proxy.corp.example:8080')
    expect(parseCorporateProxyDirective('HTTPS proxy.corp.example:8443')).toBe('https://proxy.corp.example:8443')
    expect(parseCorporateProxyDirective('SOCKS5 proxy.corp.example:1080')).toBe('socks5://proxy.corp.example:1080')
    expect(parseCorporateProxyDirective('SOCKS4 proxy.corp.example:1080')).toBe('socks4://proxy.corp.example:1080')
    expect(parseCorporateProxyDirective('SOCKS proxy.corp.example:1080')).toBe('socks5://proxy.corp.example:1080')
  })

  it('yields undefined for DIRECT, empty, and unrecognized resolutions', () => {
    expect(parseCorporateProxyDirective('DIRECT')).toBeUndefined()
    expect(parseCorporateProxyDirective('')).toBeUndefined()
    expect(parseCorporateProxyDirective('PROXY')).toBeUndefined()
    expect(parseCorporateProxyDirective('PROXY host:port extra')).toBeUndefined()
    expect(parseCorporateProxyDirective('WEIRD host:port')).toBeUndefined()
  })
})

describe('corporate network environment construction', () => {
  it('injects proxy variables with the intranet bypass list when a proxy resolved', () => {
    const environment = buildCorporateNetworkEnvironment('http://10.172.64.36:80', undefined)

    expect(Object.keys(environment).sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])
    expect(environment.HTTPS_PROXY).toBe('http://10.172.64.36:80')
    expect(environment.HTTP_PROXY).toBe('http://10.172.64.36:80')
  })

  it('injects only the CA variables for a direct connection with an exported bundle', () => {
    const environment = buildCorporateNetworkEnvironment(undefined, 'C:\\Users\\u\\AppData\\DSH Desktop\\corporate-ca-bundle.pem')

    expect(Object.keys(environment).sort()).toEqual(['CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'])
    for (const value of Object.values(environment)) {
      expect(value).toBe('C:\\Users\\u\\AppData\\DSH Desktop\\corporate-ca-bundle.pem')
    }
  })

  it('injects the union when both gates resolved and nothing otherwise', () => {
    expect(Object.keys(buildCorporateNetworkEnvironment('http://p:1', '/bundle.pem')).sort()).toEqual([
      'CURL_CA_BUNDLE',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'SSL_CERT_FILE',
    ])
    expect(buildCorporateNetworkEnvironment(undefined, undefined)).toEqual({})
  })

  it('lists loopback, the private range, and every known intranet host in NO_PROXY', () => {
    const noProxy = buildCorporateNetworkEnvironment('http://p:1', undefined).NO_PROXY
    const entries = (noProxy ?? '').split(',')

    expect(entries).toContain('localhost')
    expect(entries).toContain('127.0.0.1')
    expect(entries).toContain('10.*')
    expect(entries).toContain('10.0.0.0/8')
    // Known company intranet hosts (the list's maintenance point).
    expect(entries).toContain('gitlab.s.dai.deloitte.cn')
    expect(entries).toContain('sdp.deloitre.com.cn')
    expect(entries).toContain('ai.deloitre.com.cn')
    // Wildcard domains in every spelling NO_PROXY consumers recognize.
    for (const entry of ['*.deloitte.cn', 'deloitte.cn', '.deloitte.cn', '*.deloitte.com.cn', 'deloitte.com.cn', '.deloitte.com.cn']) {
      expect(entries).toContain(entry)
    }
    expect(entries.every(entry => entry !== '')).toBe(true)
    expect(new Set(entries).size).toBe(INTRANET_NO_PROXY_ENTRIES.length)
  })
})

describe('corporate CA bundle export', () => {
  it('writes the merged Windows trust stores as a non-empty PEM bundle', async () => {
    const userDataDir = temporaryUserDataDir()
    const powershell = fakePowerShellSpawn({ bundle: PEM_FIXTURE })

    const bundlePath = await exportCorporateCaBundle({ userDataDir, spawn: powershell.spawn, exists: () => true })

    expect(bundlePath).toBe(join(userDataDir, CORPORATE_CA_BUNDLE_FILENAME))
    expect(statSync(bundlePath!).size).toBeGreaterThan(0)
    expect(readFileSync(bundlePath!, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
    // The export script enumerates all three Windows trust stores, deduplicated.
    const script = powershell.invocations[0]!.args.at(-1)!
    expect(script).toContain('Cert:\\LocalMachine\\Root')
    expect(script).toContain('Cert:\\CurrentUser\\Root')
    expect(script).toContain('Cert:\\LocalMachine\\CA')
    expect(script).toContain('$seen')
    // The bundle path is embedded as a single-quoted PowerShell literal.
    expect(script).toContain(`WriteAllLines('${join(userDataDir, CORPORATE_CA_BUNDLE_FILENAME).replaceAll("'", "''")}'`)
  })

  it('skips injection and reports when PowerShell exits non-zero, ignoring stale bundles', async () => {
    const userDataDir = temporaryUserDataDir()
    // A healthy bundle from a previous launch must not be trusted after this launch's failure.
    const staleBundlePath = join(userDataDir, CORPORATE_CA_BUNDLE_FILENAME)
    writeFileSync(staleBundlePath, PEM_FIXTURE)
    const onError = vi.fn()
    const powershell = fakePowerShellSpawn({ exitCode: 1 })

    const bundlePath = await exportCorporateCaBundle({ userDataDir, spawn: powershell.spawn, exists: () => true, onError })

    expect(bundlePath).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('exited with code 1')
    expect(readFileSync(staleBundlePath, 'utf8')).toBe(PEM_FIXTURE)
  })

  it('skips injection when the export times out', async () => {
    const userDataDir = temporaryUserDataDir()
    const onError = vi.fn()
    const powershell = fakePowerShellSpawn({ holdUntilKilled: true })

    const bundlePath = await exportCorporateCaBundle({ userDataDir, spawn: powershell.spawn, exists: () => true, timeoutMs: 20, onError })

    expect(bundlePath).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('timed out')
  })

  it('skips injection without spawning when no PowerShell executable exists', async () => {
    const onError = vi.fn()
    const powershell = fakePowerShellSpawn({})

    const bundlePath = await exportCorporateCaBundle({ userDataDir: temporaryUserDataDir(), spawn: powershell.spawn, exists: () => false, onError })

    expect(bundlePath).toBeUndefined()
    expect(powershell.spawn).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('no PowerShell executable')
  })

  it('skips injection when the exported bundle is empty', async () => {
    const onError = vi.fn()

    const bundlePath = await exportCorporateCaBundle({
      userDataDir: temporaryUserDataDir(),
      spawn: fakePowerShellSpawn({ bundle: '' }).spawn,
      exists: () => true,
      onError,
    })

    expect(bundlePath).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('produced no certificates')
  })

  it('tolerates a spawn-level failure without hanging', async () => {
    const userDataDir = temporaryUserDataDir()
    const onError = vi.fn()
    const powershell = fakePowerShellSpawn({ holdUntilKilled: true })

    // Force the error path: the executable probe passes, the spawn itself fails.
    const bundlePromise = exportCorporateCaBundle({ userDataDir, spawn: powershell.spawn, exists: () => true, onError })
    powershell.child.emit('error', new Error('spawn ENOENT'))

    await expect(bundlePromise).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('spawn ENOENT')
  })
})

describe('corporate network environment resolution', () => {
  it('returns an empty set and resolves nothing off Windows', async () => {
    const resolveProxy = vi.fn()
    const exportCaBundle = vi.fn()

    for (const platform of ['darwin', 'linux'] as const) {
      expect(await resolveCorporateNetworkEnv(fakeApp(temporaryUserDataDir()), {
        platform,
        resolveProxy,
        exportCaBundle,
      })).toEqual({})
    }
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(exportCaBundle).not.toHaveBeenCalled()
  })

  it('injects the full set on Windows when both gates resolve', async () => {
    const userDataDir = temporaryUserDataDir()
    const resolveProxy = vi.fn(async () => 'PROXY 10.172.64.36:80')
    const exportCaBundle = vi.fn(async () => join(userDataDir, CORPORATE_CA_BUNDLE_FILENAME))

    const environment = await resolveCorporateNetworkEnv(fakeApp(userDataDir), {
      platform: 'win32',
      resolveProxy,
      exportCaBundle,
    })

    expect(resolveProxy).toHaveBeenCalledTimes(1)
    expect(resolveProxy).toHaveBeenCalledWith(CORPORATE_PROXY_PROBE_URL)
    expect(Object.keys(environment).sort()).toEqual([
      'CURL_CA_BUNDLE',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'SSL_CERT_FILE',
    ])
    expect(environment.HTTPS_PROXY).toBe('http://10.172.64.36:80')
    expect(environment.NODE_EXTRA_CA_CERTS).toBe(join(userDataDir, CORPORATE_CA_BUNDLE_FILENAME))
    // The user-data directory and timeout flow into the export.
    expect(exportCaBundle).toHaveBeenCalledWith(expect.objectContaining({ userDataDir }))
  })

  it('injects only the CA variables when the connection is direct', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT')
    const exportCaBundle = vi.fn(async () => '/data/corporate-ca-bundle.pem')

    const environment = await resolveCorporateNetworkEnv(fakeApp(temporaryUserDataDir()), {
      platform: 'win32',
      resolveProxy,
      exportCaBundle,
    })

    expect(Object.keys(environment).sort()).toEqual(['CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'])
    expect(environment.NO_PROXY).toBeUndefined()
  })

  it('degrades to CA-only injection when the proxy resolution throws', async () => {
    const onError = vi.fn()
    const resolveProxy = vi.fn(async () => { throw new Error('session is not ready') })

    const environment = await resolveCorporateNetworkEnv(fakeApp(temporaryUserDataDir()), {
      platform: 'win32',
      resolveProxy,
      exportCaBundle: async () => '/data/corporate-ca-bundle.pem',
      onError,
    })

    expect(Object.keys(environment)).toContain('NODE_EXTRA_CA_CERTS')
    expect(Object.keys(environment)).not.toContain('HTTPS_PROXY')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toContain('proxy resolution failed')
  })

  it('degrades to proxy-only injection when the export throws or finds nothing', async () => {
    const userDataDir = temporaryUserDataDir()

    const rejected = await resolveCorporateNetworkEnv(fakeApp(userDataDir), {
      platform: 'win32',
      resolveProxy: async () => 'PROXY 10.172.64.36:80',
      exportCaBundle: async () => { throw new Error('powershell gone') },
      onError: vi.fn(),
    })
    expect(Object.keys(rejected).sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])

    const skipped = await resolveCorporateNetworkEnv(fakeApp(userDataDir), {
      platform: 'win32',
      resolveProxy: async () => 'PROXY 10.172.64.36:80',
      exportCaBundle: async () => undefined,
    })
    expect(Object.keys(skipped).sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])
  })

  it('uses the Electron default session resolver without an injected seam', async () => {
    electronSession.resolveProxy.mockImplementation(async () => 'PROXY default-session-proxy:3128')

    const environment = await resolveCorporateNetworkEnv(fakeApp(temporaryUserDataDir()), {
      platform: 'win32',
      exportCaBundle: async () => undefined,
    })

    expect(electronSession.resolveProxy).toHaveBeenCalledWith(CORPORATE_PROXY_PROBE_URL)
    expect(environment.HTTPS_PROXY).toBe('http://default-session-proxy:3128')
  })
})
