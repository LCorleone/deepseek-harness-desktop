/** Resolution of the Node command bundled beside the packaged application. */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unpackedAsarPath } from './packaged-runtime-path.ts'

/** Directory extraResources places the pinned Node distribution into. */
const BUNDLED_NODE_DIRECTORY = 'node-runtime'

/** Return the command name the bundled Node distribution installs as. */
export function bundledNodeCommandName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

/** Inputs controlling one Node-command resolution. */
export interface DesktopNodeRuntimeInputs {
  /** Host platform selecting the packaged command name and PATH dialect. */
  readonly platform: NodeJS.Platform
  /** Environment whose PATH is searched in the unpackaged development state. */
  readonly environment?: NodeJS.ProcessEnv
  /** Regular-file probe; production uses `statSync`. */
  readonly exists?: (filename: string) => boolean
}

function isRegularFile(filename: string): boolean {
  try {
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

/** Read PATH with Windows-compatible environment-name matching. */
function inheritedPathValue(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return environment.PATH ?? ''
  return Object.entries(environment)
    .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

/**
 * Resolve the Node command bundled beside this module's packaged tree.
 *
 * A packaged module lives at `<resources>/app.asar.unpacked/lib/<name>.js`, so
 * the physical bundle is `<resources>/node-runtime/<command>`; in an unpackaged
 * checkout the same computation points at a directory that does not exist and
 * callers fall back to the development PATH lookup below.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @param platform - host platform selecting the packaged command name.
 * @returns the bundled Node command path for this application layout.
 */
export function packagedBundledNodePath(moduleUrl: string, platform: NodeJS.Platform): string {
  const moduleDirectory = dirname(unpackedAsarPath(fileURLToPath(moduleUrl)))
  return join(
    dirname(dirname(moduleDirectory)),
    BUNDLED_NODE_DIRECTORY,
    bundledNodeCommandName(platform),
  )
}

/** Find one command name on PATH without trusting a command interpreter. */
function commandOnPath(
  command: string,
  inputs: DesktopNodeRuntimeInputs,
  exists: (filename: string) => boolean,
): string | undefined {
  const environment = inputs.environment ?? process.env
  const delimiter = inputs.platform === 'win32' ? ';' : ':'
  for (const rawDirectory of inheritedPathValue(environment, inputs.platform).split(delimiter)) {
    const directory = inputs.platform === 'win32'
      && rawDirectory.startsWith('"')
      && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory
    if (directory.length === 0) continue
    const candidate = join(directory, command)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the Node command this application runs package-manager and CLI
 * children with.
 *
 * The packaged application always uses the Node distribution bundled under
 * `resources/node-runtime`; an unpackaged development checkout instead reuses
 * the Node command its environment already provides, matching the dual-state
 * resolution `packaged-runtime-path.ts` applies to packaged dependencies.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @param inputs - platform, environment, and file-probe seams.
 * @returns an absolute Node command path; never a PATH-resolved bare name.
 */
export function resolveDesktopNodeExecutable(
  moduleUrl: string,
  inputs: DesktopNodeRuntimeInputs,
): string {
  const exists = inputs.exists ?? isRegularFile
  const packaged = packagedBundledNodePath(moduleUrl, inputs.platform)
  if (exists(packaged)) return packaged
  const development = commandOnPath(bundledNodeCommandName(inputs.platform), inputs, exists)
  if (development !== undefined) return development
  throw new Error(
    'dsh-plugin-desktop: no Node command is available; packaged applications bundle one under '
    + `resources/${BUNDLED_NODE_DIRECTORY}, and an unpackaged development run needs node on PATH`,
  )
}
