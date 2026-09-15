import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  desktopLogTimestamp,
  ElectronStderrLogger,
  installDesktopChildProcessLogging,
  installDesktopUncaughtExceptionLogging,
} from '../src/desktop-logger.ts'
import { LogFileSink } from '../src/log-files.ts'

function todaySuffix(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function sink(): { s: LogFileSink; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  return { s: new LogFileSink(dir, { maxFileBytes: 1e6, maxDirectoryBytes: 1e7 }), dir }
}

/** The compact ISO-8601 local stamp every desktop log line is prefixed with (#042). */
const ISO_PREFIX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})\] /u

describe('ElectronStderrLogger', () => {
  it('logs Electron child process crashes with the Windows exception code', () => {
    const app = new EventEmitter()
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const remove = installDesktopChildProcessLogging(app, logger)

    app.emit('child-process-gone', {}, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: -1073741819,
      serviceName: 'network.mojom.NetworkService',
      name: 'Network Service',
    })

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: child process gone (type: Utility, name: Network Service, service: network.mojom.NetworkService, reason: crashed, exitCode: -1073741819 / 0xc0000005)',
    )
    remove()
    expect(app.listenerCount('child-process-gone')).toBe(0)
  })

  it('writes to the sink and to stderr', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)
    logger.error('boom')
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toContain('boom')
  })

  it('renders an unknown cause as a string', () => {
    const { s } = sink()
    const logger = new ElectronStderrLogger(s)
    expect(() => logger.errorCause({ code: 42 })).not.toThrow()
  })

  it('uses the error stack for Error causes', () => {
    const { s, dir } = sink()
    const logger = new ElectronStderrLogger(s)
    logger.errorCause(new Error('crash here'))
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toContain('crash here')
  })

  it('masks secrets in the file and stderr outputs', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    logger.error('request failed with Bearer abc.def.secret')

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('Bearer ****')
    expect(text).not.toContain('abc.def.secret')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})\] request failed with Bearer \*\*\*\*\n$/u))
    stderrSpy.mockRestore()
  })

  it('prefixes every desktop log line with a compact ISO timestamp (#042)', () => {
    // The prefix format itself: bracketed local ISO-8601 with milliseconds
    // and a numeric offset, which parses back to the exact instant — the
    // per-line time the fleet measurement blind spot (lucy.log) lacked.
    const instant = 1_789_431_000_123
    const stamp = desktopLogTimestamp(new Date(instant))
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/u)
    expect(new Date(stamp).getTime()).toBe(instant)

    // Both surfaces carry it: the persistent file sink and the stderr mirror.
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)
    logger.error('dsh-plugin-desktop: boot line without its own timestamp')
    logger.write('dsh-plugin-desktop: fail-loud chunk\n')

    const day = todaySuffix()
    for (const line of readFileSync(join(dir, `dsh-${day}.log`), 'utf8').trimEnd().split('\n')) {
      expect(line).toMatch(ISO_PREFIX)
    }
    expect(stderrSpy.mock.calls[0]?.[0]).toMatch(ISO_PREFIX)
    expect(stderrSpy.mock.calls[1]?.[0]).toMatch(ISO_PREFIX)
    stderrSpy.mockRestore()
  })

  it('accepts fail-loud stderr chunks without adding a second newline', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    logger.write('dsh-plugin-desktop: fatal load failure: Bearer abc.def.secret\n')

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('fatal load failure: Bearer ****\n')
    expect(text).not.toContain('abc.def.secret')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})\] dsh-plugin-desktop: fatal load failure: Bearer \*\*\*\*\n$/u))
    stderrSpy.mockRestore()
  })

  it('logs the first uncaught exception and requests a fatal exit', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)
    const proc = new EventEmitter()
    const exit = vi.fn()

    const remove = installDesktopUncaughtExceptionLogging(proc, logger, exit)
    proc.emit('uncaughtException', new Error('fatal Bearer abc.def.secret'))
    proc.emit('uncaughtException', new Error('second failure'))

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('fatal Bearer ****')
    expect(text).not.toContain('abc.def.secret')
    expect(text).not.toContain('second failure')
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    remove()
    stderrSpy.mockRestore()
  })

  it('falls back to masked stderr when the file sink fails', () => {
    const { s } = sink()
    vi.spyOn(s, 'write').mockImplementation(() => { throw new Error('disk full') })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    expect(() => { logger.error('failed with Bearer abc.def.secret') }).not.toThrow()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})\] failed with Bearer \*\*\*\*\n$/u))
    stderrSpy.mockRestore()
  })
})
