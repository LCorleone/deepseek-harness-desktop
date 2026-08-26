import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureProfilePnpmBuildApproval } from '../src/profile-pnpm-policy.ts'

/** The upstream profile template base, byte-for-byte (61 bytes on disk). */
const UPSTREAM_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** A fresh temp root whose profile directory may carry a pre-seeded workspace. */
function profileRoot(workspace?: string): { root: string, dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-policy-'))
  const dir = join(root, 'profiles', 'desktop')
  if (workspace !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  }
  return { root, dir }
}

describe('profile pnpm build approval policy', () => {
  it('creates the upstream template plus the approved build list when the workspace is missing', () => {
    const { root, dir } = profileRoot()

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:
  - node-pty
  - esbuild
  - protobufjs
`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('appends the approved build list to an existing workspace without the key', () => {
    const { root, dir } = profileRoot(
      'packages:\n  - .\ncatalog: https://registry.npmjs.org/\nnodeLinker: hoisted',
    )

    try {
      ensureProfilePnpmBuildApproval(dir)

      // Every pre-existing key survives byte-for-byte, including the missing
      // trailing newline, and the block lands after them as a top-level key.
      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        'packages:\n  - .\ncatalog: https://registry.npmjs.org/\nnodeLinker: hoisted'
        + '\n\nonlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges missing entries into an existing block and dedupes approved ones', () => {
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - user-native-dep\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - user-native-dep\n  - esbuild\n  - protobufjs\n`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fills an empty onlyBuiltDependencies key with the approved entries', () => {
    const { root, dir } = profileRoot(`${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n`)

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs\n`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('expands a flow-style inline list into the merged block form', () => {
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}onlyBuiltDependencies: [esbuild, "user-native-dep"]\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - esbuild\n  - user-native-dep\n  - node-pty\n  - protobufjs\n`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second run leaves the file untouched', () => {
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - user-native-dep\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir)
      const approved = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      const writtenAt = statSync(join(dir, 'pnpm-workspace.yaml')).mtimeMs

      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(approved)
      // Not even rewritten: an already-approved workspace keeps its mtime.
      expect(statSync(join(dir, 'pnpm-workspace.yaml')).mtimeMs).toBe(writtenAt)
      expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
