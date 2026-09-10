/**
 * Locate a real Python interpreter for the integration tests.
 *
 * The production resolver prefers the desktop-published absolute command and
 * then the bare family name (`python`) on `PATH`. A CI runner commonly ships
 * only `python3`, so a test that relies on the bare name is red on an
 * otherwise healthy machine. These tests instead resolve an absolute
 * interpreter once and inject it through `DSH_DESKTOP_PYTHON_EXECUTABLE`, and
 * skip when the machine has no Python at all.
 *
 * @module dsh-company-skills/tests/python
 */

import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { DESKTOP_PYTHON_EXECUTABLE_ENV } from '../src/execute.js'

/** Interpreters to try, in preference order, for this platform. */
const CANDIDATE_NAMES: readonly string[] = process.platform === 'win32'
  ? ['python.exe', 'python3.exe']
  : ['python3', 'python']

/**
 * The first real Python interpreter on `PATH`, as an absolute path.
 * @returns the interpreter path, or `undefined` when the machine has none.
 */
export function findPythonInterpreter(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(directory, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not this candidate; keep searching the remaining PATH entries.
      }
    }
  }
  return undefined
}

/** The absolute Python interpreter every Python integration case injects. */
export const pythonInterpreter = findPythonInterpreter()

/**
 * Interpreter-resolution seam that resolves Python to {@link pythonInterpreter}
 * instead of whatever the bare `python` name happens to be. `undefined` when
 * the machine has no Python (the callers `skipIf` on that).
 */
export const pythonResolution = pythonInterpreter === undefined
  ? undefined
  : { environment: { ...process.env, [DESKTOP_PYTHON_EXECUTABLE_ENV]: pythonInterpreter }, exists: () => true }
