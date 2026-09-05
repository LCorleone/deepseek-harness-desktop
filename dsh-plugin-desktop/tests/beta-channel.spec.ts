/**
 * Beta catalog channel (P9): the desktop host side.
 *
 * `beta-channel.ts` owns the host's half of the beta decision — derive the
 * beta manifest URL from the policy's stable URL, project the SSO session
 * into roster-match candidates (lowercase, both domain spellings of the
 * corporate alias), fetch and verify `catalog-manifest.beta.json` under the
 * deployment trust roots with the beta channel's one recognized extension
 * (the signed `testers` roster), and admit the overlay only when the local
 * identity matches the roster. The four P9 acceptance scenarios are pinned
 * across this spec and the market-side `company-beta-channel.spec.ts`:
 *
 * 1. a non-roster machine ignores beta entries entirely (its overlay
 *    resolves to `undefined`, so every consumer — the market scan, boot
 *    verification, the tarball channel — keeps the stable-only behavior);
 * 2. a roster machine's overlay carries the beta entries (both SSO domain
 *    spellings and case variants match);
 * 3. a promoted entry (beta and stable carrying identical signed fields)
 *    merges to no difference — the same digest everywhere;
 * 4. a missing beta file, a tampered signature, or a malformed roster
 *    field resolves to `undefined`: stable behavior, exactly today's.
 *
 * The verifier-level tests additionally pin the schema red line: the stable
 * channel keeps the exact previous key set (a `testers` key rejects the
 * whole manifest), the beta channel normalizes uppercase roster entries
 * instead of rejecting them, and malformed roster shapes reject.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import type { DesktopBetaChannelOverlay } from '../src/beta-channel.js'
import {
  COMPANY_BETA_MANIFEST_FILENAME,
  desktopBetaManifestUrl,
  desktopBetaTesterEmailCandidates,
  desktopBetaTesterMatch,
  resolveDesktopBetaChannelOverlay,
  type DesktopBetaChannelOptions,
} from '../src/beta-channel.js'
import {
  findDesktopCompanyManifestPackageWithBeta,
  verifyDesktopCompanyManifest,
  type DesktopCompanyManifest,
} from '../src/desktop-market.js'
import { verifyDesktopBootBundles } from '../src/boot-verification.js'
import { createDesktopCompanyMarketTarballInstallChannel } from '../src/company-market-install.ts'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.js'
import type { UpdateChannelRequest } from '../src/update-manifest.js'
import type { SsoSession } from '../src/company-sso.js'
import type { DesktopCompanyManifestPackage } from '../src/desktop-market.js'

const keyId = 'company-catalog-beta-spec'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const origin = 'https://gitlab.company.example'
const manifestUrl = `${origin}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`
const betaUrl = `${origin}/julu/dsh-desktop-config/-/raw/master/${COMPANY_BETA_MANIFEST_FILENAME}`
const now = () => Date.parse('2026-09-05T00:00:00.000Z')

const policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl' | 'trustRoots'> = {
  companyCatalogOrigin: origin,
  companyManifestUrl: manifestUrl,
  trustRoots,
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'company-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/company-plugin' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [entry()],
    ...overrides,
  }
}

function signedText(manifest: Record<string, unknown> = unsignedManifest(), key: KeyObject = privateKey): string {
  const signature = createCompanyManifestSignature(
    manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    key,
    keyId,
  )
  return canonicalJsonText({ ...manifest, signature })
}

const betaManifestText = (overrides: Record<string, unknown> = {}, key: KeyObject = privateKey) =>
  signedText(unsignedManifest({
    sequence: 43,
    packages: [entry(), entry({ packageName: 'company-beta-plugin', version: '0.9.0' })],
    testers: ['julu@deloittecn.com.cn', 'sebtang@deloittecn.com.cn'],
    ...overrides,
  }), key)

const sessionOf = (email: string) => ({
  email,
  username: 'julu',
  fullName: 'Ju Lu',
  domain: 'deloittecn.com.cn',
  token: 'token-material-never-logged',
  source: 'browser' as const,
})

/** A request boundary serving one fixed body for the beta URL only. */
const serving = (body: string, status = 200): UpdateChannelRequest => {
  const bytes = new TextEncoder().encode(body)
  return async () => new Response(new Uint8Array(bytes), { status, headers: { 'content-type': 'application/json' } })
}

