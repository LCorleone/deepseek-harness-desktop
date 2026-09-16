---
name: ocr
description: "OCR-based PDF to Markdown converter using OCR service API. Use when converting PDF documents or batches of PDFs to Markdown format via OCR service. Ideal for: (1) Standard PDF to Markdown conversion, (2) Batch processing multiple PDFs, (3) Documents requiring OCR rather than vision language models."
---

# OCR - PDF to Markdown Converter

Convert PDF documents to Markdown using OCR service via `scripts/call_ocr.py`.

## Prerequisites

`requests` and `tqdm` (see `requirements.txt`). API credentials (`ROUTER_URL`, `ROUTER_API_KEY`) need no setup: the managed desktop build injects them into the script's environment when it runs — do not edit, create, or read `.env` files for them.

## How to Use

Execute the script directly via Bash tool:
- Single file: `python scripts/call_ocr.py <file>`
- Directory: `python scripts/call_ocr.py <directory>`
- Results are returned as markdown

**Note**: The agent should not read or modify the script unless debugging is needed.

**MUST set Bash tool timeout**: OCR processing can take up to 20 minutes per file. You **MUST** set the Bash tool `timeout` parameter to `1200000` when executing any command below.

```bash
python scripts/call_ocr.py /path/to/document.pdf  # timeout: 1200000
```

## Examples

> **All commands below require Bash tool `timeout` set to `1200000` (20 minutes).**

```bash
# API credentials come from the injected environment (default)
python scripts/call_ocr.py /path/to/document.pdf  # timeout: 1200000

# Or override with custom API key
python scripts/call_ocr.py /path/to/document.pdf --api-key YOUR_API_KEY  # timeout: 1200000
```

Output: `/path/to/document_markdown.md`

```bash
# API credentials come from the injected environment (default)
python scripts/call_ocr.py /path/to/pdfs/  # timeout: 1200000

# Or override with custom API key
python scripts/call_ocr.py /path/to/pdfs/ --api-key YOUR_API_KEY  # timeout: 1200000
```

Output: `/path/to/pdfs_result/{filename}_markdown.md`

```bash
python scripts/call_ocr.py /path/to/pdfs/ -o /output/path --api-key YOUR_API_KEY  # timeout: 1200000
```

## Output Naming

- **Single file**: `{filename}_markdown.md` (same directory)
- **Directory**: `{foldername}_result/{filename}_markdown.md` (same level as input)

Intermediate ZIP files are auto-deleted.

## Workflow

1. Upload PDF(s) to OCR service
2. Poll for processing completion
3. Download results (ZIP files)
4. Extract and generate Markdown files
5. Auto-clean intermediate files

## Additional Options

See available options with:

```bash
python scripts/call_ocr.py --help
```

Common options include `--poll-interval`, `--max-retries`, `--timeout`, and `--verbose`.

## More Examples

See [references/examples.md](references/examples.md) for detailed usage examples.
