# dsh-dai-office-tools

Nine model-facing Office file tools for DeepSeek Harness, running entirely in the plugin host half.

[![npm version](https://img.shields.io/npm/v/dsh-dai-office-tools)](https://www.npmjs.com/package/dsh-dai-office-tools) [![ci](https://github.com/kw78/dsh-dai-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-dai-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Listed on awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> Install: `dsh plugin --profile web add github:kw78/dsh-dai-office-tools`

> Local revision `1.0.2`: adds `ppt_update` and packages newly authored PPT images inside the OOXML container.

Nine model-facing Office file tools for DeepSeek Harness, running entirely in the plugin host half — dependency-free since 1.0.0: every package is generated and parsed by this plugin's own OOXML engine, and every byte crosses the official DSH filesystem service (`ctx.fs`), never the raw file system.

| Tool | Purpose |
|---|---|
| `word_create` | Create `.docx` (title, paragraphs, bullets, one table) |
| `word_read` | Extract text from any `.docx`; `format: "markdown"` renders headings, lists, and tables structurally |
| `word_update` | Append paragraphs, bullets, and/or a table to an existing `.docx` |
| `excel_create` | Create a multi-sheet `.xlsx` from scalar cell grids |
| `excel_read` | Read one or all sheets as scalar rows; formulas return cached values or `'=…'` strings |
| `excel_update` | Replace/create whole sheets, or write cells by A1 address |
| `ppt_create` | Create a 16:9 `.pptx` (title slide, titles, paragraphs, bullets, notes, embedded PNG/JPG/GIF images) and echo every element's landing position |
| `ppt_read` | Extract per-slide paragraphs, tables, speaker notes, image counts, alt texts — plus every shape's bounding box in inches and a text wireframe sketch |
| `ppt_update` | Append slides to an existing `.pptx`, including text, notes, and embedded images |

String cells starting with `=` are written as real Excel formulas (Excel computes them on open).

## Demo

One prompt, a quarterly-report trio — Word with a metrics table, Excel with `=SUM`/variance formulas, PowerPoint with speaker notes:

<img src="docs/demo/session.svg" alt="One prompt generating report.docx, budget.xlsx, and deck.pptx" width="780">

The prompt behind that session:

> Generate the Q3 quarterly-report trio: `report.docx` (title, two summary paragraphs, three highlights, a metrics table), `budget.xlsx` (a Budget sheet with `=SUM` totals and plan-vs-actual variance formulas, plus a Summary sheet), and `deck.pptx` (title slide + three content slides with speaker notes).

The model turns it into `word_create` → `excel_create` → `ppt_create` (reads come back through `word_read` / `excel_read` / `ppt_read`; freshly written formulas read back as `'=…'` strings until Excel caches values). The whole flow is pinned by `tests/demo-trio.spec.ts`, so the demo cannot drift from the tools. The file sizes in the image come from a real run of that test scenario.

## Harness integration

The plugin follows the standard DSH host-plugin contract:

- It exports `name` / `inject` / `apply` / `Config`; `inject = ['tools', 'fs']` — the official tool registry and the official filesystem service (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-fs`) are its only runtime service dependencies.
- `apply(ctx)` wraps every `ctx.tools.register(defineTool({...}))` in `ctx.effect(...)` so Cordis disposes the registrations with the plugin fiber.
- `defineTool` declares model-visible `parameters`, a validated canonical `output.schema`, and a pure `output.render` text projection.
- `execute(args, exec)` resolves every path against `exec.agent.session.header.cwd`; relative paths stay in the session workspace and absolute paths are accepted only when still inside it. Containment and symlink resolution are enforced by the `ctx.fs` backend (plus a lexical pre-check here).
- All reads arrive as raw bytes via `ctx.fs.readBytes`. Creates leave as UTF-8 text via `ctx.fs.writeText` — published atomically by the backend; `overwrite` defaults to `false`. Updates (`word_update`, `ppt_update`) rewrite the package in place as a real binary zip through an atomic staging-file rename in the destination directory (the same publication pattern the fs backend itself uses), so binary parts — embedded images, fonts, thumbnails — are preserved byte-for-byte.
- Created packages are pure ASCII by construction (an ASCII-safe STORE zip planner pads each XML part and aligns offsets so every CRC/size/offset field stays byte-safe), which is exactly what lets real `.docx`/`.xlsx`/`.pptx` files travel through the text channel byte-identically. Non-ASCII text encodes as XML character references; every Office suite opens the result.
- Reads accept any real-world package (STORE and DEFLATE entries, bounded by the zip-bomb guard), and updates accept any real-world package too: `word_update` and `ppt_update` copy every existing entry verbatim and only splice in the parts they change.
- `excel_update` still re-publishes through the text channel (it rebuilds the whole workbook), so it works on packages whose every part is text (always true for files these tools write, and for OOXML packages without binary media); packages carrying binary media are refused with a clear error instead of being corrupted.
- PPT images are embedded: each new image is stored as `ppt/media/imageN.svg`, with the original PNG/JPG/GIF bytes carried as a Base64 data URI inside the SVG, and slides reference the internal part with `r:embed`. The model controls placement fully (`x/y/w/h` inches, `contain`/`cover` cropping, alt text; image headers are sniffed so omitted dimensions default to natural size). Moving the deck no longer requires the source image files.
- `ppt_update` appends slides and preserves every existing package part byte-for-byte, including binary media in decks authored by PowerPoint.
- `ppt_create` echoes the full layout (every element's box in inches + the canvas size + a text wireframe sketch per slide); `ppt_read` returns the same geometry for any deck, so the model can see and re-author compositions.

## Build

```bash
pnpm install
pnpm run check   # typecheck + tests + build
```

Artifacts: `lib/index.js` (ESM host bundle of this plugin's own code only — ~116 kB, zero runtime dependencies) and `lib/types/**/*.d.ts`. Every `@deepseek-ai/*` package (cordis, the dsh services, schemastery) stays external and is provided by the profile's node_modules.

## Install

```bash
# npm (recommended)
dsh plugin --profile web add dsh-dai-office-tools

# GitHub source
dsh plugin --profile web add github:kw78/dsh-dai-office-tools

# local checkout
dsh plugin --profile web add /path/to/dsh-dai-office-tools
```

Restart the DSH server after installation. The nine tools appear in the next prompt assembly. Since 1.0.0 the plugin has zero runtime dependencies — no npm fetch, no CDN, no postinstall scripts; installation is the committed source, nothing else. The host must provide the `fs` service (every DSH profile that ships the built-in read/write tools does).

## Configuration

The plugin declares a schemastery `Config` the Loader validates at load time. One option exists today:

| Option | Type | Default | Effect |
|---|---|---|---|
| `enablePptTools` | boolean | `true` | Register `ppt_create` / `ppt_read` / `ppt_update`. Set to `false` to load this plugin for Word/Excel only. |

`enablePptTools: false` exists for coexistence: dedicated presentation plugins such as dsh-ppt also register a `ppt_create`, and DSH refuses duplicate tool names at startup (`tool "ppt_create" is already registered`). Disable the PPT pair here and let the dedicated plugin own presentations:

```yaml
# profile cordis.patch.yml
- insert:
    - id: dsh-dai-office-tools
      config:
        enablePptTools: false
```

## Community indexes

- Registration blocks for awesome-dsh-plugin / dsh-market are in [docs/hub-registration.md](docs/hub-registration.md).
- Recommended repository topics: `dsh`, `dsh-plugin`, `deepseek-harness`, `office`.

## Safety

- All file access is confined to the calling agent's session workspace.
- Reads are capped at 50 MiB compressed; before anything is inflated, the archive's own declared sizes are checked against budgets (256 MiB per entry, 512 MiB per archive, 100 000 entries), so zip bombs are refused rather than decompressed. XML parts carrying DOCTYPE/ENTITY declarations are refused outright.
- Text/cell results are bounded and mark `truncated`.
- Creates/updates are bounded by row and cell limits and refuse overwrites by default.
- No LibreOffice/PowerPoint/Word subprocess is spawned and no third-party library is shipped: formats are generated and parsed by this plugin's own ASCII-safe OOXML engine over `node:zlib`.
- The plugin's own code never touches the file system directly — there is no `node:fs` import anywhere in `src/`; every byte flows through the official, user-visible `ctx.fs` service. This is what lets third-party store automation verify the whole runtime source deterministically (DSH Store issue #334: 1.0.0 passes the complete automatic low-risk policy — zero runtime dependencies, zero file/network/commands/credentials signals, bounded source, exact per-release compatibility declarations).
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md).
