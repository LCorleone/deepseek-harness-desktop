import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopPolicyAssetPath,
  desktopPolicyEnvironmentEntries,
  desktopPolicyFromEnvironment,
  DESKTOP_POLICY_ENVIRONMENT,
  parseDesktopPolicy,
  readDesktopPolicy,
} from '../src/desktop-policy.ts'

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-policy-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function companyPolicy(): Record<string, unknown> {
  return {
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: 'https://market.company.example',
    companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    locked: true,
    managedModels: false,
    requireSso: false,
    trustRoots: [
      { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
      { keyId: 'company-2026-b', fingerprint: '0123456789abcdef'.repeat(4) },
    ],
    usageReport: false,
  }
}

describe('desktop policy schema parsing', () => {
  it('accepts a locked network-catalog policy with overlapping trust roots', () => {
    const policy = parseDesktopPolicy(companyPolicy())

    expect(policy).toEqual({
      locked: true,
      managedModels: false,
      requireSso: false,
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
      allowHomePatch: false,
      allowManualPluginAdd: false,
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-b', fingerprint: '0123456789abcdef'.repeat(4) },
      ],
      usageReport: false,
    })
    expect(policy.trustRoots).toHaveLength(2)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.trustRoots)).toBe(true)
  })

  it('normalizes the catalog origin and manifest URL', () => {
    const policy = parseDesktopPolicy({
      ...companyPolicy(),
      companyCatalogOrigin: 'https://Market.Company.Example/',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json?from=policy',
    })

    expect(policy.companyCatalogOrigin).toBe('https://market.company.example')
    expect(policy.companyManifestUrl).toBe(
      'https://market.company.example/catalog-manifest.json?from=policy',
    )
  })

  it('accepts an unlocked catalog-as-content policy', () => {
    const policy = parseDesktopPolicy({
      allowHomePatch: false,
      allowManualPluginAdd: false,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      locked: false,
      managedModels: false,
      requireSso: false,
      trustRoots: [],
      usageReport: false,
    })

    expect(policy.locked).toBe(false)
    expect(policy.managedModels).toBe(false)
    expect(policy.companyCatalogOrigin).toBe(null)
    expect(policy.companyManifestUrl).toBe('company-market/catalog-manifest.json')
    expect(policy.trustRoots).toEqual([])
  })

  it('accepts a locked managed-models policy', () => {
    const policy = parseDesktopPolicy({ ...companyPolicy(), managedModels: true })

    expect(policy.locked).toBe(true)
    expect(policy.managedModels).toBe(true)
  })

  it('accepts a usage-reporting policy', () => {
    const policy = parseDesktopPolicy({ ...companyPolicy(), usageReport: true })

    expect(policy.usageReport).toBe(true)
  })

  it.each([
    'allowHomePatch',
    'allowManualPluginAdd',
    'companyCatalogOrigin',
    'companyManifestUrl',
    'locked',
    'managedModels',
    'requireSso',
    'trustRoots',
    'usageReport',
  ])('rejects a policy missing %s', field => {
    const document = companyPolicy()
    delete document[field]

    expect(() => parseDesktopPolicy(document)).toThrow('unexpected fields')
  })

  it('rejects unexpected fields', () => {
    expect(() => parseDesktopPolicy({ ...companyPolicy(), extra: true }))
      .toThrow('unexpected fields')
  })

  it.each([
    null,
    [],
    'locked',
    42,
  ])('rejects the non-object root %j', value => {
    expect(() => parseDesktopPolicy(value)).toThrow('root must be an object')
  })

  it.each([
    ['locked as text', { locked: 'true' }, 'locked must be a boolean'],
    ['managed models as text', { managedModels: 'true' }, 'managedModels must be a boolean'],
    ['managed models as number', { managedModels: 1 }, 'managedModels must be a boolean'],
    ['require sso as text', { requireSso: 'true' }, 'requireSso must be a boolean'],
    ['require sso as number', { requireSso: 1 }, 'requireSso must be a boolean'],
    ['usage report as text', { usageReport: 'true' }, 'usageReport must be a boolean'],
    ['usage report as number', { usageReport: 1 }, 'usageReport must be a boolean'],
    ['enabled home patching', { allowHomePatch: true }, 'allowHomePatch must be false'],
    ['enabled manual plugin add', { allowManualPluginAdd: true }, 'allowManualPluginAdd must be false'],
    ['http catalog origin', { companyCatalogOrigin: 'http://market.company.example' }, 'companyCatalogOrigin'],
    ['catalog origin with a path', { companyCatalogOrigin: 'https://market.company.example/catalog' }, 'companyCatalogOrigin'],
    ['numeric catalog origin', { companyCatalogOrigin: 1 }, 'companyCatalogOrigin'],
    ['cross-origin manifest', { companyManifestUrl: 'https://evil.example/catalog-manifest.json' }, 'must stay inside companyCatalogOrigin'],
    ['http manifest', { companyManifestUrl: 'http://market.company.example/catalog-manifest.json' }, 'must be an absolute https URL'],
    ['relative manifest in network mode', { companyManifestUrl: 'catalog-manifest.json' }, 'must be an absolute https URL'],
    ['empty manifest', { companyManifestUrl: '' }, 'must be a non-empty path'],
    ['traversal manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: '../outside/catalog-manifest.json',
    }, 'must be a relative bundled asset path'],
    ['absolute manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: '/etc/catalog-manifest.json',
    }, 'must be a relative bundled asset path'],
    ['backslash manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market\\catalog-manifest.json',
    }, 'must be a non-empty path'],
    ['trust roots as an object', { trustRoots: {} }, 'trustRoots must be an array'],
    ['trust root that is not an object', { trustRoots: ['company-2026-a'] }, 'trust roots must be objects'],
    ['trust root with extra fields', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'a'.repeat(64), algorithm: 'ed25519' }],
    }, 'trust roots have unexpected fields'],
    ['trust root with an invalid key id', {
      trustRoots: [{ keyId: 'invalid key!', fingerprint: 'a'.repeat(64) }],
    }, 'trust root keyId is invalid'],
    ['trust root with a short fingerprint', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'a'.repeat(63) }],
    }, 'trust root fingerprint must be 64 lowercase hex characters'],
    ['trust root with an uppercase fingerprint', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'A'.repeat(64) }],
    }, 'trust root fingerprint must be 64 lowercase hex characters'],
    ['duplicate trust root key id', {
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-a', fingerprint: 'b'.repeat(64) },
      ],
    }, 'duplicate trust root keyId'],
    ['duplicate trust root fingerprint', {
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-b', fingerprint: 'a'.repeat(64) },
      ],
    }, 'duplicate trust root fingerprint'],
  ])('rejects %s', (_label, patch, message) => {
    expect(() => parseDesktopPolicy({ ...companyPolicy(), ...patch })).toThrow(message)
  })
})

