import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_INSTALL_RECOVERY_FILES,
  DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
} from '../src/install-recovery.ts'

const roots: string[] = []
const PREINSTALL = {
  'package.json': '{"name":"fixture-private-marker","private":true}\n',
  'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n# lock-private-marker\n',
  'pnpm-workspace.yaml': 'packages:\n  - fixture-private-marker\n',
} as const
const POSTINSTALL = {
  'package.json': '{"name":"fixture-private-marker","private":true,"dependencies":{"plugin-a":"1.0.0"}}\n',
  'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n# installed-plugin-a\n',
  'pnpm-workspace.yaml': 'packages:\n  - fixture-private-marker\n  - installed-plugin-a\n',
} as const

interface Fixture {
  readonly root: string
  readonly profileDir: string
  readonly statePath: string
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-recovery-'))
  roots.push(root)
  return root
}

function fixture(files: readonly (keyof typeof PREINSTALL)[] = DESKTOP_INSTALL_RECOVERY_FILES): Fixture {
  const root = temporaryRoot()
  const profileDir = join(root, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  for (const name of files) writeFileSync(join(profileDir, name), PREINSTALL[name], { mode: 0o640 })
  return {
    root,
    profileDir,
    statePath: desktopInstallRecoveryStatePath(join(root, 'user-data')),
  }
}

function store(target: Fixture, generationId = 'generation-0001'): DesktopInstallRecoveryStore {
  return new DesktopInstallRecoveryStore({
    statePath: target.statePath,
    profileName: 'desktop',
    profileDir: target.profileDir,
    generationId,
    now: () => 1_800_000_000_000,
  })
}

function begin(target: Fixture, generationId = 'generation-0001') {
  return store(target, generationId).begin({
    packageName: 'plugin-a',
    packageVersion: '1.0.0',
    receiptId: 'receipt-0001',
  })
}

function writePostinstall(target: Fixture): void {
  for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
    writeFileSync(join(target.profileDir, name), POSTINSTALL[name], { mode: 0o640 })
  }
}

