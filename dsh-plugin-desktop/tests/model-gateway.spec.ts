import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeModelGatewayBlob,
  modelGatewayPayloadFromEnvironment,
  renderModelGatewayBlobModule,
} from '../scripts/make-model-gateway-blob.mjs'
import { parseDesktopPolicy, DESKTOP_POLICY_ENVIRONMENT, type DesktopPolicy } from '../src/desktop-policy.ts'
import {
  COMPANY_LLM_GATEWAY_API_KEY_ENV,
  COMPANY_LLM_GATEWAY_PROVIDER_ROUTE,
  companyModelGatewayDefaultModel,
  companyModelGatewayProviderProfile,
  decodeModelGatewayBlob,
  managedModelGateway,
  managedModelsPresetGateEntry,
  readStoredCredentialNames,
  resolveManagedModelGatewayEnvironment,
  storedCredentialsPath,
} from '../src/model-gateway.ts'
import { MODEL_GATEWAY_BLOB } from '../src/model-gateway-blob.ts'

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function policy(locked: boolean, managedModels: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked,
    managedModels,
    trustRoots: [],
  })
}

function emptyProbe(overrides: Record<string, unknown> = {}): {
  inheritedApiKeyValue: string | undefined
  storedCredentials: { status: 'ok', names: ReadonlySet<string> }
} {
  return { inheritedApiKeyValue: undefined, storedCredentials: { status: 'ok', names: new Set() }, ...overrides }
}

describe('model gateway blob codec', () => {
  it('round-trips a payload through the generator encoder and the runtime decoder', () => {
    const payload = {
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH', 'SECOND-MODEL'],
    }

    expect(decodeModelGatewayBlob(encodeModelGatewayBlob(payload))).toEqual(payload)
  })

  it('never leaves plaintext inside the blob', () => {
    const payload = {
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH'],
    }
    const blob = encodeModelGatewayBlob(payload)

    expect(blob).not.toContain('gateway.company.example')
    expect(blob).not.toContain('company-secret-token')
    expect(blob).not.toContain('DSV4')
  })

  it('decodes the committed blob to the pinned managed catalog', () => {
    // The repository must never carry the gateway URL or token in plaintext,
    // so these assertions stay structural: an https endpoint, a non-empty
    // bearer token, and the pinned default model first.
    const gateway = decodeModelGatewayBlob(MODEL_GATEWAY_BLOB)

    expect(gateway.baseUrl.startsWith('https://')).toBe(true)
    expect(gateway.apiKey.length).toBeGreaterThan(0)
    expect(gateway.models.length).toBeGreaterThan(0)
    expect(gateway.models[0]).toBe('DSV4-DSH')
    expect(new Set(gateway.models).size).toBe(gateway.models.length)
    expect(Object.isFrozen(gateway)).toBe(true)
    expect(Object.isFrozen(gateway.models)).toBe(true)
  })

  it.each([
    ['an empty blob', ''],
    ['a whitespace blob', '   '],
    ['a non-base64 blob', '!!!!not-base64-payload!!!!'],
    ['a blob that is not JSON', Buffer.from('this is not json at all', 'utf8').toString('base64')],
    ['a JSON array payload', Buffer.from('[1,2,3]', 'utf8').toString('base64')],
    ['a payload with extra fields', encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'token',
      models: ['DSV4-DSH'],
      ...{ extra: true },
    })],
    ['a payload with a non-https baseUrl', encodeModelGatewayBlob({
      baseUrl: 'http://gateway.company.example/v1',
      apiKey: 'token',
      models: ['DSV4-DSH'],
    })],
    ['a payload with an empty baseUrl', encodeModelGatewayBlob({
      baseUrl: '',
      apiKey: 'token',
      models: ['DSV4-DSH'],
    })],
    ['a payload with an empty apiKey', encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: '',
      models: ['DSV4-DSH'],
    })],
    ['a payload with an empty model list', encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'token',
      models: [],
    })],
    ['a payload with duplicate models', encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'token',
      models: ['DSV4-DSH', 'DSV4-DSH'],
    })],
    ['a payload with a non-string model id', encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'token',
      models: [17] as unknown as string[],
    })],
  ])('rejects %s', (_label, blob) => {
    expect(() => decodeModelGatewayBlob(blob)).toThrow('invalid model gateway blob')
  })

  it('keeps blob content out of the failure diagnostics', () => {
    const blob = encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH'],
    })
    // Truncate the tail so the decoded payload is unterminated JSON: the
    // failure must name the condition, never the payload bytes.
    const malformed = blob.slice(0, -4)

    try {
      decodeModelGatewayBlob(malformed)
      expect.unreachable('decoding must fail')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).not.toContain('gateway.company.example')
      expect(message).not.toContain('company-secret-token')
    }
  })
})