describe('desktop policy asset location', () => {
  it('resolves the policy asset beside a built module', () => {
    const assetPath = desktopPolicyAssetPath(import.meta.url)

    expect(assetPath).toBe(join(
      dirname(fileURLToPath(import.meta.url)),
      'policy',
      'desktop-policy.json',
    ))
    expect(assetPath.endsWith(join('policy', 'desktop-policy.json'))).toBe(true)
  })

  it('prefers the in-archive asset when the module loads from the unpacked tree', () => {
    const unpackedModuleUrl = pathToFileURL(join(
      '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
      'app.asar.unpacked', 'lib', 'desktop-policy.js',
    )).href
    const archiveModuleUrl = pathToFileURL(join(
      '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
      'app.asar', 'lib', 'desktop-policy.js',
    )).href

    expect(desktopPolicyAssetPath(unpackedModuleUrl)).toBe(join(
      '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
      'app.asar', 'lib', 'policy', 'desktop-policy.json',
    ))
    expect(desktopPolicyAssetPath(archiveModuleUrl)).toBe(join(
      '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
      'app.asar', 'lib', 'policy', 'desktop-policy.json',
    ))
  })

  it('rejects module URLs that are not file URLs', () => {
    expect(() => desktopPolicyAssetPath('lib/index.js')).toThrow()
    expect(() => desktopPolicyAssetPath('')).toThrow()
  })
})

