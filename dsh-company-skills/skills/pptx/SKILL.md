---
name: pptx
description: "Analyze, read, and precisely edit EXISTING PowerPoint files via OOXML: extract text with markitdown, inspect and modify slide XML, edit user-uploaded .pptx templates (Deloitte-style Preservation Contract included). The specialist for UNDERSTANDING an existing .pptx and surgical XML editing — NOT the primary path for generating new decks (use ppt-designer for generation, incl. Deloitte-template decks). Triggers: read/analyze/extract text from a PPTX, formatting issues, edit a template's content."
license: MIT
---

# PPTX Generator & Editor

## Overview

This skill handles all PowerPoint tasks: **generating decks from a built-in Deloitte template (the default path)**, editing template-based decks via XML manipulation, reading/analyzing existing presentations, and creating presentations from scratch with PptxGenJS as a fallback. It includes a complete design system (color palettes, fonts, style recipes) and detailed guidance for every slide type.

## START HERE — Ask the User Before Generating

**When a user asks to generate a PPTX, do NOT silently pick a workflow. Ask first.** Follow these two steps:

### Step 1 — Ask: "Do you have your own `.pptx` template?"

- **Yes** (user provides a `.pptx`) → Use the [Editing workflow](references/editing.md). Stop here.
- **No** → Go to Step 2.

### Step 2 — Ask: "Deloitte template (recommended) or build from scratch?"

Present both options. **Recommend the Deloitte template.**

