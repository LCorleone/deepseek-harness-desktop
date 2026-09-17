/**
 * Intranet uploader checks (#046, publish side): the filename↔channel
 * pairing, the fleet-trust re-verification through the desktop seam, and
 * the anti-rollback floor against the deployed document — with the
 * deployed GET and the GitLab commits API mocked in-process (no network,
 * no real GitLab). Mirrors the publish-local ratchet stance: a publish
 * must be strictly greater than the deployed revision, and a GET that
 * cannot establish the deployed state is a warning requiring --force.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { runPromptDocumentUpload, channelFilename } from '../upload-prompt-document.mjs'
import { loadMarketLibrary } from '../lib/market.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const SIGNER = join(TOOL_DIR, '..', 'sign-prompt-document.mjs')

/** One ephemeral signing identity for the whole file (the signer signs the fixture once). */
const pair = generateKeyPairSync('ed25519')
const signingKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const keyId = 'guardrail-upload-spec'
const rawPublicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url')
const fingerprint = createHash('sha256').update(rawPublicKey).digest('hex')

const roots = []
function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guardrail-upload-'))
  roots.push(root)
  return root
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let signedBeta
let signedBetaBytes
let policyPath

before(async () => {
  const root = temporaryDirectory()
  policyPath = join(root, 'roots.json')
  writeFileSync(policyPath, `${JSON.stringify({ trustRoots: [{ keyId, fingerprint }] })}\n`)
  signedBeta = join(root, channelFilename('beta'))
  const result = spawnSync(process.execPath, [SIGNER, '--revision', '7', '--channel', 'beta', '--key-from-env', '--out', signedBeta], {
    encoding: 'utf8',
    env: { ...process.env, COMPANY_CATALOG_SIGNING_KEY: signingKey, COMPANY_CATALOG_KEY_ID: keyId },
    timeout: 120_000,
  })
  assert.equal(result.status, 0, `the fixture signer failed:\n${result.stderr}`)
  signedBetaBytes = readFileSync(signedBeta)
})

/** Sinks that capture every report line, so refusals assert on their words. */
const capturingSinks = () => {
  const lines = []
  return {
    lines,
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
  }
}