const failing: UpdateChannelRequest = async () => new Response('not found', { status: 404 })

function resolve(
  overrides: Partial<Omit<DesktopBetaChannelOptions, 'session' | 'log'>> & { session?: SsoSession | undefined; log?: (message: string) => void },
): Promise<DesktopBetaChannelOverlay | undefined> {
  const { session, log = vi.fn(), ...rest } = overrides
  return resolveDesktopBetaChannelOverlay({
    policy,
    request: failing,
    ...(session === undefined ? {} : { session }),
    now,
    ...rest,
    log,
  })
}

describe('desktopBetaManifestUrl (P9)', () => {
  it('derives the sibling beta URL from the policy manifest URL', () => {
    expect(desktopBetaManifestUrl(manifestUrl)).toBe(betaUrl)
    expect(desktopBetaManifestUrl(`${origin}/deep/nested/path/catalog-manifest.json`))
      .toBe(`${origin}/deep/nested/path/${COMPANY_BETA_MANIFEST_FILENAME}`)
  })

  it('rejects non-https and unparseable stable URLs', () => {
    expect(() => desktopBetaManifestUrl('http://insecure.example/catalog-manifest.json')).toThrow(/https/)
    expect(() => desktopBetaManifestUrl('not a url')).toThrow(/valid URL/)
  })
})

describe('beta tester roster matching (P9)', () => {
  it('projects the session into lowercase candidates covering both corporate alias spellings', () => {
    expect(desktopBetaTesterEmailCandidates(sessionOf('Julu@DeloitteCN.com.cn')))
      .toEqual(['julu@deloittecn.com.cn', 'julu@deloitte.com.cn'])
    expect(desktopBetaTesterEmailCandidates(sessionOf('julu@deloitte.com.cn')))
      .toEqual(['julu@deloitte.com.cn'])
    expect(desktopBetaTesterEmailCandidates(undefined)).toEqual([])
  })

  it('matches exactly under symmetric normalization — both domain spellings, case-insensitive, no substrings', () => {
    const roster = ['julu@deloittecn.com.cn', 'sebtang@deloittecn.com.cn']
    expect(desktopBetaTesterMatch(roster, ['julu@deloitte.com.cn'])).toBe(true)
    expect(desktopBetaTesterMatch(roster, ['julu@deloittecn.com.cn'])).toBe(true)
    expect(desktopBetaTesterMatch(['JULU@deloittecn.com.cn'], ['julu@deloitte.com.cn'])).toBe(true)
    expect(desktopBetaTesterMatch(roster, ['lizywu@deloitte.com.cn'])).toBe(false)
    expect(desktopBetaTesterMatch(['julu@deloittecn.com.cn'], ['ulu@deloittecn.com.cn'])).toBe(false)
    expect(desktopBetaTesterMatch(roster, [])).toBe(false)
  })
})

