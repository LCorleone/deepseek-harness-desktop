/**
 * Electron Builder `beforePack` hook staging the bundled Node runtime.
 *
 * The hook runs before `extraResources` are copied, so the staged command at
 * `build/node-runtime` lands beside `app.asar` as `resources/node-runtime`.
 * The same run writes `lib/node-runtime-sha256.json` — the digest manifest the
 * packaged runtime verifies the bundled command against — before Electron
 * Builder collects `lib/**` into the application archive. A universal macOS
 * build packs one temporary application per architecture; each pass stages its
 * own architecture at the same path and `@electron/universal`
 * merges the two Node commands with `lipo` into a universal binary.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBundledNode } from './bundled-node.ts'

/** Stable `builder-util` architecture values Electron Builder passes to hooks. */
const BUILDER_ARCHITECTURES = new Map([
  [1, 'x64'],
  [3, 'arm64'],
  [4, 'universal'],
])

/** Fields of the beforePack context this hook consumes. */
export interface BundledNodePackContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture enum value. */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
}

/** Resolve the packaging architecture the bundled Node must match. */
export function bundledNodeArchitecture(context: BundledNodePackContext, hostArch = process.arch): string {
  if (context.arch === undefined) return hostArch
  const architecture = BUILDER_ARCHITECTURES.get(context.arch)
  if (architecture === undefined) {
    throw new Error(`dsh-plugin-desktop: bundled Node hook received unknown architecture ${String(context.arch)}`)
  }
  // The universal pipeline packs concrete x64 and arm64 applications before
  // merging; a universal value here still stages the host architecture.
  return architecture === 'universal' ? hostArch : architecture
}

/** Resolve the desktop package root containing `build/node-runtime`. */
function desktopRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Stage the pinned Node command for the application being packed.
 * @param context - Electron Builder's beforePack context.
 * @returns A promise resolving once `build/node-runtime` holds the command.
 */
export async function beforePack(context: BundledNodePackContext): Promise<void> {
  await prepareBundledNode({
    desktopRoot: desktopRoot(),
    platform: context.electronPlatformName as NodeJS.Platform,
    arch: bundledNodeArchitecture(context),
    log: message => console.log(message),
  })
}

export default beforePack
