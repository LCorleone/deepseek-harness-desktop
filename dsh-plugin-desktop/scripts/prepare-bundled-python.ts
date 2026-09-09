/**
 * Electron Builder `beforePack` hook staging the bundled Python runtime.
 *
 * The Windows package carries the official embeddable CPython distribution:
 * the hook stages it at `build/python-runtime` before `extraResources` are
 * copied, so it lands beside `app.asar` as `resources/python-runtime`, and
 * writes `lib/python-runtime-sha256.json` — the per-file digest manifest the
 * packaged runtime verifies the bundled tree against — before Electron
 * Builder collects `lib/**` into the application archive. Packaging for any
 * other platform stages no Python at all: the embeddable distribution is
 * Windows-only, and the `extraResources` mapping tolerates the absent
 * staging directory there.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBundledPython } from './bundled-python.ts'

/** Stable `builder-util` architecture values Electron Builder passes to hooks. */
const BUILDER_ARCHITECTURES = new Map([
  [1, 'x64'],
  [3, 'arm64'],
  [4, 'universal'],
])

/** Fields of the beforePack context this hook consumes. */
export interface BundledPythonPackContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture enum value. */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
}

/** Resolve the desktop package root containing `build/python-runtime`. */
function desktopRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Stage the pinned Python tree for the application being packed.
 * @param context - Electron Builder's beforePack context.
 * @returns A promise resolving once `build/python-runtime` holds the tree.
 */
export async function beforePack(context: BundledPythonPackContext): Promise<void> {
  if (context.electronPlatformName !== 'win32') {
    console.log(
      `dsh-plugin-desktop: skipping the bundled Python runtime on ${context.electronPlatformName}`,
    )
    return
  }
  const architecture = context.arch === undefined
    ? 'x64'
    : BUILDER_ARCHITECTURES.get(context.arch)
  if (architecture === undefined) {
    throw new Error(`dsh-plugin-desktop: bundled Python hook received unknown architecture ${String(context.arch)}`)
  }
  await prepareBundledPython({
    desktopRoot: desktopRoot(),
    platform: 'win32',
    arch: architecture,
    log: message => console.log(message),
  })
}

export default beforePack