describe('desktop policy asset reading', () => {
  it('reads a locked policy from an injected asset path', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify(companyPolicy())}\n`, 'utf8')

    expect(readDesktopPolicy(assetPath).locked).toBe(true)
  })

  it('reads an unlocked policy from an injected asset path', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify({ ...companyPolicy(), locked: false })}\n`, 'utf8')

    expect(readDesktopPolicy(assetPath).locked).toBe(false)
  })

  it('fails closed on corrupted JSON', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, '{broken', 'utf8')

    expect(() => readDesktopPolicy(assetPath)).toThrow('unreadable desktop policy asset')
  })

  it('fails closed on a missing asset', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')

    expect(existsSync(assetPath)).toBe(false)
    expect(() => readDesktopPolicy(assetPath)).toThrow('unreadable desktop policy asset')
  })

  it('fails closed on a semantically invalid asset', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify({ ...companyPolicy(), locked: 'yes' })}\n`, 'utf8')

    expect(() => readDesktopPolicy(assetPath)).toThrow('invalid desktop policy')
  })

  it('rejects relative injected asset paths', () => {
    expect(() => readDesktopPolicy('policy/desktop-policy.json'))
      .toThrow('must be absolute without NUL')
    expect(() => readDesktopPolicy('policy\0/desktop-policy.json'))
      .toThrow('must be absolute without NUL')
  })
})

describe('shipped desktop policy assets', () => {
  it('ships an unlocked dev policy with placeholder defaults', () => {
    const text = readFileSync(new URL('../src/policy/desktop-policy.dev.json', import.meta.url), 'utf8')
    const policy = parseDesktopPolicy(JSON.parse(text))

    expect(policy.locked).toBe(false)
    expect(policy.managedModels).toBe(false)
    expect(policy.requireSso).toBe(false)
    expect(policy.usageReport).toBe(false)
    expect(policy.companyCatalogOrigin).toBe(null)
    expect(policy.companyManifestUrl).toBe('company-market/catalog-manifest.json')
    expect(policy.allowHomePatch).toBe(false)
    expect(policy.allowManualPluginAdd).toBe(false)
    expect(policy.trustRoots).toEqual([])
  })

  it('ships a locked release policy pinned to the company catalog trust root', () => {
    const text = readFileSync(new URL('../src/policy/desktop-policy.release.json', import.meta.url), 'utf8')
    const policy = parseDesktopPolicy(JSON.parse(text))

    expect(policy.locked).toBe(true)
    // Managed-model posture: the release build registers the company gateway
    // in memory, pins DSV4-DSH as the default, and hides the Models page.
    expect(policy.managedModels).toBe(true)
    // SSO startup gate: the release build authenticates through the company
    // portal (silent fast path, browser gate fallback) before any boot.
    expect(policy.requireSso).toBe(true)
    // Usage reporting: the release build wires the per-call model usage
    // reporter against the company telemetry database; the dev variant
    // stays fully unwired.
    expect(policy.usageReport).toBe(true)
    // Origin mode: the signed catalog manifest is fetched at runtime from the
    // pinned GitLab origin instead of the embedded content-mode asset.
    expect(policy.companyCatalogOrigin).toBe('https://gitlab.s.dai.deloitte.cn')
    expect(policy.companyManifestUrl).toBe(
      'https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json',
    )
    expect(policy.allowHomePatch).toBe(false)
    expect(policy.allowManualPluginAdd).toBe(false)
    expect(policy.trustRoots).toEqual([
      { keyId: 'company-catalog-2026-08', fingerprint: 'c46940234dc854ad3964d561ee4e52adf20dc73cb578e26b98f120aec1049af6' },
    ])
  })
})

describe('desktop policy environment hand-off', () => {
  const packagedModuleUrl = pathToFileURL(join(
    '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
    'app.asar.unpacked', 'lib', 'desktop-cli.js',
  )).href
  const devModuleUrl = pathToFileURL(join('/workspace', 'dsh-plugin-desktop', 'lib', 'desktop-cli.js')).href

  it('round-trips a locked content-mode policy through the six entries', () => {
    const policy = parseDesktopPolicy({
      ...companyPolicy(),
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) }],
    })

    const environment: NodeJS.ProcessEnv = { KEEP: 'value', ...desktopPolicyEnvironmentEntries(policy) }
    const decoded = desktopPolicyFromEnvironment(environment, devModuleUrl)

    expect(decoded).toEqual(policy)
    // The hand-off is consumed: the upstream CLI never inherits the markers.
    expect(environment).toEqual({ KEEP: 'value' })
  })

  it('round-trips an unlocked network-catalog policy with several trust roots', () => {
    const policy = parseDesktopPolicy({
      ...companyPolicy(),
      locked: false,
      managedModels: true,
      requireSso: true,
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-b', fingerprint: '0123456789abcdef'.repeat(4) },
      ],
    })

    expect(desktopPolicyFromEnvironment(
      desktopPolicyEnvironmentEntries(policy),
      devModuleUrl,
    )).toEqual(policy)
  })

  it('pins the main-process-only usage-report flag to false in the hand-off', () => {
    // The reporter runs only inside the Electron main process, which reads
    // the policy asset directly; the CLI hand-off carries no seventh entry,
    // so a usage-reporting release policy reconstructs with the flag inert.
    const policy = parseDesktopPolicy({ ...companyPolicy(), usageReport: true })

    const decoded = desktopPolicyFromEnvironment(
      desktopPolicyEnvironmentEntries(policy),
      devModuleUrl,
    )

    expect(decoded).toEqual({ ...policy, usageReport: false })
    expect(Object.keys(DESKTOP_POLICY_ENVIRONMENT)).toHaveLength(6)
  })

  it('decodes case-insensitive keys and rejects conflicting duplicates', () => {
    const entries = desktopPolicyEnvironmentEntries(parseDesktopPolicy(companyPolicy()))
    const cased: NodeJS.ProcessEnv = {
      dsh_desktop_policy_locked: entries[DESKTOP_POLICY_ENVIRONMENT.locked]!,
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: entries[DESKTOP_POLICY_ENVIRONMENT.managedModels]!,
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: entries[DESKTOP_POLICY_ENVIRONMENT.requireSso]!,
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: entries[DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]!,
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: entries[DESKTOP_POLICY_ENVIRONMENT.manifestUrl]!,
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: entries[DESKTOP_POLICY_ENVIRONMENT.trustRoots]!,
    }

    expect(desktopPolicyFromEnvironment(cased, devModuleUrl)?.locked).toBe(true)
    expect(Object.keys(cased)).toEqual([])

    expect(() => desktopPolicyFromEnvironment({
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      dsh_desktop_policy_locked: '0',
    }, devModuleUrl)).toThrow('conflicting DSH_DESKTOP_POLICY_LOCKED environment values')
  })

  it('fails closed without a hand-off in the packaged layout', () => {
    expect(() => desktopPolicyFromEnvironment({}, packagedModuleUrl))
      .toThrow('did not inject the policy environment hand-off')
    expect(() => desktopPolicyFromEnvironment({ KEEP: 'value' }, packagedModuleUrl))
      .toThrow('refuses to read the user-writable policy asset')
  })

  it('returns undefined without a hand-off in a development layout', () => {
    expect(desktopPolicyFromEnvironment({}, devModuleUrl)).toBeUndefined()
  })

  it.each([
    ['a partial hand-off', { [DESKTOP_POLICY_ENVIRONMENT.locked]: '1' }],
    ['a partial hand-off missing only the sso flag', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: '',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'company-market/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: '',
    }],
    ['a non-boolean locked flag', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: 'yes',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: '',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'company-market/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: '',
    }],
    ['a non-boolean managed-models flag', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: 'managed',
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: '',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'company-market/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: '',
    }],
    ['a non-boolean require-sso flag', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: 'sso',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: '',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'company-market/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: '',
    }],
    ['a tampered trust root', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: '',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'company-market/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: 'company-2026-a:not-a-fingerprint',
    }],
    ['a tampered catalog origin', {
      [DESKTOP_POLICY_ENVIRONMENT.locked]: '1',
      [DESKTOP_POLICY_ENVIRONMENT.managedModels]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.requireSso]: '0',
      [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: 'http://market.company.example',
      [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: 'https://market.company.example/catalog-manifest.json',
      [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: '',
    }],
  ])('fails closed on %s', (_label, environment) => {
    expect(() => desktopPolicyFromEnvironment(
      environment as NodeJS.ProcessEnv,
      devModuleUrl,
    )).toThrow()
  })
})
