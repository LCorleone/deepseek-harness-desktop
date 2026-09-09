/**
 * Electron Builder `beforePack` hook staging every runtime the application
 * bundles beside its archive.
 *
 * Electron Builder resolves a single hook module per event, so this composer
 * sequences the per-runtime staging hooks: the pinned Node command every
 * platform ships, then the Windows embeddable CPython tree. Each staged
 * directory has its own `extraResources` mapping, and each staging run
 * rewrites its own digest manifest under `lib/` before Electron Builder
 * collects `lib/**` into the application archive.
 */

import { beforePack as stageBundledNode, type BundledNodePackContext } from './prepare-bundled-node.ts'
import { beforePack as stageBundledPython } from './prepare-bundled-python.ts'

export type BundledRuntimesPackContext = BundledNodePackContext

/**
 * Stage every bundled runtime for the application being packed.
 * @param context - Electron Builder's beforePack context.
 * @returns A promise resolving once every staging directory is ready.
 */
export async function beforePack(context: BundledRuntimesPackContext): Promise<void> {
  await stageBundledNode(context)
  await stageBundledPython(context)
}

export default beforePack
