/**
 * Signer round-trip for the guardrail security-prompt document (#046,
 * publish side): the emitted bytes must satisfy the desktop client's ACTUAL
 * verifier (`dsh-plugin-desktop/src/company-guardrail.ts`), reached through
 * the desktop verification seam (`scripts/verify-security-prompt-document.ts`
 * under node --experimental-transform-types — plain Node cannot import the
 * desktop TypeScript sources from tools/). Everything runs offline with an
 * ephemeral in-memory signing key — exactly the catalog selftest discipline.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, after, describe, it } from 'node:test'
import { loadMarketLibrary } from '../lib/market.mjs'
import { verifyWithDesktopClient } from '../lib/verify-seam.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const SIGNER = join(TOOL_DIR, '..', 'sign-prompt-document.mjs')
const TEMPLATE = join(TOOL_DIR, '..', '..', '..', 'dsh-plugin-desktop', 'assets', 'company-guardrail', 'prompt-template-v1.md')
const FLEET_POLICY = join(TOOL_DIR, '..', '..', '..', 'dsh-plugin-desktop', 'src', 'policy', 'desktop-policy.release.json')

/** One ephemeral signing identity per test file: env values + the derived root. */
const pair = generateKeyPairSync('ed25519')
const signingKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const keyId = 'guardrail-signer-spec'
const rawPublicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url')
const fingerprint = createHash('sha256').update(rawPublicKey).digest('hex')
const ENV = { COMPANY_CATALOG_SIGNING_KEY: signingKey, COMPANY_CATALOG_KEY_ID: keyId }

const roots = []

