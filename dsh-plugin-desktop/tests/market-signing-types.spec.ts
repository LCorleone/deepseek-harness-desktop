import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as real from 'dsh-community-market'

/**
 * Drift guard for the type-only facade `src/market-signing-types.ts`: tsconfig
 * maps the `dsh-community-market` specifier to that facade for typechecking
 * only, while the test runtime resolves the real package — so every runtime
 * member the facade declares must exist on the real export face with the
 * right kind. Type members are compile-time only and stay covered by the
 * typecheck itself.
 */
const facadeSource = readFileSync(new URL('../src/market-signing-types.ts', import.meta.url), 'utf8')
const declaredRuntimeMembers = [...facadeSource.matchAll(/export declare function (\w+)/gu)]
  .map(match => match[1]!)

describe('market signing type facade runtime parity', () => {
  it('declares exactly the known runtime surface', () => {
    expect(declaredRuntimeMembers).toEqual([
      'canonicalJsonText',
      'findCompanyManifestPackage',
      'ed25519PublicKeyFingerprint',
      'createCompanyManifestSignature',
      'verifyCompanyManifest',
      'createCompanyCatalogProvider',
    ])
  })

  it.each(declaredRuntimeMembers)('exports %s as a function on the real package', name => {
    expect(typeof (real as Record<string, unknown>)[name]).toBe('function')
  })

  it('does not declare runtime constants or classes the facade never promised', () => {
    expect(facadeSource).not.toMatch(/export (const|let|var|class|declare const|declare class) /u)
  })
})
