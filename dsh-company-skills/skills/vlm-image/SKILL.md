---
name: vlm-image
description: "Vision Language Model image analysis and OCR tool for extracting text from images and PDFs. Use when the agent needs to: (1) Extract text from images (JPG, PNG, GIF, BMP, TIFF, WebP, SVG, ICO), (2) Perform OCR on PDF documents, (3) Analyze scanned documents, (4) Batch process multiple documents. Requires VLM_API_KEY environment variable or --api-key argument."
---

# VLM Image

Extract text from images and PDF documents using Vision Language Model (VLM).

## Prerequisites

`requests`, `aiohttp`, `PyMuPDF` (`fitz`), `pillow`, `python-dotenv` (see `requirements.txt`). API credentials need no setup: `ROUTER_URL` and `ROUTER_API_KEY` are injected by the managed desktop build into the script's environment when it runs — the managed build injects these; do not edit, create, or read `.env` files for them. A per-call override is still available through `--api-key`/`--api-url`.

## How to Use

Execute the script directly via Bash tool:
- Single file: `python scripts/vlm_ocr.py <file>`
- Directory: `python scripts/vlm_ocr.py <directory>`
- Results are returned as markdown

**Note**: The agent should not read or modify the script unless debugging is needed.

**MUST set Bash tool timeout**: VLM processing can take up to 20 minutes per file (with retries). You **MUST** set the Bash tool `timeout` parameter to `1200000` when executing any command below.

```bash
python scripts/vlm_ocr.py document.pdf  # timeout: 1200000
```

## Installation

Before first use, pay attention to the dependencies in `requirements.txt`:
```bash
pip install -r requirements.txt
```

## Examples

> **All commands below require Bash tool `timeout` set to `1200000` (20 minutes).**

```bash
# Process single file
python scripts/vlm_ocr.py document.pdf  # timeout: 1200000
python scripts/vlm_ocr.py image.png  # timeout: 1200000

# With custom batch size
python scripts/vlm_ocr.py document.pdf --batch-size 3 -o result.md  # timeout: 1200000
python scripts/vlm_ocr.py image.png --batch-size 3 -o result.md  # timeout: 1200000

# Process directory of PDFs
python scripts/vlm_ocr.py ./pdf_folder  # timeout: 1200000
```

## Configuration

> **Note**: `ROUTER_URL` and `ROUTER_API_KEY` are injected by the managed desktop build when a skill script runs; no manual setup is required. Do not edit, create, or read `.env` files for them — the managed build injects these.

| Variable | Description |
|----------|-------------|
| `ROUTER_URL` | API base URL (injected by the managed build) |
| `ROUTER_API_KEY` | API authentication key (injected by the managed build) |
| `VLM_MODEL_NAME` | Model name (optional, read from the environment) |

## CLI Options

```bash
python scripts/vlm_ocr.py <file> [options]

Arguments:
  file                Path to input PDF/image file or directory containing PDFs

Options:
  --api-key KEY        API key (or VLM_API_KEY env var)
  --api-url URL        API URL (or VLM_API_URL env var)
  --batch-size N       Concurrent requests (default: 2)
  --output, -o PATH    Output path
  --sync               Use synchronous processing
  --verbose, -v        Enable verbose logging
```

## Resources

- **scripts/vlm_ocr.py**: Main OCR implementation with VLM client
