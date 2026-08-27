import { mkdtempSync, rmSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import { fetchCompanyManifestText } from '../src/company-manifest-origin.ts'
import { refuseCompanyManifestRedirects } from '../src/electron-company-manifest.ts'
import { authorizeLockedPluginAdd } from '../src/cli-install-channel.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const originPolicy = parseDesktopPolicy({
  allowHomePatch: false,
  allowManualPluginAdd: false,
  companyCatalogOrigin: 'https://market.company.example',
  companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
  locked: true,
  trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
})

/** Signed manifest fixture the fake Chromium boundary serves. */
function signedManifestText(): string {
  const manifest = {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [{
      packageName: 'example-plugin',
      version: '1.0.0',
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      bundlePatch: './cordis.patch.yml',
      repository: { url: 'https://github.com/example/example-plugin' },
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }],
  }
  const signature = createCompanyManifestSignature(
    manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...manifest, signature })
}

/**
 * The Electron main process injects its Chromium-stack fetch through the
 * redirect wrapper (`fetchCompanyManifestTextOverElectronNet` composes it
 * over `net.fetch`); these tests drive that exact wrapper with fake
 * boundaries — importing Electron inside vitest would crash the run — so the
 * redirect contract stays pinned without a live `net.fetch`.
 */
describe('electron main-process manifest boundary', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('passes a non-redirected response through unchanged', async () => {
    const manifestText = signedManifestText()
    const chromium = vi.fn(async () => new Response(manifestText))

    await expect(fetchCompanyManifestText(
      originPolicy,
      { request: refuseCompanyManifestRedirects(chromium) },
    )).resolves.toBe(manifestText)
    expect(chromium).toHaveBeenCalledTimes(1)
    expect(chromium).toHaveBeenCalledWith(
      'https://market.company.example/catalog-manifest.json',
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('rejects a response that reports a followed redirect', async () => {
    // A Chromium backend that ignored `redirect: 'error'` still answers with
    // `redirected: true`; the wrapper must turn that into the same refusal
    // the request mode itself would have produced. The wrapper throws at its
    // own layer, and the shared fetch helper maps that refusal to the same
    // bounded network failure an `redirect: 'error'` rejection yields.
    const chromium = vi.fn(async () => ({
      redirected: true,
      url: 'https://evil.example/catalog-manifest.json',
      status: 200,
    } as unknown as Response))
    const wrapped = refuseCompanyManifestRedirects(chromium)

    await expect(wrapped('https://market.company.example/catalog-manifest.json', {}))
      .rejects.toThrow('refused a redirect of the company catalog manifest request')
    await expect(fetchCompanyManifestText(originPolicy, { request: wrapped }))
      .rejects.toThrow('the company catalog manifest could not be downloaded')
    expect(chromium).toHaveBeenCalledTimes(2)
  })

  it('fails a locked plugin add closed when the Chromium boundary followed a redirect', async () => {
    // The production composition is (redirect wrapper) ∘ (net.fetch); a
    // redirect that slips through the backend must surface as the shared
    // fail-closed denial, never as fetched manifest bytes.
    const root = mkdtempSync(join(tmpdir(), 'dsh-electron-manifest-redirect-'))
    roots.push(root)
    const chromium = vi.fn(async () => ({
      redirected: true,
      url: 'https://evil.example/catalog-manifest.json',
      status: 200,
    } as unknown as Response))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      originPolicy,
      { fetch: { request: refuseCompanyManifestRedirects(chromium) } },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('could not be fetched from https://market.company.example')
    }
  })
})
