/**
 * Electron Builder `beforePack` hook staging every runtime the application
 * bundles beside its archive.
 *
 * Electron Builder resolves a single hook module per event, so this composer
 * sequences the per-runtime staging hooks: the pinned Node command every
 * platform ships, then the Windows embeddable CPython tree, then the wheel
 * set that tree's shared environment preinstalls from. Each staged
 * directory has its own `extraResources` mapping; the runtime trees rewrite
 * their own digest manifests under `lib/` before Electron Builder collects
 * `lib/**` into the application archive (the wheel set deliberately writes
 * no digest — see `bundled-python-wheels.ts` for why it is a build input,
 * not a runtime integrity surface).
 */

import { beforePack as stageBundledNode, type BundledNodePackContext } from './prepare-bundled-node.ts'
import { beforePack as stageBundledPython } from './prepare-bundled-python.ts'
import { beforePack as stageBundledPythonWheels } from './prepare-bundled-python-wheels.ts'

export type BundledRuntimesPackContext = BundledNodePackContext

/**
 * Stage every bundled runtime for the application being packed.
 * @param context - Electron Builder's beforePack context.
 * @returns A promise resolving once every staging directory is ready.
 */
export async function beforePack(context: BundledRuntimesPackContext): Promise<void> {
  await stageBundledNode(context)
  await stageBundledPython(context)
  await stageBundledPythonWheels(context)
}

export default beforePack
