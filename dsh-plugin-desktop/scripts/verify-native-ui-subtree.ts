/**
 * File-origin subtree guard for the built native-ui documents (#53).
 *
 * Chromium treats one `file://` document's origin as its own directory and
 * everything below it. A document that references `../sibling/…` therefore
 * loads that subresource from a DIFFERENT file origin, and ES modules are
 * refused outright by the file:// CORS rules unless the app binary was
 * fused with `GrantFileProtocolExtraPrivileges`. The desktop release fuse
 * set keeps that privilege OFF (it would also hand every file:// page full
 * XHR reach — see `electronFuses` in package.json), while the dev binary
 * ships with it ON — which is exactly why the agent-browser window booted
 * under xvfb and died only on real installs: its document nested one
 * directory deeper than the others and referenced `../assets/*`, the
 * module script was refused as cross-origin, the renderer never started,
 * and the window host timed out with "guest webContents didn't attach".
 *
 * The sso-gate window never hit this because its document sits in the
 * native-ui root next to `assets/`. This module is the machine gate that
 * keeps EVERY native-ui document — present and future — inside its own
 * file-origin subtree: a `../` hop in any script `src` or link `href` of a
 * built html is a build failure, not a field report. It runs from the vite
 * build's `closeBundle` hook (vite.native-ui.config.ts) and is asserted by
 * tests/native-ui-file-origin.spec.ts.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** One resource reference that escapes its document's file-origin subtree. */
export interface NativeUiOriginEscape {
  /** Absolute path of the referencing html document. */
  readonly html: string
  /** The literal `src`/`href` attribute value as built. */
  readonly reference: string
  /** Absolute path the reference resolves to — outside the document tree. */
  readonly resolved: string
}

/** Attribute surfaces the guard inspects: every script src and link href. */
const RESOURCE_REFERENCE_PATTERNS = [
  /<script\b[^>]*?\ssrc=(["'])([^"']*)\1[^>]*>/giu,
  /<link\b[^>]*?\shref=(["'])([^"']*)\1[^>]*>/giu,
] as const

/** Whether one attribute value is a filesystem hop rather than a remote URL or fragment. */
function isLocalReference(reference: string): boolean {
  return reference !== ''
    && !/^[a-z][a-z0-9+.-]*:/iu.test(reference)
    && !reference.startsWith('#')
}

/** Whether `target` sits outside `directory` or its subtree. */
function escapesDirectory(directory: string, target: string): boolean {
  const distance = relative(directory, target)
  if (isAbsolute(distance)) return true
  return distance.split(/[\\/]/u)[0] === '..'
}

/**
 * Collect every script/link reference of one html document that resolves
 * outside the document's own directory.
 */
export function nativeUiOriginEscapes(htmlPath: string, html: string): NativeUiOriginEscape[] {
  const directory = dirname(htmlPath)
  const escapes: NativeUiOriginEscape[] = []
  for (const pattern of RESOURCE_REFERENCE_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const reference = match[2] ?? ''
      if (!isLocalReference(reference)) continue
      const resolved = resolve(directory, reference)
      if (escapesDirectory(directory, resolved)) {
        escapes.push({ html: htmlPath, reference, resolved })
      }
    }
  }
  return escapes
}

/** Every `.html` file under one root, in deterministic (sorted) walk order. */
function walkHtmlFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkHtmlFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path)
  }
  return files.sort()
}

/**
 * Walk one built native-ui tree and collect every file-origin escape. A
 * missing root is an error, not an empty result: the caller promised built
 * artifacts.
 */
export function collectNativeUiOriginEscapes(root: string): NativeUiOriginEscape[] {
  const escapes: NativeUiOriginEscape[] = []
  for (const htmlPath of walkHtmlFiles(root)) {
    escapes.push(...nativeUiOriginEscapes(htmlPath, readFileSync(htmlPath, 'utf8')))
  }
  return escapes
}

/** Human-readable, one-line-per-escape failure message for a non-empty list. */
export function nativeUiOriginEscapeMessage(escapes: readonly NativeUiOriginEscape[]): string {
  const lines = escapes.map(escape =>
    `${relative(process.cwd(), escape.html)}: "${escape.reference}" resolves to ${escape.resolved}, outside its document's directory`)
  return [
    'native-ui documents must keep every script/link reference inside their own directory (the Chromium file:// origin subtree, #53):',
    ...lines,
  ].join('\n')
}
