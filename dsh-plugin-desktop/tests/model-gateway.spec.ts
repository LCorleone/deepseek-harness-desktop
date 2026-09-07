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
  companyModelGatewayDefaultModel,
  companyModelGatewayProviderProfile,
  decodeModelGatewayBlob,
  managedModelGateway,
  managedModelsPresetGateEntry,
  PRESET_MANAGED_MODELS_GATE,
  readStoredCredentialNames,
  resolveManagedModelGatewayEnvironment,
  storedCredentialsPath,
  type CompanyModelGateway,
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
    agentBrowser: { allowOrigins: [], allowPersistLogin: false, enabled: false },
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked,
    managedModels,
    requireSso: false,
    trustRoots: [],
    usageReport: false,
  })
}

/** A synthetic two-provider payload shaped exactly like the committed blob. */
const SYNTHETIC_PAYLOAD = {
  providers: [
    {
      route: 'synthetic-gateway',
      displayName: 'Synthetic Gateway',
      apiKeyEnv: 'DSH_SYNTHETIC_LLM_KEY',
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'synthetic-secret-token',
      models: [
        { id: 'DSV4-DSH', name: 'deepseek-v4-flash' },
        { id: 'SECOND-MODEL' },
      ],
    },
    {
      route: 'synthetic-kimi',
      displayName: 'Synthetic Kimi',
      apiKeyEnv: 'DSH_SYNTHETIC_KIMI_KEY',
      baseUrl: 'https://gateway.company.example/compatible-mode/v1',
      apiKey: 'synthetic-kimi-token',
      models: [{ id: 'kimi-k2.6' }],
    },
  ],
}

function syntheticGateway(): CompanyModelGateway {
  return decodeModelGatewayBlob(encodeModelGatewayBlob(SYNTHETIC_PAYLOAD))
}

function emptyProbe(overrides: Record<string, unknown> = {}): {
  inheritedEnvironment: Record<string, string | undefined>
  storedCredentials: { status: 'ok', names: ReadonlySet<string> }
} {
  return { inheritedEnvironment: {}, storedCredentials: { status: 'ok', names: new Set() }, ...overrides }
}

