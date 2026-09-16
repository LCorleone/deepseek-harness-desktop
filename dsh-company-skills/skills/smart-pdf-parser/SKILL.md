---
name: smart-pdf-parser
description: "Intelligent PDF parser that classifies each page (Text / OCR / VLM) and uses the optimal extraction method per page. Use when: (1) PDF contains mixed page types (editable text, scanned images, or both), (2) Need the best extraction quality for complex PDFs, (3) 'Smart PDF', 'intelligent PDF', 'auto detect PDF', 'parse PDF'. Combines pdfplumber (text pages), OCR API (scanned pages), and VLM (mixed pages) into a single Markdown output."
---

# Smart PDF Parser

Intelligently parse PDF documents by classifying each page and using the optimal extraction method.

## How It Works

For each page of the PDF:

1. **Classify** using PyMuPDF — calculate the ratio of image area to page area
2. **Route** to the best extraction method:
    - **Text** (image area < 5%) → pdfplumber direct extraction
    - **VLM** (image area > 40%) → VLM via `vlm_ocr.py` (whole-page processing)
    - **OCR** (image area 5%~40%) → OCR API via `call_ocr.py`
3. **Process in parallel** — OCR and VLM pages are processed concurrently using a thread pool (default 2 workers)
4. **Merge** all pages into a single Markdown file in original page order

## Prerequisites

```bash
pip install -r requirements.txt
```

The OCR and VLM helper scripts are vendored into this skill (`scripts/vendor/call_ocr.py`, `scripts/vendor/vlm_ocr.py` — #043 D5), so no sibling skills are required. Note the drift risk: vendored copies do not automatically track the `ocr`/`vlm-image` skills.

## How to Use

Execute the script directly via Bash tool:

```bash
python scripts/smart_parse.py /path/to/document.pdf
```

**Note**: The agent should not read or modify the script unless debugging is needed.

**MUST set Bash tool timeout**: This script calls external OCR/VLM APIs. Each page can take up to 10 minutes. You **MUST** set the Bash tool `timeout` parameter to `3600000` (1 hour) when executing any command below. The script exits early when done — this is just an upper bound.

```bash
python scripts/smart_parse.py /path/to/document.pdf  # timeout: 3600000
```

## Examples

> **All commands below require Bash tool `timeout` set to `3600000` (1 hour).**

```bash
# Basic usage
python scripts/smart_parse.py /path/to/document.pdf  # timeout: 3600000

# Custom output path
python scripts/smart_parse.py /path/to/document.pdf -o /output/result.md  # timeout: 3600000

# Adjust image area threshold (default 0.40)
python scripts/smart_parse.py /path/to/document.pdf --image-area-threshold 0.30  # timeout: 3600000

# Adjust parallel workers (default 2)
python scripts/smart_parse.py /path/to/document.pdf --workers 5  # timeout: 3600000

# Verbose mode (show classification details per page)
python scripts/smart_parse.py /path/to/document.pdf -v  # timeout: 3600000

# Specify OCR/VLM script paths manually
python scripts/smart_parse.py /path/to/document.pdf \
  --ocr-script /path/to/call_ocr.py \
  --vlm-script /path/to/vlm_ocr.py  # timeout: 3600000
```

Output: `/path/to/document_smart.md`

## Output Format

Single Markdown file with page markers:

```markdown
<PAGE 1>
[extracted content for page 1]
</PAGE 1>

<PAGE 2>
[extracted content for page 2]
</PAGE 2>
```

## CLI Options

```bash
python scripts/smart_parse.py <input_pdf> [options]

Arguments:
  input_pdf             Path to input PDF file

Options:
  -o, --output PATH     Output markdown path (default: {filename}_smart.md)
  --image-area-threshold RATIO  Image area ratio above which pages use VLM (default: 0.40)
  -w, --workers N       Max concurrent OCR/VLM API calls (default: 2)
  --ocr-script PATH     Path to call_ocr.py (default: vendored scripts/vendor/call_ocr.py)
  --vlm-script PATH     Path to vlm_ocr.py (default: vendored scripts/vendor/vlm_ocr.py)
  --classify-only       Only classify pages and print summary (for timeout calculation)
  -v, --verbose         Enable verbose logging
```

## Page Classification Rules

| Image area ratio | Classification | Method |
|---|---|---|
| < 5% | Text | pdfplumber |
| 5% ~ 40% | OCR | OCR API |
| > 40% | VLM | VLM |

## Environment Variables

`ROUTER_URL` and `ROUTER_API_KEY` are injected by the managed desktop build when a skill script runs — the managed build injects these; do not edit, create, or read `.env` files for them. The same pair serves both the OCR and the VLM pages.