describe('resolveDesktopBetaChannelOverlay (P9)', () => {
  it('scenario 2 (roster machine): admits the beta entries and logs one applied line without roster contents', async () => {
    const log = vi.fn()
    const overlay = await resolve({
      session: sessionOf('julu@deloitte.com.cn'),
      request: serving(betaManifestText()),
      log,
    })
    expect(overlay).toBeDefined()
    expect(overlay?.sequence).toBe(43)
    expect(overlay?.packages.map(pkg => pkg.packageName)).toEqual(['company-plugin', 'company-beta-plugin'])
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0])
    expect(line).toContain('beta catalog applied')
    expect(line).toContain('sequence 43')
    expect(line).not.toContain('julu@')
  })

  it('scenario 1 (non-roster machine): the overlay resolves to undefined even though the manifest is perfectly valid', async () => {
    const log = vi.fn()
    const overlay = await resolve({
      session: sessionOf('someone.else@deloitte.com.cn'),
      request: serving(betaManifestText()),
      log,
    })
    expect(overlay).toBeUndefined()
    expect(String(log.mock.calls[0])).toContain('not-a-tester')
  })

  it('an unresolved SSO identity is not a tester (fail-closed)', async () => {
    const log = vi.fn()
    const overlay = await resolve({ session: undefined, request: serving(betaManifestText()), log })
    expect(overlay).toBeUndefined()
    expect(String(log.mock.calls[0])).toContain('no-sso-identity')
  })

  it('scenario 4: a missing beta file (404) silently keeps the stable channel', async () => {
    const log = vi.fn()
    const overlay = await resolve({ session: sessionOf('julu@deloitte.com.cn'), request: failing, log })
    expect(overlay).toBeUndefined()
    expect(String(log.mock.calls[0])).toContain('fetch-failed')
  })

  it('scenario 4: tampered beta bytes fail verification and keep the stable channel', async () => {
    const text = betaManifestText()
    const tampered = `${text.slice(0, -8)}AAAAAAAA` // break the trailing signature bytes
    const overlay = await resolve({
      session: sessionOf('julu@deloitte.com.cn'),
      request: serving(tampered),
    })
    expect(overlay).toBeUndefined()
  })

  it('scenario 4: a manifest signed by a stranger key is not admitted', async () => {
    const { privateKey: stranger } = generateKeyPairSync('ed25519')
    const overlay = await resolve({
      session: sessionOf('julu@deloitte.com.cn'),
      request: serving(betaManifestText(undefined, stranger)),
    })
    expect(overlay).toBeUndefined()
  })

  it('scenario 4: a malformed testers field rejects the whole beta manifest (fail-closed to stable)', async () => {
    for (const testers of ['not-an-array', ['not-an-email'], ['a@b.co', 'A@B.CO']]) {
      const overlay = await resolve({
        session: sessionOf('julu@deloitte.com.cn'),
        request: serving(betaManifestText({ testers: testers as unknown as string[] })),
      })
      expect(overlay).toBeUndefined()
    }
  })

  it('a duplicate roster entry never leaks the address into the log (masked to ***@domain)', async () => {
    const log = vi.fn()
    // The duplicate-roster rejection embeds the address in its reason; the
    // log contract is that roster contents never appear there.
    const overlay = await resolve({
      session: sessionOf('julu@deloitte.com.cn'),
      request: serving(betaManifestText({ testers: ['julu@deloitte.com.cn', 'JULU@deloitte.com.cn'] })),
      log,
    })
    expect(overlay).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0])
    expect(line).toContain('unverified')
    expect(line).not.toContain('julu@deloitte.com.cn')
    expect(line).toContain('***@deloitte.com.cn')
  })

  it('a same-session replay of a lower beta sequence is rejected (in-session replay floor)', async () => {
    const session = sessionOf('julu@deloitte.com.cn')
    // High sequences so the module-level floor set by earlier tests in this
    // file cannot interfere; this test must stay the last resolver test.
    const first = await resolve({ session, request: serving(betaManifestText({ sequence: 305 })) })
    expect(first?.sequence).toBe(305)
    const replay = await resolve({ session, request: serving(betaManifestText({ sequence: 304 })) })
    expect(replay).toBeUndefined()
    // The equal sequence is the steady state (every scan re-fetches the same
    // publication) and stays admitted even after a higher one was seen.
    const again = await resolve({ session, request: serving(betaManifestText({ sequence: 305 })) })
    expect(again?.sequence).toBe(305)
  })
})

