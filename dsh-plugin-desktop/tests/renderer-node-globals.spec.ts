import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type * as ts from 'typescript'

const require = createRequire(import.meta.url)
const compiler = require('typescript') as typeof ts

/**
 * Renderer Node-globals guard (issue #37 class).
 *
 * `src/client/**` and `src/native-ui/**` run inside sandboxed BrowserWindows
 * (`sandbox: true`, `nodeIntegration: false`), so Node globals such as
 * `Buffer` or `process` are simply absent at runtime. The renderer tsconfigs
 * still compile against `@types/node` because the package also builds
 * main-process sources, so neither `tsc` nor Node-based unit tests can catch a
 * stray `Buffer.byteLength` — that exact regression shipped once (#37, fixed
 * by 3b64e5fcaf) and had only been verified by manual grep afterwards.
 *
 * This spec parses every renderer `.ts`/`.tsx` source with the TypeScript
 * parser and fails on any surviving reference to a Node global:
 *
 *  - `Buffer` / `process` / `__dirname` / `__filename` as whole identifiers,
 *  - `require(...)` calls,
 *  - `'node:*'` import specifiers (static and dynamic).
 *
 * Two text views are derived from each file (both preserve length and line
 * breaks, so matches map back to original line numbers):
 *
 *  - `specifiers` — comments blanked. Import specifiers are string literals,
 *    so this view keeps string contents for `from 'node:...'` detection.
 *  - `code` — additionally string-literal interiors, template-literal text
 *    chunks, and JSX text blanked. Identifier references cannot occur there,
 *    so the identifier rules keep matching real code (including template
 *    expressions such as `` `${Buffer ? 1 : 0}` ``) while ignoring UI copy
 *    that merely mentions "Buffer" or "process".
 *
 * Genuinely renderer-safe survivors (for example a property literally named
 * `process`) go into `ALLOWED_OCCURRENCES` with a reason; an empty allowlist
 * is the steady state this guard enforces.
 *
 * Design boundary (declared, not a gap): the scan is lexical over these
 * banned tokens, so aliasing (`const B = Buffer` followed by references to
 * `B`), other Node globals such as `global`/`setImmediate`, dynamic access
 * through `eval`/`new Function`, and import specifiers assembled at runtime
 * are outside its reach — those belong to the bundler/runtime boundary, not
 * a source scan. Matching against `ALLOWED_OCCURRENCES` is line-level snippet
 * containment: an entry suppresses a violation when its snippet appears in
 * the flagged line, not across the file.
 */

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RENDERER_SOURCE_ROOTS = ['src/client', 'src/native-ui'] as const

interface AllowedOccurrence { file: string; snippet: string; reason: string }

/** Reviewed exceptions; every entry must state why it cannot crash the renderer. */
const ALLOWED_OCCURRENCES: readonly AllowedOccurrence[] = []

interface Violation { file: string; line: number; rule: string; snippet: string }

/** Blank `[start, end)` in place, preserving line breaks for line numbering. */
function blankSpans(chars: string[], spans: Array<[number, number]>): void {
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
    }
  }
}

/** Collect comment ranges from the parsed trivia (handles JSX text correctly). */
function collectCommentSpans(sf: ts.SourceFile, text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const visit = (node: ts.Node): void => {
    for (const range of compiler.getLeadingCommentRanges(text, node.pos) ?? []) spans.push([range.pos, range.end])
    for (const range of compiler.getTrailingCommentRanges(text, node.end) ?? []) spans.push([range.pos, range.end])
    compiler.forEachChild(node, visit)
  }
  visit(sf)
  return spans
}

/**
 * Collect interiors of string-like tokens and JSX text (display copy). Template
 * expressions between the text chunks are left intact — they are real code.
 */