function expectProfile(target: Fixture, expected: typeof PREINSTALL | typeof POSTINSTALL): void {
  for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
    expect(readFileSync(join(target.profileDir, name), 'utf8')).toBe(expected[name])
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Desktop plugin install recovery state location', () => {
  it('uses the fixed private userData directory and accepts only its absolute terminal hand-off', () => {
    const root = temporaryRoot()
    const userData = join(root, 'user-data')
    const expected = join(userData, 'plugin-install-recovery', 'state.json')
    expect(desktopInstallRecoveryStatePath(userData)).toBe(expected)
    expect(desktopInstallRecoveryStatePath('/ignored', {
      [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: expected,
    })).toBe(expected)
    expect(() => desktopInstallRecoveryStatePath('/ignored', {
      [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: 'plugin-install-recovery/state.json',
    })).toThrow('must be an absolute path')
    expect(() => desktopInstallRecoveryStatePath('/ignored', {
      [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: join(root, 'redirected', 'state.json'),
    })).toThrow('must use the fixed private directory')
  })
})

describe('Desktop plugin install recovery WAL', () => {
  it('publishes hash-only prepared metadata after private allowlisted preimages', async () => {
    const target = fixture()
    const transaction = await begin(target)

    expect(transaction.phase).toBe('prepared')
    expect(transaction.files.map(file => file.name)).toEqual(DESKTOP_INSTALL_RECOVERY_FILES)
    expect(transaction.files.every(file => file.before.present)).toBe(true)
    const stateText = readFileSync(target.statePath, 'utf8')
    expect(stateText).not.toContain('fixture-private-marker')
    expect(stateText).not.toContain('lock-private-marker')
    expect(stateText).not.toContain(target.profileDir)

    const backupDir = join(dirname(target.statePath), 'backups', transaction.transactionId)
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      expect(readFileSync(join(backupDir, `${name}.before`), 'utf8')).toBe(PREINSTALL[name])
    }
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(target.statePath)).mode & 0o777).toBe(0o700)
      expect(lstatSync(dirname(backupDir)).mode & 0o777).toBe(0o700)
      expect(lstatSync(backupDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(target.statePath).mode & 0o777).toBe(0o600)
      for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
        expect(lstatSync(join(backupDir, `${name}.before`)).mode & 0o777).toBe(0o600)
      }
    }
    await expect(begin(target)).rejects.toThrow('another plugin install recovery transaction is pending')
  })

  it('serializes concurrent writers so only one prepare can be published', async () => {
    const target = fixture()
    const input = {
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    }
    const results = await Promise.allSettled([
      store(target).begin(input),
      store(target).begin(input),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await store(target).read())?.phase).toBe('prepared')
  })

  it('seals postimages, lets only the next generation claim verification, and clears healthy state', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)

    const sealed = await origin.seal(prepared.transactionId)
    expect(sealed.phase).toBe('awaiting-restart')
    expect(sealed.files.every(file => file.after?.present === true)).toBe(true)
    await expect(origin.claim()).resolves.toMatchObject({
      action: 'deferred',
      reason: 'origin-generation',
    })

    const restarted = store(target, 'generation-0002')
    const claimed = await restarted.claim()
    expect(claimed).toMatchObject({ action: 'verify' })
    if (claimed.action !== 'verify') throw new Error('expected verification claim')
    expect(claimed.transaction.phase).toBe('verifying')
    expect(claimed.transaction.verifyingGeneration).toBe('generation-0002')

    const verified = await restarted.markHealthy(prepared.transactionId)
    expect(verified.phase).toBe('verified')
    await restarted.clear(prepared.transactionId)
    expect(existsSync(target.statePath)).toBe(false)
    expect(existsSync(join(dirname(target.statePath), 'backups', prepared.transactionId))).toBe(false)
  })

  it('restores a mix of admitted pre- and postimages without overwriting unrelated paths', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)
    writeFileSync(join(target.profileDir, 'package.json'), PREINSTALL['package.json'], { mode: 0o640 })
    writeFileSync(join(target.profileDir, 'unrelated.txt'), 'preserve me\n')

    const restarted = store(target, 'generation-0002')
    await expect(restarted.claim()).resolves.toMatchObject({ action: 'verify' })
    const result = await restarted.restore(prepared.transactionId, 'startup-failed')

    expect(result.status).toBe('restored')
    expectProfile(target, PREINSTALL)
    expect(readFileSync(join(target.profileDir, 'unrelated.txt'), 'utf8')).toBe('preserve me\n')
    expect((await restarted.read())?.phase).toBe('rolled-back')
    await expect(restarted.restore(prepared.transactionId, 'startup-failed')).resolves.toMatchObject({
      status: 'already-restored',
    })
  })

  it('removes allowlisted files that were absent before installation', async () => {
    const target = fixture(['package.json'])
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)

    const restarted = store(target, 'generation-0002')
    await restarted.claim()
    await expect(restarted.restore(prepared.transactionId, 'startup-failed')).resolves.toMatchObject({
      status: 'restored',
    })
    expect(readFileSync(join(target.profileDir, 'package.json'), 'utf8')).toBe(PREINSTALL['package.json'])
    expect(existsSync(join(target.profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(join(target.profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('requires manual recovery on third-party drift and performs no partial rollback', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)
    writeFileSync(join(target.profileDir, 'package.json'), '{"external":"change"}\n', { mode: 0o640 })

    const restarted = store(target, 'generation-0002')
    await restarted.claim()
    const result = await restarted.restore(prepared.transactionId, 'startup-failed')

    expect(result).toMatchObject({
      status: 'manual-recovery-required',
      mismatchedFiles: ['package.json'],
      transaction: { phase: 'manual-recovery-required' },
    })
    expect(readFileSync(join(target.profileDir, 'package.json'), 'utf8')).toBe('{"external":"change"}\n')
    expect(readFileSync(join(target.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(POSTINSTALL['pnpm-lock.yaml'])
    await expect(restarted.clear(prepared.transactionId)).rejects.toThrow('cannot be cleared')
  })

  it('rolls back an untouched interrupted prepare but refuses unknown unsealed writes', async () => {
    const untouched = fixture()
    const untouchedPrepared = await begin(untouched)
    const untouchedRestart = store(untouched, 'generation-0002')
    await expect(untouchedRestart.claim()).resolves.toMatchObject({
      action: 'prompt',
      reason: 'interrupted-install',
      transaction: { phase: 'recovery-pending' },
    })
    await expect(untouchedRestart.restore(untouchedPrepared.transactionId, 'interrupted-install')).resolves.toMatchObject({
      status: 'restored',
    })

    const changed = fixture()
    const changedPrepared = await begin(changed)
    writeFileSync(join(changed.profileDir, 'package.json'), POSTINSTALL['package.json'], { mode: 0o640 })
    const changedRestart = store(changed, 'generation-0002')
    await expect(changedRestart.claim()).resolves.toMatchObject({
      action: 'prompt',
      reason: 'interrupted-install',
      transaction: { phase: 'recovery-pending' },
    })
    await expect(changedRestart.restore(changedPrepared.transactionId, 'interrupted-install')).resolves.toMatchObject({
      status: 'manual-recovery-required',
      mismatchedFiles: ['package.json'],
    })
    expect(readFileSync(join(changed.profileDir, 'package.json'), 'utf8')).toBe(POSTINSTALL['package.json'])
  })

  it('can restore and clear a failed install in its origin generation before any postimage exists', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })

    await expect(origin.restore(prepared.transactionId, 'install-failed')).resolves.toMatchObject({
      status: 'restored',
      transaction: { phase: 'rolled-back', failureReason: 'install-failed' },
    })
    await origin.clear(prepared.transactionId)
    expect(existsSync(target.statePath)).toBe(false)
  })

  it('persists failed verification and consumes at most one retry in the next generation', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)

    const failed = store(target, 'generation-0002')
    await expect(failed.claim()).resolves.toMatchObject({ action: 'verify' })
    await expect(failed.recordFailure(prepared.transactionId, 'renderer-failed')).resolves.toMatchObject({
      phase: 'recovery-pending',
      failureReason: 'renderer-failed',
    })
    await expect(failed.claim()).resolves.toMatchObject({
      action: 'prompt',
      reason: 'startup-unconfirmed',
    })
    await expect(failed.requestRetry(prepared.transactionId)).resolves.toMatchObject({
      phase: 'retry-requested',
      verifyingGeneration: 'generation-0002',
    })
    await expect(failed.claim()).resolves.toMatchObject({
      action: 'deferred',
      reason: 'origin-generation',
    })

    const retry = store(target, 'generation-0003')
    await expect(retry.claim()).resolves.toMatchObject({
      action: 'verify',
      transaction: { phase: 'verifying', verifyingGeneration: 'generation-0003' },
    })
    await retry.recordFailure(prepared.transactionId, 'renderer-timeout')
    await expect(retry.markHealthy(prepared.transactionId)).rejects.toThrow('not verifying')
    await expect(retry.claim()).resolves.toMatchObject({
      action: 'prompt',
      transaction: { phase: 'recovery-pending', failureReason: 'renderer-timeout' },
    })
  })

  it('never downgrades verified or rolled-back terminal transactions to manual recovery', async () => {
    const verifiedTarget = fixture()
    const verifiedOrigin = store(verifiedTarget)
    const verifiedPrepared = await verifiedOrigin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(verifiedTarget)
    await verifiedOrigin.seal(verifiedPrepared.transactionId)
    const verifiedRestart = store(verifiedTarget, 'generation-0002')
    await verifiedRestart.claim()
    await verifiedRestart.markHealthy(verifiedPrepared.transactionId)
    await expect(verifiedRestart.markManualRecoveryRequired(
      verifiedPrepared.transactionId,
      'recovery-failed',
    )).rejects.toThrow('terminal')

    const rolledBackTarget = fixture()
    const rolledBackPrepared = await begin(rolledBackTarget)
    const rolledBackRestart = store(rolledBackTarget, 'generation-0002')
    await rolledBackRestart.claim()
    await rolledBackRestart.restore(rolledBackPrepared.transactionId, 'interrupted-install')
    await expect(rolledBackRestart.markManualRecoveryRequired(
      rolledBackPrepared.transactionId,
      'recovery-failed',
    )).rejects.toThrow('terminal')
  })

  it('persists the post-rollback user notice independently from receipt cleanup', async () => {
    const target = fixture()
    const prepared = await begin(target)
    const restarted = store(target, 'generation-0002')

    await restarted.claim()
    const restored = await restarted.restore(prepared.transactionId, 'interrupted-install')
    expect(restored).toMatchObject({ status: 'restored', transaction: { phase: 'rolled-back' } })
    expect('rollbackNotifiedAt' in restored.transaction).toBe(false)

    const notified = await restarted.markRollbackNotified(prepared.transactionId)
    expect(notified).toMatchObject({
      phase: 'rolled-back',
      rollbackNotifiedAt: '2027-01-15T08:00:00.000Z',
    })
    await expect(restarted.markRollbackNotified(prepared.transactionId)).resolves.toEqual(notified)
    await expect(restarted.claim()).resolves.toMatchObject({
      action: 'terminal',
      transaction: { rollbackNotifiedAt: notified.rollbackNotifiedAt },
    })
    expect(existsSync(target.statePath)).toBe(true)
  })
})

