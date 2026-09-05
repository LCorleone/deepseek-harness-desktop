/**
 * The native-ui file-origin subtree guard (#53), asserted three ways:
 *
 * 1. the pure escape detector flags `../` hops in script src / link href and
 *    accepts same-directory, deeper, and non-filesystem references;
 * 2. the vite build really wires the guard (the closeBundle plugin from
 *    vite.native-ui.config.ts), so regressing the structure fails the build;
 * 3. the built `lib/native-ui` tree — when it exists — has zero escapes.
 *
 * `corepack yarn check` runs build before test, so (3) always executes
 * there; a bare `yarn test` on an unbuilt checkout skips it, which the
 * build-time guard covers instead.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import nativeUiConfig from '../vite.native-ui.config.ts'
import {
  collectNativeUiOriginEscapes,
  nativeUiOriginEscapeMessage,
  nativeUiOriginEscapes,
} from '../scripts/verify-native-ui-subtree.ts'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const builtUiRoot = join(pluginRoot, 'lib', 'native-ui')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Register one temp root for afterEach cleanup and return it. */
function mkdtempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-ui-origin-'))
  roots.push(root)
  return root
}

/** Write one html fixture under a root and return its absolute path. */
function writeHtml(root: string, path: string, html: string): string {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
  return file
}

describe('the native-ui file-origin escape detector', () => {
  it('flags script and link references that hop out of the document directory (#53 shape)', () => {
    // The exact pre-fix agent-browser shape: a nested document referencing
    // ../assets/* — a hop out of its own file:// origin subtree. The fuse is
    // granted now (#54), but the guard still rejects this shape as
    // least-privilege defense-in-depth.
    const root = mkdtempRoot()
    const nestedDocument = [
      '<script type="module" crossorigin src="../assets/agent-browser-omOf5Zul.js"></script>',
      '<link rel="modulepreload" crossorigin href="../assets/globe-DbbSBOpR.js">',
      '<link rel="stylesheet" crossorigin href="../assets/createLucideIcon-C7QK9voD.css">',
    ].join('\n')
    const html = writeHtml(root, join('agent-browser', 'agent-browser.html'), nestedDocument)

    const escapes = nativeUiOriginEscapes(html, nestedDocument)

    expect(escapes).toEqual([
      {
        html,
        reference: '../assets/agent-browser-omOf5Zul.js',
        resolved: join(root, 'assets', 'agent-browser-omOf5Zul.js'),
      },
      {
        html,
        reference: '../assets/globe-DbbSBOpR.js',
        resolved: join(root, 'assets', 'globe-DbbSBOpR.js'),
      },
      {
        html,
        reference: '../assets/createLucideIcon-C7QK9voD.css',
        resolved: join(root, 'assets', 'createLucideIcon-C7QK9voD.css'),
      },
    ])
    // The tree walker reports the same verdict for the on-disk fixture.
    expect(collectNativeUiOriginEscapes(root)).toEqual(escapes)
  })

  it('accepts same-directory and deeper references, remote URLs, and fragments', () => {
    const html = [
      '<script type="module" crossorigin src="./assets/sso-gate-B0XJlPzR.js"></script>',
      '<script type="module" crossorigin src="assets/deep/chunk-Qxz.js"></script>',
      '<link rel="stylesheet" crossorigin href="./assets/sso-gate-D1fJ3k.css">',
      '<link rel="icon" href="https://example.test/favicon.ico">',
      '<link rel="prefetch" href="data:text/plain,noop">',
      '<script>inline scripts carry no src</script>',
    ].join('\n')

    expect(nativeUiOriginEscapes('/ui/sso-gate.html', html)).toEqual([])

    const root = mkdtempRoot()
    writeHtml(root, 'sso-gate.html', html)
    expect(collectNativeUiOriginEscapes(root)).toEqual([])
  })

  it('walks the whole tree and reports every offending document deterministically', () => {
    const root = mkdtempRoot()
    writeHtml(root, join('a', 'one.html'), '<script type="module" src="../x.js"></script>')
    writeHtml(root, join('b', 'deeper', 'two.html'), '<link rel="stylesheet" href="../../y.css">')
    writeHtml(root, 'three.html', '<script type="module" src="./z.js"></script>')

    expect(collectNativeUiOriginEscapes(root)).toEqual([
      {
        html: join(root, 'a', 'one.html'),
        reference: '../x.js',
        resolved: join(root, 'x.js'),
      },
      {
        html: join(root, 'b', 'deeper', 'two.html'),
        reference: '../../y.css',
        resolved: join(root, 'y.css'),
      },
    ])
  })

  it('formats a failure message that names the document, the reference, and the escape', () => {
    const root = mkdtempRoot()
    writeHtml(root, join('nested', 'doc.html'), '<script type="module" src="../assets/app.js"></script>')

    const message = nativeUiOriginEscapeMessage(collectNativeUiOriginEscapes(root))

    expect(message).toContain('file:// origin subtree, #53')
    expect(message).toContain(join('nested', 'doc.html'))
    expect(message).toContain('"../assets/app.js"')
    expect(message).toContain(join(root, 'assets', 'app.js'))
  })
})

describe('the native-ui file-origin build gate', () => {
  it('runs the subtree guard from the vite build (closeBundle plugin)', () => {
    const plugins = (nativeUiConfig as { plugins?: Array<{ name?: string }> }).plugins ?? []
    expect(plugins.map(plugin => plugin.name)).toContain('dsh-native-ui-file-origin-subtree')
  })

  it.skipIf(!existsSync(builtUiRoot))(
    'keeps every built native-ui document inside its own file-origin subtree',
    () => {
      // The judgment call of #53: the artifact shape itself. `yarn check`
      // builds before testing, so this runs against fresh output there; an
      // unbuilt checkout skips it and leans on the build-time guard above.
      expect(collectNativeUiOriginEscapes(builtUiRoot)).toEqual([])
    },
  )
})