function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guardrail-sign-'))
  roots.push(root)
  return root
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Run the signer CLI as a subprocess (the catalog tests' discipline). */
function runSigner(args, env = ENV) {
  return spawnSync(process.execPath, [SIGNER, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 })
}

/** Verify one document file with the desktop client's actual verifier. */
function verify(file) {
  return verifyWithDesktopClient(file, policyPath)
}

let policyPath
before(() => {
  const root = temporaryDirectory()
  policyPath = join(root, 'roots.json')
  writeFileSync(policyPath, `${JSON.stringify({ trustRoots: [{ keyId, fingerprint }] })}\n`)
})

describe('sign-prompt-document round-trip', () => {
  it('signs a document the desktop client verifier accepts', () => {
    const root = temporaryDirectory()
    const out = join(root, 'security-prompt.beta.json')
    const result = runSigner(['--revision', '7', '--channel', 'beta', '--key-from-env', '--out', out])
    assert.equal(result.status, 0, `signer failed:\n${result.stderr}`)
    assert.ok(existsSync(out), 'the signed document was written')
    const verdict = verify(out)
    assert.equal(verdict.ok, true, `client verifier refused the signed bytes: ${JSON.stringify(verdict)}`)
    assert.equal(verdict.revision, 7)
    assert.equal(verdict.keyId, keyId)
    assert.equal(verdict.fingerprint, fingerprint)
  })

  it('emits canonical bytes (no pretty printing, no trailing newline)', async () => {
    const market = await loadMarketLibrary()
    const root = temporaryDirectory()
    const out = join(root, 'staged.json')
    const result = runSigner(['--revision', '1', '--key-from-env', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(out, 'utf8')
    assert.ok(!text.includes('\n'), 'the document is a single canonical line')
    const parsed = JSON.parse(text)
    assert.equal(market.canonicalJsonText(parsed), text, 'the bytes are the canonical serialization of their parsed value')
    assert.notEqual(JSON.stringify(parsed, null, 2), text, 'pretty-printed serialization must differ (the client refuses it)')
    assert.deepEqual(Object.keys(parsed.signature).sort(), ['keyId', 'publicKey', 'value'])
  })

  it('signs the frozen embedded template asset verbatim', async () => {
    const market = await loadMarketLibrary()
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    const result = runSigner(['--revision', '2', '--key-from-env', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const document = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(document.template, readFileSync(TEMPLATE, 'utf8'))
    assert.equal(
      market.ed25519PublicKeyFingerprint(Buffer.from(document.signature.publicKey, 'base64')),
      fingerprint,
      'the signature publicKey is the raw 32-byte signing key the fingerprint pins',
    )
  })

  it('writes the audit meta sidecar with the recomputed hashes', () => {
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    const result = runSigner(['--revision', '3', '--channel', 'stable', '--key-from-env', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const meta = JSON.parse(readFileSync(`${out}.meta.json`, 'utf8'))
    const bytes = readFileSync(out)
    assert.equal(meta.revision, 3)
    assert.equal(meta.channel, 'stable')
    assert.equal(meta.keyId, keyId)
    assert.equal(meta.fingerprint, fingerprint)
    assert.equal(meta.templateSha256, createHash('sha256').update(readFileSync(TEMPLATE)).digest('hex'))
    assert.equal(meta.bytesSha256, createHash('sha256').update(bytes).digest('hex'))
  })

  it('defaults expiresAt to ~90 days out', () => {
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    const result = runSigner(['--revision', '1', '--key-from-env', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const document = JSON.parse(readFileSync(out, 'utf8'))
    const horizon = Date.parse(document.expiresAt) - Date.now()
    assert.ok(horizon > 89 * 86_400_000 && horizon < 91 * 86_400_000, `expiresAt horizon was ${String(horizon)} ms`)
  })

  it('detects tampering: a flipped template byte fails the client verifier', async () => {
    const market = await loadMarketLibrary()
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    assert.equal(runSigner(['--revision', '4', '--key-from-env', '--out', out]).status, 0)
    const tampered = JSON.parse(readFileSync(out, 'utf8'))
    tampered.template = tampered.template.replace('Asset protection', 'EVIL protection')
    const tamperedPath = join(root, 'tampered.json')
    writeFileSync(tamperedPath, market.canonicalJsonText(tampered))
    const verdict = verify(tamperedPath)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'bad-signature')
  })

  it('refuses to verify under trust roots that do not pin the signing key', () => {
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    assert.equal(runSigner(['--revision', '5', '--key-from-env', '--out', out]).status, 0)
    // The committed release policy pins the deployment roots, not this
    // test's ephemeral key: the fleet's trust decision refuses the bytes.
    const verdict = verifyWithDesktopClient(out, FLEET_POLICY)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'unknown-key')
  })

  it('refuses templates the client would refuse (token and size rules)', () => {
    const cases = [
      { template: 'policy text with no placeholder at all', fragment: 'token exactly once' },
      { template: '{user_input_placeholder}\n<policy after the input?>', fragment: 'token exactly once' },
      { template: '<policy>\n{user_input_placeholder}\nmiddle\n{user_input_placeholder}\n', fragment: 'token exactly once' },
      { template: `x`.repeat(8 * 1024 + 1), fragment: 'byte bound' },
    ]
    for (const { template, fragment } of cases) {
      const root = temporaryDirectory()
      const templatePath = join(root, 'template.md')
      const out = join(root, 'doc.json')
      writeFileSync(templatePath, template)
      const result = runSigner(['--template', templatePath, '--revision', '1', '--key-from-env', '--out', out])
      assert.notEqual(result.status, 0, `the signer accepted a template it must refuse (${fragment})`)
      assert.match(result.stderr, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      assert.ok(!existsSync(out), 'nothing was written for a refused template')
    }
  })

  it('refuses to run without --key-from-env or without the environment key', () => {
    const root = temporaryDirectory()
    const out = join(root, 'doc.json')
    const missing = runSigner(['--revision', '1', '--out', out], {})
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /--key-from-env is required/)
    const blank = runSigner(['--revision', '1', '--key-from-env', '--out', out], { COMPANY_CATALOG_SIGNING_KEY: '', COMPANY_CATALOG_KEY_ID: keyId })
    assert.notEqual(blank.status, 0)
    assert.match(blank.stderr, /missing COMPANY_CATALOG_SIGNING_KEY/)
    assert.ok(!existsSync(out))
  })

  it('refuses a non-positive or malformed revision and a past expiry', () => {
    const root = temporaryDirectory()
    for (const args of [['--revision', '0'], ['--revision', '-1'], ['--revision', 'seven']]) {
      const result = runSigner([...args, '--key-from-env', '--out', join(root, 'doc.json')])
      assert.notEqual(result.status, 0, `revision ${String(args[1])} must be refused`)
    }
    const past = runSigner(['--revision', '1', '--expires-at', '2020-01-01T00:00:00Z', '--key-from-env', '--out', join(root, 'doc.json')])
    assert.notEqual(past.status, 0)
    assert.match(past.stderr, /already in the past/)
  })
})