describe('managed gateway policy gate', () => {
  it('decodes only for a locked managed policy', () => {
    const gateway = managedModelGateway(policy(true, true))

    expect(gateway).toBeDefined()
    expect(gateway?.models[0]).toBe('DSV4-DSH')
  })

  it.each([
    ['an omitted policy', undefined],
    ['an unlocked build', policy(false, true)],
    ['a locked open build', policy(true, false)],
  ])('never decodes the blob for %s', (_label, injected) => {
    expect(managedModelGateway(injected)).toBeUndefined()
    // Even a corrupt blob stays unread: no decode, no throw.
    expect(managedModelGateway(injected, 'not-a-valid-blob!!!')).toBeUndefined()
  })

  it('fails closed when a managed build carries a corrupt blob', () => {
    expect(() => managedModelGateway(policy(true, true), 'not-a-valid-blob!!!')).toThrow(
      'invalid model gateway blob',
    )
  })
})

describe('managed gateway provider profile', () => {
  const gateway = decodeModelGatewayBlob(MODEL_GATEWAY_BLOB)

  it('renders the in-memory llm-pi-ai profile without the api key', () => {
    expect(companyModelGatewayProviderProfile(gateway)).toEqual({
      displayName: 'Company LLM Gateway',
      apiKeyEnv: COMPANY_LLM_GATEWAY_API_KEY_ENV,
      api: 'openai-completions',
      baseURL: gateway.baseUrl,
      models: [{ id: 'DSV4-DSH' }],
    })
  })

  it('pins the first listed model as the default selection', () => {
    expect(companyModelGatewayDefaultModel(gateway)).toEqual({
      provider: COMPANY_LLM_GATEWAY_PROVIDER_ROUTE,
      model: 'DSV4-DSH',
    })
    expect(companyModelGatewayDefaultModel({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      models: ['FIRST-MODEL', 'SECOND-MODEL'],
    })).toEqual({ provider: COMPANY_LLM_GATEWAY_PROVIDER_ROUTE, model: 'FIRST-MODEL' })
  })
})

describe('managed-models preset gate environment entry', () => {
  it("reuses the CLI policy hand-off's managedModels environment name", () => {
    // One name carries the same fact to the preset expression and to the CLI
    // hand-off, so the two can never drift apart.
    expect(managedModelsPresetGateEntry(policy(true, true)).name)
      .toBe(DESKTOP_POLICY_ENVIRONMENT.managedModels)
  })

  it("writes '1' only for the effective managed posture and '0' otherwise", () => {
    // main.ts applies this entry unconditionally before the Host composition
    // loads, so an open or unlocked launch both evaluates the preset gate to
    // false and scrubs any stray inherited '1'.
    expect(managedModelsPresetGateEntry(policy(true, true)).value).toBe('1')
    expect(managedModelsPresetGateEntry(policy(true, false)).value).toBe('0')
    expect(managedModelsPresetGateEntry(policy(false, true)).value).toBe('0')
    expect(managedModelsPresetGateEntry(policy(false, false)).value).toBe('0')
  })
})

describe('managed gateway environment injection decision', () => {
  const gateway = decodeModelGatewayBlob(MODEL_GATEWAY_BLOB)

  it('stays inert for unmanaged builds', () => {
    expect(resolveManagedModelGatewayEnvironment(undefined, emptyProbe()))
      .toEqual({ managed: false, reason: 'unmanaged-build' })
  })

  it('injects the gateway token when the user configured nothing', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe())

    expect(decision).toEqual({
      managed: true,
      inject: true,
      reason: 'injected',
      environment: { [COMPANY_LLM_GATEWAY_API_KEY_ENV]: gateway.apiKey },
    })
  })

  it('yields to a user-provided inherited environment value', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      inheritedApiKeyValue: 'user-own-token',
    }))

    expect(decision).toEqual({ managed: true, inject: false, reason: 'user-environment' })
  })

  it('treats an empty inherited value as unset, mirroring the credentials seam', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      inheritedApiKeyValue: '',
    }))

    expect(decision).toMatchObject({ managed: true, inject: true })
  })

  it('yields to a stored credential with the same reference name', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      storedCredentials: {
        status: 'ok',
        names: new Set(['UNRELATED_KEY', COMPANY_LLM_GATEWAY_API_KEY_ENV]),
      },
    }))

    expect(decision).toEqual({ managed: true, inject: false, reason: 'user-credentials' })
  })

  it('yields when the credentials document cannot be probed', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, {
      inheritedApiKeyValue: undefined,
      storedCredentials: { status: 'unreadable', reason: 'the document is invalid' },
    })

    expect(decision).toEqual({
      managed: true,
      inject: false,
      reason: 'unreadable-credential-store',
    })
  })
})