describe('verifyDesktopCompanyManifest beta channel schema (P9)', () => {
  const verify = (text: string, channel?: 'stable' | 'beta') =>
    verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: origin, now, ...(channel === undefined ? {} : { channel }) })

  it('the stable channel keeps the exact previous key set: a testers key rejects the whole manifest', () => {
    const stable = verify(betaManifestText())
    expect(stable).toMatchObject({ ok: false, code: 'invalid-manifest' })
    if (stable.ok) return
    expect(stable.reason).toContain('testers')
  })

  it('the beta channel admits the testers roster and normalizes uppercase entries to lowercase', () => {
    const beta = verify(signedText(unsignedManifest({ sequence: 44, testers: ['JULU@deloittecn.com.cn'] })), 'beta')
    expect(beta.ok).toBe(true)
    if (!beta.ok) return
    expect(beta.manifest.testers).toEqual(['julu@deloittecn.com.cn'])
  })

  it('the beta channel rejects malformed roster shapes', () => {
    expect(verify(signedText(unsignedManifest({ testers: 'nope' })), 'beta')).toMatchObject({ ok: false, code: 'invalid-manifest' })
    expect(verify(signedText(unsignedManifest({ testers: ['a@b'] })), 'beta')).toMatchObject({ ok: false, code: 'invalid-manifest' })
    expect(verify(signedText(unsignedManifest({ testers: ['a@b.co', 'a@b.co'] })), 'beta')).toMatchObject({ ok: false, code: 'invalid-manifest' })
  })

  it('a testers-free beta manifest verifies on both channels with identical outcomes', () => {
    const plain = signedText()
    expect(verify(plain, 'beta')).toMatchObject({ ok: true })
    expect(verify(plain)).toMatchObject({ ok: true })
  })
})

describe('findDesktopCompanyManifestPackageWithBeta (P9)', () => {
  it('prefers the beta entry for the same name@version and falls back to stable', () => {
    const stable = verifyDesktopCompanyManifest(signedText(), { trustRoots, companyCatalogOrigin: origin, now })
    expect(stable.ok).toBe(true)
    if (!stable.ok) return
    const betaEntry = entry({
      packageName: 'company-plugin',
      version: '1.0.0',
      integrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
    })
    const beta = verifyDesktopCompanyManifest(
      signedText(unsignedManifest({ sequence: 45, packages: [betaEntry] })),
      { trustRoots, companyCatalogOrigin: origin, now, channel: 'beta' },
    )
    expect(beta.ok).toBe(true)
    if (!beta.ok) return

    const found = findDesktopCompanyManifestPackageWithBeta(stable.manifest, beta.manifest.packages, 'company-plugin', '1.0.0')
    expect(found?.integrity).toBe(betaEntry.integrity)
    expect(findDesktopCompanyManifestPackageWithBeta(stable.manifest, beta.manifest.packages, 'company-plugin', '2.0.0'))
      .toBeUndefined()
    expect(findDesktopCompanyManifestPackageWithBeta(stable.manifest, undefined, 'company-plugin', '1.0.0'))
      .toMatchObject({ integrity: (stable.manifest as DesktopCompanyManifest).packages[0]?.integrity })
  })

  it('never resurrects a stable-revoked name@version (revocation is sticky across channels)', () => {
    // Stable pins the entry revoked:true; a stale beta overlay still says
    // revoked:false — the beta fields may win, but not the flag.
    const stable = verifyDesktopCompanyManifest(
      signedText(unsignedManifest({ packages: [entry({ revoked: true })] })),
      { trustRoots, companyCatalogOrigin: origin, now },
    )
    expect(stable.ok).toBe(true)
    if (!stable.ok) return
    const beta = verifyDesktopCompanyManifest(
      signedText(unsignedManifest({
        sequence: 46,
        packages: [entry({ revoked: false, integrity: `sha512-${Buffer.alloc(64, 11).toString('base64')}` })],
      })),
      { trustRoots, companyCatalogOrigin: origin, now, channel: 'beta' },
    )
    expect(beta.ok).toBe(true)
    if (!beta.ok) return

    const found = findDesktopCompanyManifestPackageWithBeta(stable.manifest, beta.manifest.packages, 'company-plugin', '1.0.0')
    expect(found?.revoked).toBe(true)
    expect(found?.integrity).toBe(`sha512-${Buffer.alloc(64, 11).toString('base64')}`)
  })
})

