/**
 * A real, local {@link ScriptSpawn} for the executor's integration tests.
 *
 * The executor's seam is the production subprocess contract; to exercise it
 * end to end without pulling the desktop's process runtime into this package's
 * dev graph, this helper implements the tiny slice the executor uses —
 * `stdio.stdin: { data }`, bounded tail-keep collection on stdout/stderr, and
 * `done` resolving at close — directly on `node:child_process`. The script
 * still runs in a real `node -` process over a real stdin pipe, so a body that
 * was written to disk or never piped would fail these tests.
 *
 * @module dsh-company-skills/tests/local-spawn
 */

import { spawn } from 'node:child_process'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputMode, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

interface Collector {
  readonly maxBytes: number
  readonly chunks: Buffer[]
  bytes: number
  dropped: boolean
}

function collectorOf(mode: SubprocessOutputMode): Collector | undefined {
  if (typeof mode !== 'object') return undefined
  return { maxBytes: (mode as SubprocessCollect).maxBytes, chunks: [], bytes: 0, dropped: false }
}

/** Tail-keep insertion: drop whole head chunks until the retained window fits the cap. */
function push(collector: Collector, chunk: Buffer): void {
  collector.chunks.push(chunk)
  collector.bytes += chunk.length
  while (collector.bytes > collector.maxBytes) {
    const head = collector.chunks[0] as Buffer
    const excess = collector.bytes - collector.maxBytes
    if (head.length <= excess) {
      collector.chunks.shift()
      collector.bytes -= head.length
    } else {
      collector.chunks[0] = head.subarray(excess)
      collector.bytes -= excess
    }
    collector.dropped = true
  }
}

function reader(collector: Collector | undefined): SubprocessHandle['collected']['stdout'] {
  if (collector === undefined) return undefined
  return {
    readFrom: () => ({
      text: Buffer.concat(collector.chunks).toString('utf8'),
      nextOffset: collector.bytes,
      lossy: collector.dropped,
    }),
  }
}

/**
 * Spawn one real child through the subprocess contract's shape.
 * @param spec - the fully specified spawn request the executor built.
 * @returns a handle whose `done` resolves at close with real exit facts.
 */
export function localSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const [program, ...args] = spec.argv
  const child = spawn(program as string, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [
      spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
      typeof spec.stdio.stdout === 'object' ? 'pipe' : spec.stdio.stdout,
      typeof spec.stdio.stderr === 'object' ? 'pipe' : spec.stdio.stderr,
    ],
  })

  const stdout = collectorOf(spec.stdio.stdout)
  const stderr = collectorOf(spec.stdio.stderr)
  child.stdout?.on('data', (chunk: Buffer) => { if (stdout !== undefined) push(stdout, chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr !== undefined) push(stderr, chunk) })

  if (typeof spec.stdio.stdin === 'object') child.stdin?.end(spec.stdio.stdin.data)
  else child.stdin?.end()

  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ exitCode: code, signal }))
  })

  return {
    pid: child.pid ?? -1,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    collected: {
      ...(reader(stdout) === undefined ? {} : { stdout: reader(stdout) as NonNullable<SubprocessHandle['collected']['stdout']> }),
      ...(reader(stderr) === undefined ? {} : { stderr: reader(stderr) as NonNullable<SubprocessHandle['collected']['stderr']> }),
    },
    done,
    terminate: () => { child.kill('SIGKILL') },
    waitForExit: async (signal?: AbortSignal) => {
      if (signal === undefined) {
        await done.catch(() => {})
        return true
      }
      if (signal.aborted) return false
      return Promise.race([
        done.then(() => true, () => true),
        new Promise<boolean>((resolve) => { signal.addEventListener('abort', () => resolve(false), { once: true }) }),
      ])
    },
  }
}