function collectLiteralSpans(sf: ts.SourceFile): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const interior = (node: ts.Node, endOffset: number): void => {
    const start = node.getStart(sf)
    spans.push([start + 1, node.end - endOffset])
  }
  const visit = (node: ts.Node): void => {
    if (compiler.isStringLiteral(node) || compiler.isNoSubstitutionTemplateLiteral(node)) interior(node, 1)
    else if (compiler.isTemplateExpression(node)) {
      interior(node.head, 2)
      for (const span of node.templateSpans) interior(span.literal, span.literal.kind === compiler.SyntaxKind.TemplateTail ? 1 : 2)
    } else if (compiler.isJsxText(node)) {
      spans.push([node.getStart(sf), node.end])
    }
    compiler.forEachChild(node, visit)
  }
  visit(sf)
  return spans
}

function parseRendererSource(fileName: string, text: string): ts.SourceFile {
  // The script kind is inferred from the .ts/.tsx extension of the relative path.
  return compiler.createSourceFile(fileName, text, compiler.ScriptTarget.Latest)
}

/** Derive the two scan views described in the file-level comment. */
function strippedViews(fileName: string, text: string): { code: string; specifiers: string } {
  const sf = parseRendererSource(fileName, text)
  const specifiers = [...text]
  blankSpans(specifiers, collectCommentSpans(sf, text))
  const code = [...specifiers.join('')]
  blankSpans(code, collectLiteralSpans(sf))
  return { code: code.join(''), specifiers: specifiers.join('') }
}