describe('model gateway blob codec', () => {
  it('round-trips a multi-provider payload through the generator encoder and the runtime decoder', () => {
    expect(decodeModelGatewayBlob(encodeModelGatewayBlob(SYNTHETIC_PAYLOAD))).toEqual(SYNTHETIC_PAYLOAD)
  })

  it('never leaves plaintext inside the blob', () => {
    const blob = encodeModelGatewayBlob(SYNTHETIC_PAYLOAD)

    expect(blob).not.toContain('gateway.company.example')
    expect(blob).not.toContain('synthetic-secret-token')
    expect(blob).not.toContain('synthetic-kimi-token')
    expect(blob).not.toContain('DSV4')
    expect(blob).not.toContain('kimi-k2.6')
  })

  it('decodes the committed blob to the pinned managed roster', () => {
    // The repository must never carry the gateway URLs or tokens in
    // plaintext, so these assertions pin the roster structure (routes,
    // display names, credential environment names, model ids and display
    // names) and stay structural about the secrets: an https endpoint and a
    // non-empty bearer token per provider.
    const gateway = decodeModelGatewayBlob(MODEL_GATEWAY_BLOB)

    expect(gateway.providers).toHaveLength(2)
    const [gatewayProvider, kimiProvider] = gateway.providers
    expect(gatewayProvider).toMatchObject({
      route: 'dsh-company-gateway',
      displayName: 'Company LLM Gateway',
      apiKeyEnv: 'DSH_COMPANY_LLM_KEY',
      models: [{ id: 'DSV4-DSH', name: 'deepseek-v4-flash' }],
    })
    expect(kimiProvider).toMatchObject({
      route: 'dsh-company-kimi',
      displayName: 'Kimi',
      apiKeyEnv: 'DSH_COMPANY_KIMI_KEY',
      models: [{ id: 'kimi-k2.6' }],
    })
    for (const provider of gateway.providers) {
      // Structural on the secrets: an https endpoint and a non-empty bearer
      // token per provider — the URL and key themselves stay blob-only.
      expect(provider?.baseUrl.startsWith('https://')).toBe(true)
      expect(provider?.apiKey.length).toBeGreaterThan(0)
      expect(new Set(provider?.models.map(model => model.id)).size).toBe(provider?.models.length)
    }
    // Both providers ride the same nova gateway address (a different key
    // each), so the base URLs must agree.
    expect(kimiProvider?.baseUrl).toBe(gatewayProvider?.baseUrl)
    // One dedicated credential per provider, never a shared key.
    expect(new Set(gateway.providers.map(provider => provider.apiKey)).size).toBe(2)
    expect(new Set(gateway.providers.map(provider => provider.apiKeyEnv)).size).toBe(2)
    expect(Object.isFrozen(gateway)).toBe(true)
    expect(Object.isFrozen(gateway.providers)).toBe(true)
    for (const provider of gateway.providers) {
      expect(Object.isFrozen(provider)).toBe(true)
      expect(Object.isFrozen(provider?.models)).toBe(true)
      for (const model of provider?.models ?? []) expect(Object.isFrozen(model)).toBe(true)
    }
  })

  it.each([
    ['an empty blob', ''],
    ['a whitespace blob', '   '],
    ['a non-base64 blob', '!!!!not-base64-payload!!!!'],
    ['a blob that is not JSON', Buffer.from('this is not json at all', 'utf8').toString('base64')],
    ['a JSON array payload', encodeModelGatewayBlob([1, 2, 3] as unknown as never)],
    ['a payload with extra top-level fields', encodeModelGatewayBlob({
      ...SYNTHETIC_PAYLOAD,
      ...{ extra: true },
    } as never)],
    ['a payload with an empty provider list', encodeModelGatewayBlob({ providers: [] })],
    ['a provider with extra fields', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0], ...{ extra: true } }],
    } as never)],
    ['a provider with a missing displayName', encodeModelGatewayBlob({
      providers: [{
        route: 'synthetic-gateway',
        apiKeyEnv: 'DSH_SYNTHETIC_LLM_KEY',
        baseUrl: 'https://gateway.company.example/v1',
        apiKey: 'token',
        models: [{ id: 'DSV4-DSH' }],
      }],
    } as never)],
    ['a payload with duplicate provider routes', encodeModelGatewayBlob({
      providers: [SYNTHETIC_PAYLOAD.providers[0], { ...SYNTHETIC_PAYLOAD.providers[1]!, route: 'synthetic-gateway' }],
    } as never)],
    ['a payload with duplicate apiKeyEnvs', encodeModelGatewayBlob({
      providers: [SYNTHETIC_PAYLOAD.providers[0], { ...SYNTHETIC_PAYLOAD.providers[1]!, apiKeyEnv: 'DSH_SYNTHETIC_LLM_KEY' }],
    } as never)],
    ['a provider with a non-DSH apiKeyEnv', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, apiKeyEnv: 'COMPANY_LLM_KEY' }],
    } as never)],
    ['a provider with a lowercase apiKeyEnv', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, apiKeyEnv: 'DSH_Company_LLM_Key' }],
    } as never)],
    ['a provider with a non-https baseUrl', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, baseUrl: 'http://gateway.company.example/v1' }],
    } as never)],
    ['a provider with a userinfo baseUrl', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, baseUrl: 'https://user:pass@gateway.company.example/v1' }],
    } as never)],
    ['a provider with an empty baseUrl', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, baseUrl: '' }],
    } as never)],
    ['a provider with an empty apiKey', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, apiKey: '' }],
    } as never)],
    ['a provider with an empty model list', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [] }],
    } as never)],
    ['a provider with duplicate models', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [{ id: 'DSV4-DSH' }, { id: 'DSV4-DSH' }] }],
    } as never)],
    ['a model entry that is a bare string', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: ['DSV4-DSH'] }],
    } as never)],
    ['a model entry with an unexpected field', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [{ id: 'DSV4-DSH', extra: true }] }],
    } as never)],
    ['a model entry without an id', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [{ name: 'No Id' }] }],
    } as never)],
    ['a model entry with an empty name', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [{ id: 'DSV4-DSH', name: '' }] }],
    } as never)],
    ['a model entry with a non-string name', encodeModelGatewayBlob({
      providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, models: [{ id: 'DSV4-DSH', name: 17 }] }],
    } as never)],
  ])('rejects %s', (_label, blob) => {
    expect(() => decodeModelGatewayBlob(blob)).toThrow('invalid model gateway blob')
  })

  it('rejects non-positive-integer model capacities (upstream catalog requires positive integers)', () => {
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      for (const value of [0, -65536, 131072.5, '262144', null]) {
        expect(() => decodeModelGatewayBlob(encodeModelGatewayBlob({
          providers: [{
            ...SYNTHETIC_PAYLOAD.providers[0]!,
            models: [{ id: 'DSV4-DSH', [field]: value }],
          }],
        } as never))).toThrow(`providers[0].models[0].${field} must be a positive integer when present`)
      }
    }
  })

  it('accepts positive-integer model capacities and keeps them optional', () => {
    const gateway = decodeModelGatewayBlob(encodeModelGatewayBlob({
      providers: [{
        ...SYNTHETIC_PAYLOAD.providers[0]!,
        models: [
          { id: 'CAP-MODEL', contextWindow: 262144, maxTokens: 8192 },
          { id: 'BARE-MODEL' },
        ],
      }],
    } as never))

    expect(gateway.providers[0]?.models).toEqual([
      { id: 'CAP-MODEL', contextWindow: 262144, maxTokens: 8192 },
      { id: 'BARE-MODEL' },
    ])
    // Absent capacities stay absent: the upstream route defaults apply.
    const bare = gateway.providers[0]?.models[1] ?? {}
    expect('contextWindow' in bare).toBe(false)
    expect('maxTokens' in bare).toBe(false)
  })

  it('refuses the retired v1 single-provider blob with a pointer to regeneration', () => {
    const v1Blob = encodeModelGatewayBlob({
      baseUrl: 'https://gateway.company.example/v1',
      apiKey: 'company-secret-token',
      models: ['DSV4-DSH'],
    } as never)

    expect(() => decodeModelGatewayBlob(v1Blob)).toThrow(
      'the decoded payload is the retired single-provider v1 shape; regenerate the blob with '
      + 'scripts/make-model-gateway-blob.mjs reading DSH_GATEWAY_PROVIDERS_JSON',
    )
  })

  it('keeps blob content out of the failure diagnostics', () => {
    const blob = encodeModelGatewayBlob(SYNTHETIC_PAYLOAD)
    // Truncate the tail so the decoded payload is unterminated JSON: the
    // failure must name the condition, never the payload bytes.
    const malformed = blob.slice(0, -4)

    try {
      decodeModelGatewayBlob(malformed)
      expect.unreachable('decoding must fail')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).not.toContain('gateway.company.example')
      expect(message).not.toContain('synthetic-secret-token')
      expect(message).not.toContain('synthetic-kimi-token')
    }
  })
})