describe('market tarball install channel beta overlay (P9)', () => {
  const fullPolicy: DesktopPolicy = parseDesktopPolicy({
    locked: true,
    managedModels: false,
    requireSso: false,
    companyCatalogOrigin: origin,
    companyManifestUrl: manifestUrl,
    allowHomePatch: false,
    allowManualPluginAdd: false,
    trustRoots,
    usageReport: false,
    agentBrowser: { enabled: false, allowOrigins: [], allowPersistLogin: false },
  })
  const stableText = signedText(unsignedManifest({
    packages: [entry({ source: { kind: 'tarball', url: `${origin}/packages/company-plugin-1.0.0.tgz`, integrity: entry().integrity } })],
  }))
  const betaOverlay = async (sequence: number) => {
    const beta = verifyDesktopCompanyManifest(
      signedText(unsignedManifest({
        sequence,
        packages: [entry(), entry({
          packageName: 'company-beta-plugin',
          version: '0.9.0',
          source: { kind: 'tarball', url: `${origin}/packages/company-beta-plugin-0.9.0.tgz`, integrity: entry().integrity },
        })],
        testers: ['julu@deloittecn.com.cn'],
      })),
      { trustRoots, companyCatalogOrigin: origin, now, channel: 'beta' },
    )
    if (!beta.ok) throw new Error('unreachable')
    return { packages: beta.manifest.packages, sequence: beta.manifest.sequence }
  }

  it('a roster machine verifies a beta tarball entry the stable manifest does not pin', async () => {
    const channel = createDesktopCompanyMarketTarballInstallChannel({
      policy: fullPolicy,
      profileDir: '/tmp/profile',
      fetchManifestText: async () => stableText,
      betaOverlay: () => betaOverlay(43),
    })
    await expect(channel.verifyTarballEntry(
      { packageName: 'company-beta-plugin', version: '0.9.0' },
      new AbortController().signal,
    )).resolves.toMatchObject({
      integrity: entry().integrity,
      tarball: `${origin}/packages/company-beta-plugin-0.9.0.tgz`,
    })
  })

  it('a non-roster machine (overlay undefined) keeps the registry path: the beta entry does not verify', async () => {
    const channel = createDesktopCompanyMarketTarballInstallChannel({
      policy: fullPolicy,
      profileDir: '/tmp/profile',
      fetchManifestText: async () => stableText,
      betaOverlay: async () => undefined,
    })
    await expect(channel.verifyTarballEntry(
      { packageName: 'company-beta-plugin', version: '0.9.0' },
      new AbortController().signal,
    )).resolves.toBeUndefined()
  })

  it('a stale beta overlay (sequence below stable) is ignored', async () => {
    const channel = createDesktopCompanyMarketTarballInstallChannel({
      policy: fullPolicy,
      profileDir: '/tmp/profile',
      fetchManifestText: async () => stableText,
      betaOverlay: () => betaOverlay(41),
    })
    await expect(channel.verifyTarballEntry(
      { packageName: 'company-beta-plugin', version: '0.9.0' },
      new AbortController().signal,
    )).resolves.toBeUndefined()
  })
})

