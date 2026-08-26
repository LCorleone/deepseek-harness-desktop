import { describe, expect, it } from 'vitest'
import { manualInstallHint } from '../src/install/manual.js'

const base = {
  id: 'example/plugin',
  name: 'Example Plugin',
  displayName: 'Example Plugin',
  summary: 'Example plugin',
  repository: { url: 'https://github.com/example/plugin', subdirectory: 'packages/plugin' },
  installSource: {
    kind: 'github' as const,
    commit: '0123456789abcdef0123456789abcdef01234567',
  },
  provenance: {
    sourceRecordId: 'source-1',
    providerId: 'provider.example',
    itemId: 'example/plugin',
  },
}

describe('manual install hints', () => {
  it('renders pinned GitHub sources as non-executable display commands', () => {
    expect(manualInstallHint(base)).toMatchObject({
      kind: 'github',
      mutable: false,
      desktopVerification: 'not-verified',
      reason: 'build-policy-unverified',
      displayCommand: 'dsh plugin add github:example/plugin#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin',
    })
  })

  it('provides an unpinned npm terminal command when no reviewed exact version exists', () => {
    const { installSource: _installSource, ...npmBase } = base
    expect(manualInstallHint({
      ...npmBase,
      package: { registry: 'npm', name: 'dsh-plugin-example' },
      installPolicy: { mode: 'manual', reason: 'build-policy-unverified' },
    })).toMatchObject({
      kind: 'npm',
      mutable: true,
      reason: 'build-policy-unverified',
      displayCommand: 'dsh plugin add dsh-plugin-example',
    })
  })

  it('preserves an exact command and build-approval reason from reviewed metadata', () => {
    const { installSource: _installSource, ...npmBase } = base
    expect(manualInstallHint({
      ...npmBase,
      package: { registry: 'npm', name: 'dsh-plugin-example' },
      latestVersion: '2.3.4',
      installPolicy: { mode: 'manual', reason: 'build-approval-required' },
    })).toMatchObject({
      kind: 'npm',
      mutable: false,
      reason: 'build-approval-required',
      displayCommand: 'dsh plugin add --save-exact dsh-plugin-example@2.3.4',
    })
  })

  it('does not expose malformed pinned sources', () => {
    expect(manualInstallHint({
      ...base,
      installSource: { kind: 'github', commit: 'not-a-commit' },
    })).toBeUndefined()
  })
})
