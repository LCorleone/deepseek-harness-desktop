/**
 * Electron Builder `beforePack` hook staging the wheel set the shared
 * desktop Python environment preinstalls from (issue #043, decision D2).
 *
 * The hook stages the locked wheels at `build/python-wheels` before
 * `extraResources` are copied, so they land beside `app.asar` as
 * `resources/python-wheels` together with the lockfile the runtime reads —
 * the first shared-environment provisioning installs the set locally
 * (`--no-index` over the verified wheel files), so no runtime network is
 * ever touched.
 * Packaging for any other platform stages no wheels at all: the shared
 * environment is Windows-only, and the `extraResources` mapping tolerates
 * the absent staging directory there — exactly like the embeddable CPython
 * tree.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBundledPythonWheels } from './bundled-python-wheels.ts'

/** Stable `builder-util` architecture values Electron Builder passes to hooks. */
const BUILDER_ARCHITECTURES = new Map([
  [1, 'x64'],
  [3, 'arm64'],
  [4, 'universal'],
])

/** Fields of the beforePack context this hook consumes. */
export interface BundledPythonWheelsPackContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture enum value. */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
}

/** Resolve the desktop package root containing `build/python-wheels`. */
function desktopRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Stage the pinned wheel set for the application being packed.
 * @param context - Electron Builder's beforePack context.
 * @returns A promise resolving once `build/python-wheels` holds the set.
 */
export async function beforePack(context: BundledPythonWheelsPackContext): Promise<void> {
  if (context.electronPlatformName !== 'win32') {
    console.log(
      `dsh-plugin-desktop: skipping the bundled Python wheel set on ${context.electronPlatformName}`,
    )
    return
  }
  const architecture = context.arch === undefined
    ? 'x64'
    : BUILDER_ARCHITECTURES.get(context.arch)
  if (architecture === undefined) {
    throw new Error(`dsh-plugin-desktop: bundled Python wheel hook received unknown architecture ${String(context.arch)}`)
  }
  await prepareBundledPythonWheels({
    desktopRoot: desktopRoot(),
    log: message => console.log(message),
  })
}

export default beforePack