/** A mocked deployed GET + commits API POST: dispatches by method and URL shape. */
function mockGitlab({ deployedRevision, deployedStatus = 200, getError, postStatus = 201, confirmBytes } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ method: init.method ?? 'GET', url: target, init })
    if (getError !== undefined && (init.method ?? 'GET') === 'GET' && !target.includes('/api/v4/')) {
      throw getError
    }
    if (target.includes('/api/v4/projects/') && target.endsWith('/repository/commits')) {
      assert.equal(init.method, 'POST', 'the commits endpoint is only ever POSTed')
      const body = JSON.stringify({ id: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', short_id: 'deadbeef', web_url: 'https://gitlab.example/julu/dsh-desktop-config/-/commit/deadbeef' })
      return new Response(body, { status: postStatus, headers: { 'content-type': 'application/json' } })
    }
    // The deployed-document raw URL (and the post-push confirm re-read).
    if ((init.method ?? 'GET') === 'GET') {
      if (deployedStatus === 404) {
        return new Response('not found', { status: 404 })
      }
      const served = confirmBytes !== undefined && target.includes('?t=')
        ? confirmBytes
        : JSON.stringify({ revision: deployedRevision, template: 'deployed template {user_input_placeholder}', expiresAt: '2030-01-01T00:00:00Z' })
      return new Response(served, { status: deployedStatus, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected mocked request ${String(init.method)} ${target}`)
  }
  return { calls, fetchImpl }
}

const baseOptions = (over = {}) => ({
  file: signedBeta,
  channel: 'beta',
  policyPath,
  gitlabToken: 'test-pat',
  ...over,
})

describe('filename↔channel pairing', () => {
  it('refuses a stable upload of a beta-named file and the reverse', async () => {
    const sinks = capturingSinks()
    const result = await runPromptDocumentUpload({ ...baseOptions({ channel: 'stable' }), ...sinks })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('security-prompt.json')), sinks.lines.join('\n'))

    const market = await loadMarketLibrary()
    const stableCopy = join(temporaryDirectory(), channelFilename('stable'))
    const document = JSON.parse(signedBetaBytes.toString('utf8'))
    writeFileSync(stableCopy, market.canonicalJsonText(document))
    const sinks2 = capturingSinks()
    const result2 = await runPromptDocumentUpload({ ...baseOptions({ file: stableCopy, channel: 'beta' }), ...sinks2 })
    assert.equal(result2.exitCode, 1)
    assert.ok(sinks2.lines.some((line) => line.includes('security-prompt.beta.json')), sinks2.lines.join('\n'))
  })

  it('exposes the per-channel deployed file names', () => {
    assert.equal(channelFilename('beta'), 'security-prompt.beta.json')
    assert.equal(channelFilename('stable'), 'security-prompt.json')
    assert.throws(() => channelFilename('canary'), /must be 'beta' or 'stable'/)
  })
})

describe('fleet-trust re-verification', () => {
  it('refuses a document that does not verify under the policy trust roots', async () => {
    const market = await loadMarketLibrary()
    const tampered = JSON.parse(signedBetaBytes.toString('utf8'))
    tampered.template = tampered.template.replace('Asset protection', 'EVIL protection')
    const tamperedPath = join(temporaryDirectory(), channelFilename('beta'))
    writeFileSync(tamperedPath, market.canonicalJsonText(tampered))
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 3 })
    const result = await runPromptDocumentUpload({ ...baseOptions({ file: tamperedPath }), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('does not verify against the fleet trust roots')), sinks.lines.join('\n'))
    assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0, 'nothing may be pushed for an unverified document')
  })

  it('refuses a document with no safe positive revision', async () => {
    const badPath = join(temporaryDirectory(), channelFilename('beta'))
    writeFileSync(badPath, JSON.stringify({ revision: 0, template: 'x {user_input_placeholder}' }))
    const sinks = capturingSinks()
    const result = await runPromptDocumentUpload({ ...baseOptions({ file: badPath }), ...sinks })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('no safe positive integer revision')), sinks.lines.join('\n'))
  })
})

describe('anti-rollback floor (mocked deployed GET)', () => {
  it('refuses when the deployed revision equals the document (replay)', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 7 })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('anti-rollback refusal')), sinks.lines.join('\n'))
    assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0)
  })

  it('refuses when the deployed revision is greater (rollback)', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 9 })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('anti-rollback refusal')), sinks.lines.join('\n'))
  })

  it('the refusal is not bypassable with --force', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 7 })
    const result = await runPromptDocumentUpload({ ...baseOptions({ force: true }), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('not bypassable with --force')), sinks.lines.join('\n'))
  })

  it('proceeds when the deployed revision is strictly lower (update action, exact bytes)', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 6, confirmBytes: signedBetaBytes.toString('utf8') })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 0, sinks.lines.join('\n'))
    const posts = gitlab.calls.filter((call) => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.ok(posts[0] && posts[0].url.includes('/api/v4/projects/julu%2Fdsh-desktop-config/repository/commits'), posts[0] && posts[0].url)
    assert.equal(posts[0] && posts[0].init.headers['private-token'], 'test-pat')
    const payload = JSON.parse(posts[0] && posts[0].init.body)
    assert.equal(payload.branch, 'master')
    assert.equal(payload.actions.length, 1)
    assert.equal(payload.actions[0].action, 'update')
    assert.equal(payload.actions[0].file_path, 'security-prompt.beta.json')
    assert.equal(payload.actions[0].encoding, 'base64')
    assert.equal(payload.actions[0].content, signedBetaBytes.toString('base64'), 'the API carries the exact canonical bytes')
    assert.ok(sinks.lines.some((line) => line.includes('deployment confirmed')), sinks.lines.join('\n'))
    assert.ok(sinks.lines.some((line) => line.includes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')), 'the commit sha is printed')
  })

  it('a 404 deployed file is a first publish (create action)', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedStatus: 404 })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 0, sinks.lines.join('\n'))
    const posts = gitlab.calls.filter((call) => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(JSON.parse(posts[0] && posts[0].init.body).actions[0].action, 'create')
  })

  it('a failed deployed GET is a warning that requires --force', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ getError: new Error('connection reset') })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('floor is unknown')), sinks.lines.join('\n'))
    assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0)

    const forced = capturingSinks()
    const forcedGitlab = mockGitlab({ getError: new Error('connection reset'), confirmBytes: signedBetaBytes.toString('utf8') })
    const forcedResult = await runPromptDocumentUpload({ ...baseOptions({ force: true }), ...forced, fetchImpl: forcedGitlab.fetchImpl })
    assert.equal(forcedResult.exitCode, 0, forced.lines.join('\n'))
    assert.ok(forced.lines.some((line) => line.includes('--force acknowledged')), forced.lines.join('\n'))
    assert.equal(JSON.parse((forcedGitlab.calls.find((call) => call.method === 'POST') || {}).init.body).actions[0].action, 'update')
  })

  it('an unexpected deployed status is also a floor-unknown warning', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedStatus: 502 })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('floor is unknown')), sinks.lines.join('\n'))
  })

  it('--dry-run stops after the pre-checks without any commit POST', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedStatus: 404 })
    const result = await runPromptDocumentUpload({ ...baseOptions({ dryRun: true }), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 0, sinks.lines.join('\n'))
    assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0)
    assert.ok(sinks.lines.some((line) => line.includes('stopped before the commit API')), sinks.lines.join('\n'))
  })

  it('fails closed when the commits API refuses', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 6, postStatus: 400 })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('the commit failed')), sinks.lines.join('\n'))
  })
})

describe('review P3 hardening (2026-09-17)', () => {
  it('refuses a meta sidecar that disagrees with the channel — no commit POST', async () => {
    const metaSidecar = `${signedBeta}.meta.json`
    const original = readFileSync(metaSidecar, 'utf8')
    writeFileSync(metaSidecar, JSON.stringify({ ...JSON.parse(original), channel: 'stable' }))
    try {
      const sinks = capturingSinks()
      const gitlab = mockGitlab({ deployedStatus: 404 })
      const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
      assert.equal(result.exitCode, 1)
      assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0)
      assert.ok(sinks.lines.some((line) => line.includes('cross-channel deploy')), sinks.lines.join('\n'))
    } finally {
      writeFileSync(metaSidecar, original)
    }
  })

  it('refuses a meta sidecar whose revision disagrees with the document', async () => {
    const metaSidecar = `${signedBeta}.meta.json`
    const original = readFileSync(metaSidecar, 'utf8')
    writeFileSync(metaSidecar, JSON.stringify({ ...JSON.parse(original), revision: 99 }))
    try {
      const sinks = capturingSinks()
      const gitlab = mockGitlab({ deployedStatus: 404 })
      const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
      assert.equal(result.exitCode, 1)
      assert.equal(gitlab.calls.filter((call) => call.method === 'POST').length, 0)
      assert.ok(sinks.lines.some((line) => line.includes('mismatched pair')), sinks.lines.join('\n'))
    } finally {
      writeFileSync(metaSidecar, original)
    }
  })

  it('hard-fails when the post-push confirm serves different parseable bytes', async () => {
    const sinks = capturingSinks()
    const gitlab = mockGitlab({ deployedRevision: 6, confirmBytes: '{"revision":7,"template":"not what we pushed {user_input_placeholder}","expiresAt":"2030-01-01T00:00:00Z"}' })
    const result = await runPromptDocumentUpload({ ...baseOptions(), ...sinks, fetchImpl: gitlab.fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.ok(sinks.lines.some((line) => line.includes('serves different bytes after the push')), sinks.lines.join('\n'))
  })
})