const BANNED_PATTERNS: ReadonlyArray<{ id: string; view: 'code' | 'specifiers'; pattern: RegExp }> = [
  { id: 'Buffer', view: 'code', pattern: /\bBuffer\b/ },
  // Whole-word match also covers process.env, process.cwd(), and globalThis.process.
  { id: 'process', view: 'code', pattern: /\bprocess\b/ },
  { id: 'require()', view: 'code', pattern: /\brequire\s*\(/ },
  { id: 'node: import', view: 'specifiers', pattern: /\bfrom\s+['"]node:/ },
  { id: 'node: import', view: 'specifiers', pattern: /\bimport\s*\(\s*['"]node:/ },
  { id: '__dirname/__filename', view: 'code', pattern: /\b__dirname\b|\b__filename\b/ },
]

function scanRendererText(
  file: string,
  text: string,
  allowed: readonly AllowedOccurrence[] = ALLOWED_OCCURRENCES,
): Violation[] {
  const views = strippedViews(file, text)
  const lines = text.split('\n')
  const violations: Violation[] = []
  for (const rule of BANNED_PATTERNS) {
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`)
    for (const match of views[rule.view].matchAll(pattern)) {
      const index = match.index ?? 0
      const line = views[rule.view].slice(0, index).split('\n').length
      const snippet = (lines[line - 1] ?? '').trim().slice(0, 120)
      const whitelisted = allowed.some(entry => entry.file === file && snippet.includes(entry.snippet))
      if (!whitelisted) violations.push({ file, line, rule: rule.id, snippet })
    }
  }
  return violations
}

function listRendererSources(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of RENDERER_SOURCE_ROOTS) walk(join(PLUGIN_ROOT, root))
  return files
}

function formatViolations(violations: Violation[]): string {
  const listed = violations.map(v => `  ${v.file}:${v.line} [${v.rule}] ${v.snippet}`).join('\n')
  return `Renderer sources must not reference Node globals (issue #37 class):\n${listed}\n`
    + 'If an occurrence is provably renderer-safe, add it to ALLOWED_OCCURRENCES with a reason.'
}

describe('renderer Node globals guard', () => {
  describe('comment and literal stripping', () => {
    it('strips line, block, JSDoc, and end-of-file comments while keeping code', () => {
      const text = 'const a = 1 // Buffer note\n/* process */ const b = 2\n/** __dirname */\n\n// eof require(\n'
      const { code } = strippedViews('sample.ts', text)
      expect(code).toContain('const a = 1')
      expect(code).toContain('const b = 2')
      expect(code).not.toContain('Buffer')
      expect(code).not.toContain('process')
      expect(code).not.toContain('__dirname')
      expect(code).not.toContain('require(')
      expect(code.split('\n')).toHaveLength(text.split('\n').length)
    })

    it('keeps string contents in the specifiers view so URL slashes survive', () => {
      const text = "const u = 'https://x//y'\nconst t = `a/*b*/c`\n"
      const { specifiers } = strippedViews('sample.ts', text)
      expect(specifiers).toContain("'https://x//y'")
      expect(specifiers).toContain('`a/*b*/c`')
    })

    it('blanks string and JSX display text in the code view but keeps template expressions', () => {
      const tsx = 'const m = `Buffer ${Buffer ? 1 : 0}`\nconst el = <p>process failed</p>\nconst s = "require("\n'
      const { code } = strippedViews('sample.tsx', tsx)
      expect(code).toContain('Buffer ? 1 : 0')
      expect(code).not.toContain('`Buffer')
      expect(code).not.toContain('process failed')
      expect(code).not.toContain('"require("')
      expect(code).toContain('<p>')
    })

    it('preserves length and line breaks in both views', () => {
      const text = "const a = 'x' // c\nconst b = `t\n${a}` /* m\nn */\n"
      const { code, specifiers } = strippedViews('sample.ts', text)
      for (const view of [code, specifiers]) {
        expect(view).toHaveLength(text.length)
        expect(view.split('\n')).toHaveLength(text.split('\n').length)
      }
    })
  })

  describe('banned pattern detection', () => {
    it('flags every Node-global reference with its line', () => {
      const text = [
        "import { readFileSync } from 'node:fs'",
        'const n = Buffer.byteLength(s)',
        'const env = process.env',
        'const dyn = import("node:path")',
        'const dir = __dirname',
        'const fs = require("fs")',
      ].join('\n')
      const violations = scanRendererText('synthetic.ts', text)
      expect(violations.map(v => [v.rule, v.line] as const).sort((a, b) => a[1] - b[1])).toEqual([
        ['node: import', 1],
        ['Buffer', 2],
        ['process', 3],
        ['node: import', 4],
        ['__dirname/__filename', 5],
        ['require()', 6],
      ])
      expect(violations.find(v => v.rule === 'Buffer')?.snippet).toContain('Buffer.byteLength(s)')
    })

    it('ignores comments, display strings, and JSX copy', () => {
      const tsx = [
        '// Buffer and process only mentioned in a comment',
        "const msg = 'process exited'",
        'const el = <p>Buffer overflow</p>',
        'const safe = utf8ByteLength(s)',
        'const url = `https://host//path`',
      ].join('\n')
      expect(scanRendererText('synthetic.tsx', tsx)).toEqual([])
    })

    it('honors reviewed allowlist entries', () => {
      const text = 'const env = process.env\n'
      const violations = scanRendererText('synthetic.ts', text, [
        { file: 'synthetic.ts', snippet: 'process.env', reason: 'synthetic test fixture' },
      ])
      expect(violations).toEqual([])
      expect(scanRendererText('synthetic.ts', text, [
        { file: 'other.ts', snippet: 'process.env', reason: 'wrong file must not match' },
      ])).toHaveLength(1)
    })
  })

  it('keeps src/client and src/native-ui free of Node globals', () => {
    const files = listRendererSources()
    expect(files.map(file => relative(PLUGIN_ROOT, file))).toContain('src/client/environment.ts')
    expect(files.map(file => relative(PLUGIN_ROOT, file))).toContain('src/native-ui/sso-gate/App.tsx')
    // A broken root resolution must fail loudly instead of passing vacuously.
    expect(files.length).toBeGreaterThanOrEqual(30)
    const violations = files.flatMap(file => scanRendererText(relative(PLUGIN_ROOT, file), readFileSync(file, 'utf8')))
    expect(violations, formatViolations(violations)).toEqual([])
  })
})