describe('managed gateway policy gate', () => {
  it('decodes only for a locked managed policy', () => {
    const gateway = managedModelGateway(policy(true, true))

    expect(gateway).toBeDefined()
    expect(gateway?.providers[0]?.models[0]).toMatchObject({ id: 'DSV4-DSH' })
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

  it('renders the in-memory llm-pi-ai profile for the gateway provider without the api key', () => {
    const provider = gateway.providers[0]
    if (provider === undefined) throw new Error('test requires the gateway provider')

    expect(companyModelGatewayProviderProfile(provider)).toEqual({
      displayName: 'Company LLM Gateway',
      apiKeyEnv: 'DSH_COMPANY_LLM_KEY',
      api: 'openai-completions',
      baseURL: provider.baseUrl,
      models: [{ id: 'DSV4-DSH', name: 'deepseek-v4-flash' }],
    })
  })

  it('renders the in-memory llm-pi-ai profile for the kimi provider without the api key', () => {
    const provider = gateway.providers[1]
    if (provider === undefined) throw new Error('test requires the kimi provider')

    expect(companyModelGatewayProviderProfile(provider)).toEqual({
      displayName: 'Kimi',
      apiKeyEnv: 'DSH_COMPANY_KIMI_KEY',
      api: 'openai-completions',
      baseURL: provider.baseUrl,
      // The kimi entry carries no name: the id is the display name.
      models: [{ id: 'kimi-k2.6' }],
    })
  })

  it('passes model display names and capacities through to the profile models', () => {
    const decoded = decodeModelGatewayBlob(encodeModelGatewayBlob({
      providers: [{
        route: 'synthetic-gateway',
        displayName: 'Synthetic Gateway',
        apiKeyEnv: 'DSH_SYNTHETIC_LLM_KEY',
        baseUrl: 'https://gateway.company.example/v1',
        apiKey: 'synthetic-secret-token',
        models: [
          { id: 'BARE-MODEL' },
          { id: 'NAMED-MODEL', name: 'Named Model' },
          { id: 'CAPPED-MODEL', name: 'Capped Model', contextWindow: 131072, maxTokens: 4096 },
        ],
      }],
    } as never))

    expect(companyModelGatewayProviderProfile(decoded.providers[0]!).models).toEqual([
      { id: 'BARE-MODEL' },
      { id: 'NAMED-MODEL', name: 'Named Model' },
      { id: 'CAPPED-MODEL', name: 'Capped Model', contextWindow: 131072, maxTokens: 4096 },
    ])
  })

  it('pins the first provider\'s first listed model as the default selection', () => {
    expect(companyModelGatewayDefaultModel(gateway)).toEqual({
      provider: 'dsh-company-gateway',
      model: 'DSV4-DSH',
    })
    expect(companyModelGatewayDefaultModel(syntheticGateway())).toEqual({
      provider: 'synthetic-gateway',
      model: 'DSV4-DSH',
    })
  })
})

describe('managed-models preset gate environment entry', () => {
  it('uses the dedicated preset gate name', () => {
    expect(managedModelsPresetGateEntry(policy(true, true)).name).toBe(PRESET_MANAGED_MODELS_GATE)
  })

  it('stays distinct from every CLI policy hand-off key', () => {
    // The gate writes the EFFECTIVE posture (locked && managedModels) into
    // the shared host environment, while the hand-off keys carry the RAW
    // flags as an all-five group that desktopPolicyFromEnvironment refuses
    // to decode partially — one shared name would both blur two facts and
    // leave a lone hand-off-shaped key in the host environment.
    expect(Object.values(DESKTOP_POLICY_ENVIRONMENT)).not.toContain(PRESET_MANAGED_MODELS_GATE)
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
  const [gatewayProvider, kimiProvider] = gateway.providers

  it('stays inert for unmanaged builds', () => {
    expect(resolveManagedModelGatewayEnvironment(undefined, emptyProbe()))
      .toEqual({ managed: false, reason: 'unmanaged-build' })
  })

  it('injects every provider token when the user configured nothing', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe())

    expect(decision).toEqual({
      managed: true,
      environment: {
        DSH_COMPANY_LLM_KEY: gatewayProvider?.apiKey,
        DSH_COMPANY_KIMI_KEY: kimiProvider?.apiKey,
      },
      providers: [
        { route: 'dsh-company-gateway', apiKeyEnv: 'DSH_COMPANY_LLM_KEY', inject: true, reason: 'injected' },
        { route: 'dsh-company-kimi', apiKeyEnv: 'DSH_COMPANY_KIMI_KEY', inject: true, reason: 'injected' },
      ],
    })
  })

  it('yields to a user-provided inherited value, per provider', () => {
    // Only the kimi variable is inherited: the gateway token still injects.
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      inheritedEnvironment: { DSH_COMPANY_KIMI_KEY: 'user-own-kimi-token' },
    }))

    expect(decision).toMatchObject({
      managed: true,
      environment: { DSH_COMPANY_LLM_KEY: gatewayProvider?.apiKey },
      providers: [
        { route: 'dsh-company-gateway', inject: true, reason: 'injected' },
        { route: 'dsh-company-kimi', apiKeyEnv: 'DSH_COMPANY_KIMI_KEY', inject: false, reason: 'user-environment' },
      ],
    })
    expect(decision.managed).toBe(true)
    if (decision.managed) {
      expect(Object.keys(decision.environment)).toEqual(['DSH_COMPANY_LLM_KEY'])
    }
  })

  it('treats an empty inherited value as unset, mirroring the credentials seam', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      inheritedEnvironment: { DSH_COMPANY_LLM_KEY: '', DSH_COMPANY_KIMI_KEY: '' },
    }))

    expect(decision).toMatchObject({
      managed: true,
      environment: {
        DSH_COMPANY_LLM_KEY: gatewayProvider?.apiKey,
        DSH_COMPANY_KIMI_KEY: kimiProvider?.apiKey,
      },
    })
  })

  it('yields to a stored credential with the same reference name, per provider', () => {
    // The user stored the kimi reference: only that provider yields.
    const decision = resolveManagedModelGatewayEnvironment(gateway, emptyProbe({
      storedCredentials: {
        status: 'ok',
        names: new Set(['UNRELATED_KEY', 'DSH_COMPANY_KIMI_KEY']),
      },
    }))

    expect(decision).toMatchObject({
      managed: true,
      environment: { DSH_COMPANY_LLM_KEY: gatewayProvider?.apiKey },
      providers: [
        { route: 'dsh-company-gateway', inject: true, reason: 'injected' },
        { route: 'dsh-company-kimi', apiKeyEnv: 'DSH_COMPANY_KIMI_KEY', inject: false, reason: 'user-credentials' },
      ],
    })
  })

  it('yields for every provider when the credentials document cannot be probed', () => {
    const decision = resolveManagedModelGatewayEnvironment(gateway, {
      inheritedEnvironment: {},
      storedCredentials: { status: 'unreadable', reason: 'the document is invalid' },
    })

    expect(decision).toEqual({
      managed: true,
      environment: {},
      providers: [
        { route: 'dsh-company-gateway', apiKeyEnv: 'DSH_COMPANY_LLM_KEY', inject: false, reason: 'unreadable-credential-store' },
        { route: 'dsh-company-kimi', apiKeyEnv: 'DSH_COMPANY_KIMI_KEY', inject: false, reason: 'unreadable-credential-store' },
      ],
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
      '  DSH_COMPANY_LLM_KEY: user-stored-token',
      '  DSH_COMPANY_KIMI_KEY: user-stored-kimi-token',
      '  OTHER_KEY: other-value',
      '',
    ].join('\n'))

    expect(readStoredCredentialNames(path)).toEqual({
      status: 'ok',
      names: new Set(['DSH_COMPANY_LLM_KEY', 'DSH_COMPANY_KIMI_KEY', 'OTHER_KEY']),
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
  it('validates its environment input', () => {
    const environment: NodeJS.ProcessEnv = {
      DSH_GATEWAY_PROVIDERS_JSON: JSON.stringify(SYNTHETIC_PAYLOAD),
    }

    expect(modelGatewayPayloadFromEnvironment(environment)).toEqual(SYNTHETIC_PAYLOAD)

    expect(() => modelGatewayPayloadFromEnvironment({ DSH_GATEWAY_PROVIDERS_JSON: ' ' }))
      .toThrow('DSH_GATEWAY_PROVIDERS_JSON: must carry the full providers JSON document')
    expect(() => modelGatewayPayloadFromEnvironment({ DSH_GATEWAY_PROVIDERS_JSON: '{nope' }))
      .toThrow('DSH_GATEWAY_PROVIDERS_JSON is not valid JSON')
    expect(() => modelGatewayPayloadFromEnvironment({
      DSH_GATEWAY_PROVIDERS_JSON: JSON.stringify({ providers: [{ ...SYNTHETIC_PAYLOAD.providers[0]!, route: '' }] }),
    })).toThrow('DSH_GATEWAY_PROVIDERS_JSON: providers[0].route must be a non-empty string')
    expect(() => modelGatewayPayloadFromEnvironment({
      DSH_GATEWAY_PROVIDERS_JSON: JSON.stringify({
        providers: [SYNTHETIC_PAYLOAD.providers[0], { ...SYNTHETIC_PAYLOAD.providers[1]!, route: 'synthetic-gateway' }],
      }),
    })).toThrow('DSH_GATEWAY_PROVIDERS_JSON: provider route "synthetic-gateway" is listed more than once')
  })

  it('refuses the retired v1 shape with a pointer to the providers wrapper', () => {
    expect(() => modelGatewayPayloadFromEnvironment({
      DSH_GATEWAY_PROVIDERS_JSON: JSON.stringify({
        baseUrl: 'https://gateway.company.example/v1',
        apiKey: 'token',
        models: ['DSV4-DSH'],
      }),
    })).toThrow('retired single-provider v1 shape')
  })

  it('renders the generated module with the signed-off disclaimer', () => {
    const module = renderModelGatewayBlobModule(encodeModelGatewayBlob(SYNTHETIC_PAYLOAD))

    expect(module).toContain('GENERATED FILE — do not edit by hand')
    expect(module).toContain('Obfuscation is not encryption')
    expect(module).toContain('export const MODEL_GATEWAY_BLOB =')
    expect(module).not.toContain('gateway.company.example')
    expect(module).not.toContain('synthetic-secret-token')
    expect(module).not.toContain('synthetic-kimi-token')
  })

  it('writes a decodable module from the command line without plaintext', () => {
    const root = temporaryDirectory()
    const out = join(root, 'blob.ts')
    const script = fileURLToPath(new URL('../scripts/make-model-gateway-blob.mjs', import.meta.url))
    const run = spawnSync(process.execPath, [script, '--out', out], {
      env: {
        ...process.env,
        DSH_GATEWAY_PROVIDERS_JSON: JSON.stringify(SYNTHETIC_PAYLOAD),
      },
    })

    expect(run.status).toBe(0)
    const text = readFileSync(out, 'utf8')
    expect(text).toContain('export const MODEL_GATEWAY_BLOB =')
    expect(text).not.toContain('gateway.company.example')
    expect(text).not.toContain('synthetic-secret-token')
    expect(text).not.toContain('synthetic-kimi-token')
    const blob = /export const MODEL_GATEWAY_BLOB = ("(?:[^"\\]|\\.)*")/u.exec(text)?.[1]
    expect(blob).toBeDefined()
    expect(decodeModelGatewayBlob(JSON.parse(blob!) as string)).toEqual(SYNTHETIC_PAYLOAD)
  })

  it('fails with a reason and without writing when the input is missing or invalid', () => {
    const root = temporaryDirectory()
    const out = join(root, 'blob.ts')
    const script = fileURLToPath(new URL('../scripts/make-model-gateway-blob.mjs', import.meta.url))
    const cleanEnvironment = { ...process.env }
    delete cleanEnvironment.DSH_GATEWAY_PROVIDERS_JSON

    const missing = spawnSync(process.execPath, [script, '--out', out], { env: cleanEnvironment })
    expect(missing.status).toBe(1)
    expect(missing.stderr.toString()).toContain('DSH_GATEWAY_PROVIDERS_JSON')
    expect(existsSync(out)).toBe(false)

    const invalid = spawnSync(process.execPath, [script, '--out', out], {
      env: { ...cleanEnvironment, DSH_GATEWAY_PROVIDERS_JSON: '{"providers":[]}' },
    })
    expect(invalid.status).toBe(1)
    expect(invalid.stderr.toString()).toContain('providers must be a non-empty array')
    expect(existsSync(out)).toBe(false)
  })
})