describe('Desktop plugin install recovery consecutive installs', () => {
  it('supersedes one sealed awaiting-restart transaction so the same boot can install again', async () => {
    const target = fixture()
    const origin = store(target)
    const first = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    const sealed = await origin.seal(first.transactionId)
    expect(sealed.phase).toBe('awaiting-restart')

    const second = await store(target).begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })

    expect(second.phase).toBe('prepared')
    expect(second.packageName).toBe('plugin-b')
    expect(second.transactionId).not.toBe(first.transactionId)
    const backups = join(dirname(target.statePath), 'backups')
    // The superseded WAL metadata and its private preimages are both gone.
    expect(existsSync(join(backups, first.transactionId))).toBe(false)
    // The new transaction's preimage is exactly the post-install state of #1.
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      expect(readFileSync(join(backups, second.transactionId, `${name}.before`), 'utf8'))
        .toBe(POSTINSTALL[name])
    }
    const state = await store(target).read()
    expect(state).toMatchObject({ transactionId: second.transactionId, phase: 'prepared' })
  })

  it('clears one terminal-but-unacknowledged transaction, then begins', async () => {
    const verifiedTarget = fixture()
    const verifiedOrigin = store(verifiedTarget)
    const verifiedPrepared = await verifiedOrigin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(verifiedTarget)
    await verifiedOrigin.seal(verifiedPrepared.transactionId)
    const verifiedRestart = store(verifiedTarget, 'generation-0002')
    await verifiedRestart.claim()
    await verifiedRestart.markHealthy(verifiedPrepared.transactionId)
    expect((await verifiedRestart.read())?.phase).toBe('verified')

    const verifiedNext = await verifiedRestart.begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })
    expect(verifiedNext.phase).toBe('prepared')
    const verifiedBackups = join(dirname(verifiedTarget.statePath), 'backups')
    expect(existsSync(join(verifiedBackups, verifiedPrepared.transactionId))).toBe(false)
    expect((await verifiedRestart.read())?.transactionId).toBe(verifiedNext.transactionId)

    const rolledBackTarget = fixture()
    const rolledBackOrigin = store(rolledBackTarget)
    const rolledBackPrepared = await rolledBackOrigin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    await rolledBackOrigin.restore(rolledBackPrepared.transactionId, 'install-failed')
    expect((await rolledBackOrigin.read())?.phase).toBe('rolled-back')

    const rolledBackNext = await rolledBackOrigin.begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })
    expect(rolledBackNext.phase).toBe('prepared')
    const rolledBackBackups = join(dirname(rolledBackTarget.statePath), 'backups')
    expect(existsSync(join(rolledBackBackups, rolledBackPrepared.transactionId))).toBe(false)
  })

  it('still refuses to begin over an in-flight prepared transaction', async () => {
    const target = fixture()
    const first = await begin(target)
    await expect(store(target).begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })).rejects.toThrow('another plugin install recovery transaction is pending')
    expect((await store(target).read())?.transactionId).toBe(first.transactionId)
  })

  it('still refuses to begin over a manual-recovery-required transaction', async () => {
    const target = fixture()
    const prepared = await begin(target)
    writeFileSync(join(target.profileDir, 'package.json'), POSTINSTALL['package.json'], { mode: 0o640 })
    const restarted = store(target, 'generation-0002')
    await restarted.claim()
    const restored = await restarted.restore(prepared.transactionId, 'interrupted-install')
    expect(restored.status).toBe('manual-recovery-required')

    await expect(restarted.begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })).rejects.toThrow('another plugin install recovery transaction is pending')
    expect((await restarted.read())?.transactionId).toBe(prepared.transactionId)
  })

  it('still refuses to begin over another profile\u2019s sealed transaction', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)

    const foreign = new DesktopInstallRecoveryStore({
      statePath: target.statePath,
      profileName: 'second profile',
      profileDir: join(target.root, 'profiles', 'second profile'),
      generationId: 'generation-0001',
    })
    await expect(foreign.begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })).rejects.toThrow('another plugin install recovery transaction is pending')
    expect((await origin.read())?.transactionId).toBe(prepared.transactionId)
  })

  it('rolls a failed follow-up install back to the state the sealed first install produced', async () => {
    const target = fixture()
    const first = await store(target).begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await store(target).seal(first.transactionId)

    const second = await store(target).begin({
      packageName: 'plugin-b',
      packageVersion: '2.0.0',
      receiptId: 'receipt-0002',
    })
    // Install #2 partially writes its own state before failing.
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(target.profileDir, name), `# broken by ${name} from plugin-b\n`, { mode: 0o640 })
    }
    const result = await store(target).restoreCurrentInstall(second.transactionId, 'install-failed')

    expect(result.status).toBe('restored')
    // The rollback lands on the post-install-#1 state, not the pre-#1 state.
    expectProfile(target, POSTINSTALL)
    expect((await store(target).read())?.phase).toBe('rolled-back')
    // A third install can start in the same boot after that rollback.
    const third = await store(target).begin({
      packageName: 'plugin-c',
      packageVersion: '3.0.0',
      receiptId: 'receipt-0003',
    })
    expect(third.phase).toBe('prepared')
  })
})

