import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureProfilePnpmBuildApproval } from '../src/profile-pnpm-policy.ts'

/**
 * Rename failure script shared with the mocked `node:fs`: how many renames
 * still fail, and with which codes (defaults to EPERM — the code the
 * real-machine Windows log showed). `calls` counts every rename attempt.
 */
const renameScript = vi.hoisted(() => ({
  remaining: 0,
  codes: [] as string[],
  calls: 0,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renameScript.calls++
      if (renameScript.remaining > 0) {
        renameScript.remaining--
        const code = renameScript.codes.length > 0 ? renameScript.codes.shift()! : 'EPERM'
        throw Object.assign(
          new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`),
          { code },
        )
      }
      return actual.renameSync(from, to)
    },
  }
})

/** The upstream profile template base, byte-for-byte (61 bytes on disk). */
const UPSTREAM_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** The v11 spelling and transitional setting every approved workspace carries. */
const APPROVAL_TAIL = `allowBuilds:
  node-pty: true
  esbuild: true
  protobufjs: true
strictDepBuilds:
  false
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

afterEach(() => {
  renameScript.remaining = 0
  renameScript.codes = []
  renameScript.calls = 0
})

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
allowBuilds:
  node-pty: true
  esbuild: true
  protobufjs: true
strictDepBuilds:
  false
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
        + '\n\nonlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs'
        + '\n\nallowBuilds:\n  node-pty: true\n  esbuild: true\n  protobufjs: true'
        + '\n\nstrictDepBuilds:\n  false',
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
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - user-native-dep\n  - esbuild\n  - protobufjs\n${APPROVAL_TAIL}`
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
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs\n${APPROVAL_TAIL}`
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
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - esbuild\n  - user-native-dep\n  - node-pty\n  - protobufjs\n${APPROVAL_TAIL}`
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges missing entries into an existing allowBuilds map without corrupting later blocks', () => {
    // The pilot population was guided to hand-edit this file, so a partial
    // allowBuilds map followed by other keys must stay valid YAML.
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}allowBuilds:\n  user-dep: true\nstrictDepBuilds:\n  false\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}allowBuilds:\n  user-dep: true\n  node-pty: true\n  esbuild: true\n  protobufjs: true\nstrictDepBuilds:\n  false\n${'onlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs\n'}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an explicit strictDepBuilds: true from the user', () => {
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}strictDepBuilds:\n  true\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir)

      const content = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      expect(content).toContain('strictDepBuilds:\n  true\n')
      expect(content).not.toContain('strictDepBuilds:\n  false\n')
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

describe('signed approvedBuilds extension', () => {
  it('unions extra approved names after the built-in triple in both spellings', () => {
    const { root, dir } = profileRoot()

    try {
      ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: ['sharp', 'node-pty'] })

      // Built-in triple first (node-pty is not repeated), signed extras after.
      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:
  - node-pty
  - esbuild
  - protobufjs
  - sharp
allowBuilds:
  node-pty: true
  esbuild: true
  protobufjs: true
  sharp: true
strictDepBuilds:
  false
`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('single-quotes scoped dependency names, which YAML reserves as plain-scalar starters', () => {
    const { root, dir } = profileRoot(`${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - esbuild\n`)

    try {
      ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: ['@scope/native-helper'] })

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:\n  - esbuild\n  - node-pty\n  - protobufjs\n  - '@scope/native-helper'\n`
        + 'allowBuilds:\n  node-pty: true\n  esbuild: true\n  protobufjs: true\n  \'@scope/native-helper\': true\nstrictDepBuilds:\n  false\n',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges signed extras into a workspace that already carries them partially', () => {
    const { root, dir } = profileRoot(
      `${UPSTREAM_TEMPLATE}allowBuilds:\n  sharp: true\n`,
    )

    try {
      ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: ['sharp', 'sqlite3'] })

      const content = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      // sharp is deduped against the existing entry; sqlite3 appends after
      // the built-ins the same pass merged in. The seeded file already ends
      // with a newline, so the new blocks splice in without separator lines.
      expect(content).toBe(
        `${UPSTREAM_TEMPLATE}allowBuilds:\n  sharp: true\n  node-pty: true\n  esbuild: true\n  protobufjs: true\n  sqlite3: true\n`
        + 'onlyBuiltDependencies:\n  - node-pty\n  - esbuild\n  - protobufjs\n  - sharp\n  - sqlite3\nstrictDepBuilds:\n  false\n',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the built-in triple untouched when no extras are supplied', () => {
    const { root, dir } = profileRoot()

    try {
      ensureProfilePnpmBuildApproval(dir, {})

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:
  - node-pty
  - esbuild
  - protobufjs
allowBuilds:
  node-pty: true
  esbuild: true
  protobufjs: true
strictDepBuilds:
  false
`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses dependency names outside the npm grammar, staying a pure text policy', () => {
    const { root, dir } = profileRoot()

    try {
      expect(() => ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: ['sharp: false'] }))
        .toThrow(TypeError)
      expect(() => ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: [''] })).toThrow(TypeError)
      expect(() => ensureProfilePnpmBuildApproval(dir, { approvedBuildDependencies: ['Node-Pty'] })).toThrow(TypeError)
      // Nothing was written: a refused list leaves no workspace behind.
      expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('workspace rename commit retries the transient Windows EPERM race', () => {
  // The CLI-side sync writer keeps its own temp+rename commit (the patched
  // dsh-atomic-write writeFileAtomic is async, and this entry point is sync
  // for the CLI bootstrap and the pnpm boundary), so it carries the same
  // bounded retry as the yarn patch. The rename boundary is faked because a
  // real Linux rename as root never produces EPERM.
  it('commits the approved workspace when the first two renames fail EPERM and the third succeeds', () => {
    const { root, dir } = profileRoot()
    renameScript.remaining = 2
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      ensureProfilePnpmBuildApproval(dir)

      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
        `${UPSTREAM_TEMPLATE}onlyBuiltDependencies:
  - node-pty
  - esbuild
  - protobufjs
allowBuilds:
  node-pty: true
  esbuild: true
  protobufjs: true
strictDepBuilds:
  false
`,
      )
      // Initial attempt plus the two recovered retries, then one warn-level
      // summary — stderr, so packaged captures keep the evidence.
      expect(renameScript.calls).toBe(3)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('dsh-plugin-desktop: atomic rename onto')
      expect(warn.mock.calls[0]?.[0]).toContain('succeeded after 2 retries')
      expect(warn.mock.calls[0]?.[0]).toContain('transient EPERM')
      // The committed file replaced the workspace in place: no temp litter.
      expect(readdirSync(dir)).toEqual(['pnpm-workspace.yaml'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