describe('managed gateway credentials probe', () => {
  it('resolves the document path under the harness home like the upstream provider', () => {
    expect(storedCredentialsPath('/dsh-home')).toBe(join('/dsh-home', '.credentials.yaml'))
  })

  it('treats a missing document as an empty store', () => {
    const missing = join(temporaryDirectory(), '.credentials.yaml')

    expect(readStoredCredentialNames(missing)).toEqual({ status: 'ok', names: new Set() })
  })

  it('reads stored reference names without reading values', () => {
    const path = join(temporaryDirectory(), '.credentials.yaml')
    writeFileSync(path, [
      'version: 1',
      'refs:',
      `  ${COMPANY_LLM_GATEWAY_API_KEY_ENV}: user-stored-token`,
      '  OTHER_KEY: other-value',
      '',
    ].join('\n'))

    expect(readStoredCredentialNames(path)).toEqual({
      status: 'ok',
      names: new Set([COMPANY_LLM_GATEWAY_API_KEY_ENV, 'OTHER_KEY']),
    })
  })

  it('reports an unreadable document without quoting its values', () => {
    const path = join(temporaryDirectory(), '.credentials.yaml')
    writeFileSync(path, 'SOME_KEY: secret-value-123\n')

    const probe = readStoredCredentialNames(path)

    expect(probe.status).toBe('unreadable')
    if (probe.status === 'unreadable') {
      expect(probe.reason).toContain('.credentials.yaml')
      expect(probe.reason).not.toContain('secret-value-123')
    }
  })
})

describe('model gateway blob generator', () => {
  it('validates its environment inputs', () => {
    const environment: NodeJS.ProcessEnv = {
      DSH_GATEWAY_BASE_URL: 'https://gateway.company.example/compatible-mode/v1',
      DSH_GATEWAY_API_KEY: 'company-secret-token',
      DSH_GATEWAY_MODELS: ' DSV4-DSH , DSV4-DSH, SECOND-MODEL ',
    }

    expect(modelGatewayPayloadFromEnvironment(environment)).toEqual({
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH', 'SECOND-MODEL'],
    })

    expect(() => modelGatewayPayloadFromEnvironment({ ...environment, DSH_GATEWAY_BASE_URL: 'http://insecure.example/v1' }))
      .toThrow('DSH_GATEWAY_BASE_URL must be a bare https base URL')
    expect(() => modelGatewayPayloadFromEnvironment({ ...environment, DSH_GATEWAY_API_KEY: '' }))
      .toThrow('DSH_GATEWAY_API_KEY must be a non-empty api key')
    expect(() => modelGatewayPayloadFromEnvironment({ ...environment, DSH_GATEWAY_MODELS: 'DSV4-DSH,,X' }))
      .toThrow('DSH_GATEWAY_MODELS must not contain empty model ids')
    expect(() => modelGatewayPayloadFromEnvironment({ ...environment, DSH_GATEWAY_MODELS: '   ' }))
      .toThrow('DSH_GATEWAY_MODELS must be a comma-separated model id list')
  })

  it('renders the generated module with the signed-off disclaimer', () => {
    const module = renderModelGatewayBlobModule(encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH'],
    }))

    expect(module).toContain('GENERATED FILE — do not edit by hand')
    expect(module).toContain('Obfuscation is not encryption')
    expect(module).toContain('export const MODEL_GATEWAY_BLOB =')
    expect(module).not.toContain('gateway.company.example')
    expect(module).not.toContain('company-secret-token')
  })

  it('writes a decodable module from the command line without plaintext', () => {
    const root = temporaryDirectory()
    const out = join(root, 'blob.ts')
    const script = fileURLToPath(new URL('../scripts/make-model-gateway-blob.mjs', import.meta.url))
    const run = spawnSync(process.execPath, [script, '--out', out], {
      env: {
        ...process.env,
        DSH_GATEWAY_BASE_URL: 'https://gateway.company.example/compatible-mode/v1',
        DSH_GATEWAY_API_KEY: 'company-secret-token',
        DSH_GATEWAY_MODELS: 'DSV4-DSH',
      },
    })

    expect(run.status).toBe(0)
    const text = readFileSync(out, 'utf8')
    expect(text).toContain('export const MODEL_GATEWAY_BLOB =')
    expect(text).not.toContain('gateway.company.example')
    expect(text).not.toContain('company-secret-token')
    const blob = /export const MODEL_GATEWAY_BLOB = ("(?:[^"\\]|\\.)*")/u.exec(text)?.[1]
    expect(blob).toBeDefined()
    expect(decodeModelGatewayBlob(JSON.parse(blob!) as string)).toEqual({
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH'],
    })
  })

  it('fails with a reason and without writing when inputs are missing', () => {
    const root = temporaryDirectory()
    const out = join(root, 'blob.ts')
    const script = fileURLToPath(new URL('../scripts/make-model-gateway-blob.mjs', import.meta.url))
    const cleanEnvironment = { ...process.env }
    delete cleanEnvironment.DSH_GATEWAY_BASE_URL
    delete cleanEnvironment.DSH_GATEWAY_API_KEY
    delete cleanEnvironment.DSH_GATEWAY_MODELS
    const run = spawnSync(process.execPath, [script, '--out', out], { env: cleanEnvironment })

    expect(run.status).toBe(1)
    expect(run.stderr.toString()).toContain('DSH_GATEWAY_BASE_URL')
    expect(existsSync(out)).toBe(false)
  })
})
