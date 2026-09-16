# OCR Examples

## Example 1: Convert Single Document

```bash
python scripts/call_ocr.py documents/report.pdf --api-key YOUR_API_KEY
```

**Input:** `documents/report.pdf`
**Output:** `documents/report_markdown.md`

---

## Example 2: Batch Convert Folder

```bash
python scripts/call_ocr.py data/pdf_data/ --api-key YOUR_API_KEY
```

**Input:** `data/pdf_data/` (contains multiple PDFs)
**Output:** `data/pdf_data_result/` (contains all MD files)

---

## Example 3: Custom Output Location

```bash
python scripts/call_ocr.py ./documents/ -o ./output/markdown/ --api-key YOUR_API_KEY
```

**Input:** `./documents/`
**Output:** `./output/markdown/`

---

## Example 4: Large File Processing

```bash
python scripts/call_ocr.py large_file.pdf --api-key YOUR_API_KEY --verbose
```

**For large or slow-processing files**, enable verbose logging for progress visibility. The default polling settings (20s interval, 60 retries) allow up to 20 minutes of processing time.

---

## Example 5: Absolute Paths

```bash
python scripts/call_ocr.py "C:\Users\user\Documents\contract.pdf" --api-key YOUR_API_KEY
python scripts/call_ocr.py "C:\Users\user\Documents\contracts" -o "C:\Users\user\Output" --api-key YOUR_API_KEY
```

**Note:** Use quotes for paths with spaces or special characters.

---

## Example 6: Multiple Conversions

```bash
# Convert contract 1
python scripts/call_ocr.py documents/contract1.pdf --api-key YOUR_API_KEY

# Convert contract 2
python scripts/call_ocr.py documents/contract2.pdf --api-key YOUR_API_KEY

# Batch convert all invoices
python scripts/call_ocr.py invoices/ -o output/invoices_md/ --api-key YOUR_API_KEY
```