describe('boot verification beta fallback (P9 scenario 2/3)', () => {
  const boot = (options: { betaPackages?: readonly unknown[]; betaSequence?: number; revoked?: boolean }) => {
    const stable = signedText(unsignedManifest({ packages: [entry({ revoked: false })] }))
    const verifiedStable = verifyDesktopCompanyManifest(stable, { trustRoots, companyCatalogOrigin: origin, now })
    expect(verifiedStable.ok).toBe(true)
    if (!verifiedStable.ok) throw new Error('unreachable')
    const betaEntry = entry({ packageName: 'company-beta-plugin', version: '0.9.0', revoked: options.revoked === true })
    const bundles = [{
      packageName: 'company-beta-plugin',
      version: '0.9.0',
      lockIntegrity: betaEntry.integrity as string,
      packageDir: '/plugins/company-beta-plugin',
    }]
    return verifyDesktopBootBundles(stable, bundles, {
      trustRoots,
      companyCatalogOrigin: origin,
      now,
      ...(options.betaPackages === undefined
        ? {}
        : { betaPackages: options.betaPackages as unknown as readonly DesktopCompanyManifestPackage[] }),
      ...(options.betaSequence === undefined ? {} : { betaSequence: options.betaSequence }),
    })
  }

  it('a beta entry the stable manifest does not pin may load for a roster machine', () => {
    const result = boot({
      betaPackages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0' })],
      betaSequence: 43,
    })
    expect(result.manifestTrusted).toBe(true)
    expect(result.allowed.map(bundle => bundle.packageName)).toEqual(['company-beta-plugin'])
    expect(result.manifestSequence).toBe(42)
  })

  it('scenario 3 (post-promote): once stable pins the same entry, the beta overlay is redundant', () => {
    const stable = signedText(unsignedManifest({
      packages: [entry(), entry({ packageName: 'company-beta-plugin', version: '0.9.0' })],
    }))
    const result = verifyDesktopBootBundles(stable, [{
      packageName: 'company-beta-plugin',
      version: '0.9.0',
      lockIntegrity: entry({ packageName: 'company-beta-plugin', version: '0.9.0' }).integrity as string,
      packageDir: '/plugins/company-beta-plugin',
    }], {
      trustRoots,
      companyCatalogOrigin: origin,
      now,
      // The beta manifest still repeats the entry (the pipeline keeps the
      // superset) — identical fields, so the merged decision is one entry.
      betaPackages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0' })] as unknown as readonly DesktopCompanyManifestPackage[],
      betaSequence: 44,
    })
    expect(result.allowed.map(bundle => bundle.packageName)).toEqual(['company-beta-plugin'])
  })

  it('a revoked beta entry is rejected even for a roster machine', () => {
    const result = boot({
      betaPackages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0', revoked: true })],
      betaSequence: 43,
    })
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('revoked')
  })

  it('a stable-revoked entry is not resurrected by a beta overlay entry saying revoked:false', () => {
    // The post-revoke shape on a roster machine: stable pins the bundle
    // revoked:true while the stale beta overlay still says false — boot
    // verification must keep refusing the load.
    const stable = signedText(unsignedManifest({
      packages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0', revoked: true })],
    }))
    const result = verifyDesktopBootBundles(stable, [{
      packageName: 'company-beta-plugin',
      version: '0.9.0',
      lockIntegrity: entry({ packageName: 'company-beta-plugin', version: '0.9.0' }).integrity as string,
      packageDir: '/plugins/company-beta-plugin',
    }], {
      trustRoots,
      companyCatalogOrigin: origin,
      now,
      betaPackages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0', revoked: false })] as unknown as readonly DesktopCompanyManifestPackage[],
      betaSequence: 44,
    })
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('revoked')
  })

  it('a beta overlay below the stable sequence is stale and ignored (stable-only rejection)', () => {
    const result = boot({
      betaPackages: [entry({ packageName: 'company-beta-plugin', version: '0.9.0' })],
      betaSequence: 41,
    })
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('not in the signed company manifest')
  })

  it('scenario 1/4 (no overlay): today\'s stable-only behavior is unchanged', () => {
    const result = boot({})
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('not in the signed company manifest')
  })
})
