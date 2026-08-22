import { readFileSync } from 'node:fs'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import {
  MarketSourceLockError,
  SettingsCatalogSourceStore,
  type CatalogSourceLockOptions,
  type MarketSettingsDocument,
} from '../src/catalog/source-store.js'
import type { CatalogSourceManifest, LocalSourceRecord } from '../src/contracts/index.js'

const manifest = JSON.parse(
  readFileSync(new URL('../docs/examples/catalog-source.example.json', import.meta.url), 'utf8'),
) as CatalogSourceManifest

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'user-added',
  adapterId: 'market.standard-http-v1',
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  manifest,
  enabled: true,
  order: 0,
}

const companySource: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120009',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: false,
  order: 0,
}

describe('settings-backed catalog source store', () => {
  it('persists validated source records through the settings scope', async () => {
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope)

    await store.save([source])

    expect(update).toHaveBeenCalledWith({ sources: [source] })
    await expect(store.load()).resolves.toEqual([source])
  })

  it('normalizes legacy multi-enabled settings to one selected source', async () => {
    const secondSource: LocalSourceRecord = {
      ...source,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    }
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope)

    await store.save([source, secondSource])

    expect(update).toHaveBeenCalledWith({
      sources: [source, { ...secondSource, enabled: false }],
    })
    await expect(store.load()).resolves.toEqual([
      source,
      { ...secondSource, enabled: false },
    ])
  })
})

describe('locked catalog source store', () => {
  it('forces load() to return only the enabled company source, ignoring stored settings', async () => {
    let document: MarketSettingsDocument = { sources: [source] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const lock: CatalogSourceLockOptions = { locked: true, companySource }
    const store = new SettingsCatalogSourceStore(scope, lock)

    await expect(store.load()).resolves.toEqual([{ ...companySource, enabled: true }])
    expect(update).not.toHaveBeenCalled()
    expect(document).toEqual({ sources: [source] })
  })

  it('rejects save() with a clear error and never touches the settings scope', async () => {
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope, { locked: true, companySource })

    await expect(store.save([source])).rejects.toThrowError(MarketSourceLockError)
    await expect(store.save([source])).rejects.toThrowError('market catalog sources are locked by deployment policy')
    expect(update).not.toHaveBeenCalled()
    expect(document).toEqual({ sources: [] })
  })

  it('keeps the current save/load behavior when the lock is explicitly disabled', async () => {
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope, { locked: false, companySource })

    await store.save([source])

    expect(update).toHaveBeenCalledWith({ sources: [source] })
    await expect(store.load()).resolves.toEqual([source])
  })
})