- **Deloitte template** (default) → [Default Generation Workflow (Deloitte Template)](#default-generation-workflow-deloitte-template)
- **From scratch** → [Creating from Scratch](#creating-from-scratch-workflow) — fallback only; use if the user explicitly chooses it or confirms the Deloitte template does not fit.

**Do NOT jump straight to PptxGenJS / from-scratch without asking.** Deloitte is the recommended default.

### Other tasks (no question needed)

| User request | Workflow |
|--------------|----------|
| Read or analyze an existing PPTX | [Reading Content](#reading-content) |

## Quick Reference

| Task | Approach |
|------|----------|
| **Generate a deck (default)** | Use the Deloitte template via the [Editing workflow](references/editing.md) |
| Read/analyze content | `python -m markitdown presentation.pptx` (check/install first — see [Python Tools](#reading-content) below) |
| Use a user-provided template | See [Editing Presentations](references/editing.md) |
| Create from scratch (fallback) | See [Creating from Scratch](#creating-from-scratch-workflow) below |

| Item | Value |
|------|-------|
| **Dimensions** | 10" x 5.625" (LAYOUT_16x9) |
| **Colors** | 6-char hex without # (e.g., `"FF0000"`) |
| **English font** | Arial (default), or approved alternatives |
| **Chinese font** | Microsoft YaHei |
| **Page badge position** | x: 9.3", y: 5.1" |
| **Theme keys** | `primary`, `secondary`, `accent`, `light`, `bg` |
| **Shapes** | RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE |
| **Charts** | BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR |

## Reference Files

| File | Contents |
|------|----------|
| [deloitte-template/deloitte-template.pptx](deloitte-template/deloitte-template.pptx) | Default Deloitte template for PPTX generation |
| [slide-types.md](references/slide-types.md) | 5 slide page types (Cover, TOC, Section Divider, Content, Summary) + additional layout patterns |
| [design-system.md](references/design-system.md) | Color palettes, font reference, style recipes (Sharp/Soft/Rounded/Pill), typography & spacing |
| [editing.md](references/editing.md) | Template-based editing workflow, XML manipulation, formatting rules, common pitfalls |
| [pitfalls.md](references/pitfalls.md) | QA process, common mistakes, critical PptxGenJS pitfalls |
| [pptxgenjs.md](references/pptxgenjs.md) | Complete PptxGenJS API reference |

---

## Reading Content

> **Python Tools — three-stage rule** (`markitdown` is NOT preinstalled with the desktop's shared Python environment). Every pptx→markdown extraction in this skill needs it:
> 1. **Check first:** `python -c "import markitdown"` (or `markitdown --version` on PATH).
> 2. **If missing, try install:** `dsh-pip install "markitdown[pptx]"` — the desktop's managed pip channel into the shared Python environment; corporate proxy and sandbox escalation approval apply as usual. Heads-up: this pulls a ~42 MB dependency chain (magika/onnxruntime/numpy/sympy).
> 3. **Only on install failure:** fall back to the native python-pptx read path — `python-pptx` IS preinstalled, and the OOXML unpack/edit/pack workflow ([references/editing.md](references/editing.md)) needs no converter at all; only the pptx→markdown convenience degrades.

```bash
# Text extraction
python -m markitdown presentation.pptx

# Native fallback if markitdown stays missing (python-pptx is preinstalled, no install needed)
python -c "import sys; from pptx import Presentation; p = Presentation(sys.argv[1]); print('\n\n'.join('\n'.join(s.text_frame.text for s in slide.shapes if s.has_text_frame) for slide in p.slides))" presentation.pptx
```

---

## Default Generation Workflow (Deloitte Template)

**Use this by default whenever a user asks to generate a PPTX from content.** The caller is responsible for parsing any user-provided content files; this skill assumes content is already available as text.

### ⚠️ The Preservation Contract — read this first

The Deloitte template supplies the **look** (colors, fonts, 图案, images, icons, decorative styling). That look is **locked**. The **content and structure are yours** to produce.

- ✅ **Content — yours to write**: digest the user's material and **write the slide text yourself** (don't paste source text or placeholder text verbatim — compose proper slide copy). You also decide the **deck structure**: which slides exist, their order, what each covers.
- ✅ **Structure — yours to adapt**: add / remove / reorder slides, and adapt a slide's layout to fit (e.g. drop a slot you don't need, reuse a layout). Match content to the template's existing layout patterns.
- ❌ **Styling — locked to the template**: reuse the template's colors, fonts, graphics/图案, images, icons. Do **not** introduce new visual elements, new color schemes, new fonts, or restyle existing shapes. Pulling colors out of `design-system.md` to re-skin is the **#1 failure mode** — don't.
- Net rule: **think freely about what each slide says and how the deck flows; stay on rails for how everything looks.**

Template location (relative to this skill directory):

```
deloitte-template/deloitte-template.pptx
```

Workflow:

1. Copy the Deloitte template into the working directory:
   ```bash
   cp deloitte-template/deloitte-template.pptx template.pptx
   ```
2. **Analyze the template's styling vocabulary** with `markitdown` (`python -m markitdown template.pptx > template.md`) — see its colors, fonts, and the layout patterns each slide offers. You'll reuse these visuals and adapt structure to your content. Run the [Python Tools](#reading-content) check/install first; if markitdown stays missing, read the slide XML from the unpacked tree instead (see [references/editing.md](references/editing.md)).
3. Follow the **Template-Based Workflow** in [editing.md](references/editing.md) — unpack, build the deck structure (add/remove/reorder slides), **write the slide text yourself** from the user's material, clean, pack. Reuse the template's styling throughout; obey the Preservation Contract above.
4. Run the [QA Process](references/pitfalls.md#qa-process) before declaring success.

If the user explicitly asks to build from scratch, or the content clearly does not fit the Deloitte template, fall back to [Creating from Scratch](#creating-from-scratch-workflow) below.

---

## Creating from Scratch — Workflow

> **You should only be here if one of these is true:**
> - The user chose "from scratch" when asked in [START HERE](#start-here--ask-the-user-before-generating), OR
> - You confirmed the Deloitte template genuinely does not fit the content.
>
> If neither is true, go back and ask the user first.

### Step 1: Research & Requirements

Search to understand user requirements — topic, audience, purpose, tone, content depth.

### Step 2: Select Color Palette & Fonts

Use the [Color Palette Reference](references/design-system.md#color-palette-reference) to select a palette matching the topic and audience. Use the [Font Reference](references/design-system.md#font-reference) to choose a font pairing.

### Step 3: Select Design Style

Use the [Style Recipes](references/design-system.md#style-recipes) to choose a visual style (Sharp, Soft, Rounded, or Pill) matching the presentation tone.

### Step 4: Plan Slide Outline

Classify **every slide** as exactly one of the [5 page types](references/slide-types.md). Plan the content and layout for each slide. Ensure visual variety — do NOT repeat the same layout across slides.

### Step 5: Generate Slide JS Files

Create one JS file per slide in `slides/` directory. Each file must export a synchronous `createSlide(pres, theme)` function. Follow the [Slide Output Format](#slide-output-format) and the type-specific guidance in [slide-types.md](references/slide-types.md). Generate up to 5 slides concurrently using subagents if available.

**Tell each subagent:**
1. File naming: `slides/slide-01.js`, `slides/slide-02.js`, etc.
2. Images go in: `slides/imgs/`
3. Final PPTX goes in: `slides/output/`
4. Dimensions: 10" x 5.625" (LAYOUT_16x9)
5. Fonts: Chinese = Microsoft YaHei, English = Arial (or approved alternative)
6. Colors: 6-char hex without # (e.g. `"FF0000"`)
7. Must use the theme object contract (see [Theme Object Contract](#theme-object-contract))
8. Must follow the [PptxGenJS API reference](references/pptxgenjs.md)

### Step 6: Compile into Final PPTX

Create `slides/compile.js` to combine all slide modules:

```javascript
// slides/compile.js
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';

const theme = {
  primary: "22223b",    // dark color for backgrounds/text
  secondary: "4a4e69",  // secondary accent
  accent: "9a8c98",     // highlight color
  light: "c9ada7",      // light accent
  bg: "f2e9e4"          // background color
};

for (let i = 1; i <= 12; i++) {  // adjust count as needed
  const num = String(i).padStart(2, '0');
  const slideModule = require(`./slide-${num}.js`);
  slideModule.createSlide(pres, theme);
}

pres.writeFile({ fileName: './output/presentation.pptx' });
```

Run with: `cd slides && node compile.js`

### Step 7: QA (Required)

See [QA Process](references/pitfalls.md#qa-process).

### Output Structure

```
slides/
├── slide-01.js          # Slide modules
├── slide-02.js
├── ...
├── imgs/                # Images used in slides
└── output/              # Final artifacts
    └── presentation.pptx
```

---

## Slide Output Format

Each slide is a **complete, runnable JS file**:

```javascript
// slide-01.js
const pptxgen = require("pptxgenjs");

const slideConfig = {
  type: 'cover',
  index: 1,
  title: 'Presentation Title'
};

// MUST be synchronous (not async)
function createSlide(pres, theme) {
  const slide = pres.addSlide();
  slide.background = { color: theme.bg };

  slide.addText(slideConfig.title, {
    x: 0.5, y: 2, w: 9, h: 1.2,
    fontSize: 48, fontFace: "Arial",
    color: theme.primary, bold: true, align: "center"
  });

  return slide;
}

// Standalone preview - use slide-specific filename
if (require.main === module) {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  const theme = {
    primary: "22223b",
    secondary: "4a4e69",
    accent: "9a8c98",
    light: "c9ada7",
    bg: "f2e9e4"
  };
  createSlide(pres, theme);
  pres.writeFile({ fileName: "slide-01-preview.pptx" });
}

module.exports = { createSlide, slideConfig };
```

---

## Theme Object Contract (MANDATORY)

The compile script passes a theme object with these **exact keys**:

| Key | Purpose | Example |
|-----|---------|---------|
| `theme.primary` | Darkest color, titles | `"22223b"` |
| `theme.secondary` | Dark accent, body text | `"4a4e69"` |
| `theme.accent` | Mid-tone accent | `"9a8c98"` |
| `theme.light` | Light accent | `"c9ada7"` |
| `theme.bg` | Background color | `"f2e9e4"` |

**NEVER use other key names** like `background`, `text`, `muted`, `darkest`, `lightest`.

---

## Page Number Badge (REQUIRED)

All slides **except Cover Page** MUST include a page number badge in the bottom-right corner.

- **Position**: x: 9.3", y: 5.1"
- Show current number only (e.g. `3` or `03`), NOT "3/12"
- Use palette colors, keep subtle

### Circle Badge (Default)

```javascript
slide.addShape(pres.shapes.OVAL, {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fill: { color: theme.accent }
});
slide.addText("3", {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fontSize: 12, fontFace: "Arial",
  color: "FFFFFF", bold: true,
  align: "center", valign: "middle"
});
```

### Pill Badge

```javascript
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 9.1, y: 5.15, w: 0.6, h: 0.35,
  fill: { color: theme.accent },
  rectRadius: 0.15
});
slide.addText("03", {
  x: 9.1, y: 5.15, w: 0.6, h: 0.35,
  fontSize: 11, fontFace: "Arial",
  color: "FFFFFF", bold: true,
  align: "center", valign: "middle"
});
```

---

## Dependencies

- **markitdown**: pptx→markdown text extraction — NOT preinstalled; checked at runtime; self-install attempt via dsh-pip; python-pptx fallback on failure (see [Python Tools](#reading-content))
- `npm install -g pptxgenjs` — creating from scratch
- `npm install -g react-icons react react-dom sharp` — icons (optional)