describe('Desktop plugin install recovery filesystem boundaries', () => {
  it.skipIf(process.platform === 'win32')('rejects symlinked profile files', async () => {
    const linked = fixture([])
    const outside = join(linked.root, 'outside-package.json')
    writeFileSync(outside, PREINSTALL['package.json'])
    symlinkSync(outside, join(linked.profileDir, 'package.json'))
    await expect(begin(linked)).rejects.toThrow('only accepts regular files')
  })

  it('rejects non-regular profile files', async () => {
    const directory = fixture(['package.json'])
    mkdirSync(join(directory.profileDir, 'pnpm-lock.yaml'))
    await expect(begin(directory)).rejects.toThrow('only accepts regular files')
  })

  it('rejects oversized allowlisted files before publishing the WAL', async () => {
    const target = fixture(['package.json'])
    writeFileSync(join(target.profileDir, 'pnpm-workspace.yaml'), Buffer.alloc(1024 * 1024 + 1, 0x61))
    await expect(begin(target)).rejects.toThrow('file is too large')
    expect(existsSync(target.statePath)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked state file', async () => {
    const target = fixture()
    mkdirSync(dirname(target.statePath), { recursive: true })
    const outside = join(target.root, 'outside-state.json')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, target.statePath)
    await expect(store(target).read()).rejects.toThrow('state must be a regular file')
  })

  it('validates every backup before replacing any profile file', async () => {
    const target = fixture()
    const origin = store(target)
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    writePostinstall(target)
    await origin.seal(prepared.transactionId)
    writeFileSync(
      join(dirname(target.statePath), 'backups', prepared.transactionId, 'package.json.before'),
      '{"tampered":true}\n',
    )

    const restarted = store(target, 'generation-0002')
    await restarted.claim()
    await restarted.recordFailure(prepared.transactionId, 'startup-failed')
    await expect(restarted.restore(prepared.transactionId, 'startup-failed')).rejects.toThrow(
      'backup for package.json is invalid',
    )
    expectProfile(target, POSTINSTALL)
    expect((await restarted.read())?.phase).toBe('recovery-pending')
  })
})
