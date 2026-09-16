#!/usr/bin/env python3
"""
Smart PDF Parser - Intelligently parse PDF pages using the best method for each page.

Classification strategy (image_area_ratio):
  - text:   image area < 5% of page area         → pdfplumber
  - vlm:    image area > 40% of page area        → VLM (vlm_ocr.py)
  - ocr:    image area 5%~40% of page area       → OCR API (call_ocr.py)
"""

import sys
import os

if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import argparse
import json
import logging
import re
import shutil
import subprocess
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import fitz
import pdfplumber
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# #043 batch B (D5): the ocr/vlm-image scripts this parser drives are vendored
# into THIS skill (scripts/vendor/) because the skill executor stages each
# skill in its own private directory — the source tree's ../../ocr and
# ../../vlm-image sibling lookups (SKILLS_DIR/ocr, SKILLS_DIR/vlm-image)
# cannot resolve there. DRIFT RISK: the vendored copies do not track future
# edits to the `ocr` and `vlm-image` skills; re-vendor when those change.
SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_OCR_SCRIPT = SCRIPTS_DIR / "vendor" / "call_ocr.py"
DEFAULT_VLM_SCRIPT = SCRIPTS_DIR / "vendor" / "vlm_ocr.py"

PAGE_TEXT = "text"
PAGE_OCR = "ocr"
PAGE_VLM = "vlm"

LABEL = {PAGE_TEXT: "Text", PAGE_OCR: "OCR", PAGE_VLM: "VLM"}


def classify_pages(
    pdf_path: str, image_area_threshold: float = 0.40
) -> List[Tuple[str, int, str]]:
    """Classify each page as text, ocr, or vlm.

    Rules:
      - img_ratio < 5%                        → text (pdfplumber)
      - img_ratio > image_area_threshold      → vlm
      - 5% <= img_ratio <= image_area_threshold → ocr

    Returns list of (classification, page_num_0indexed, description)
    """
    doc = fitz.open(pdf_path)
    results = []

    for page_num in range(len(doc)):
        page = doc.load_page(page_num)

        page_rect = page.rect
        page_area = page_rect.width * page_rect.height
        total_img_area = 0
        img_count = 0
        for img in page.get_images(full=True):
            xref = img[0]
            rects = page.get_image_rects(xref)
            for r in rects:
                total_img_area += r.width * r.height
            img_count += 1
        img_ratio = total_img_area / page_area if page_area > 0 else 0

        if img_ratio < 0.05:
            classification = PAGE_TEXT
        elif img_ratio > image_area_threshold:
            classification = PAGE_VLM
        else:
            classification = PAGE_OCR

        results.append(
            (
                classification,
                page_num,
                f"chars=ignored, images={img_count}, img_area={img_ratio:.1%}",
            )
        )

    doc.close()
    return results


def extract_text_page(pdf_path: str, page_num: int) -> str:
    """Extract text from a text-only page using pdfplumber."""
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[page_num]
        text = page.extract_text() or ""
        tables = page.extract_tables()

        result = text
        if tables:
            for table in tables:
                if table:
                    rows = []
                    for row in table:
                        cells = [str(cell) if cell is not None else "" for cell in row]
                        rows.append("| " + " | ".join(cells) + " |")
                    if rows:
                        result += "\n\n" + "\n".join(rows)

        return result.strip()


def extract_single_page_pdf(pdf_path: str, page_num: int, output_path: str) -> str:
    """Extract a single page from PDF into a new PDF file."""
    doc = fitz.open(pdf_path)
    new_doc = fitz.open()
    new_doc.insert_pdf(doc, from_page=page_num, to_page=page_num)
    new_doc.save(output_path)
    new_doc.close()
    doc.close()
    return output_path


def page_to_image(
    pdf_path: str, page_num: int, output_path: str, dpi: int = 300
) -> str:
    """Convert a single PDF page to PNG image."""
    from PIL import Image

    doc = fitz.open(pdf_path)
    page = doc.load_page(page_num)

    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)

    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    img.save(output_path)

    doc.close()
    return output_path


SUBPROCESS_TIMEOUT = 600
MAX_RETRIES = 2


def run_ocr_subprocess(
    ocr_script: str, page_pdf_path: str, output_dir: str
) -> Optional[str]:
    """Run call_ocr.py as subprocess for a scanned page. Retries once on failure."""
    cmd = [sys.executable, str(ocr_script), page_pdf_path, "-o", output_dir]

    logger.debug(f"OCR cmd: {' '.join(cmd)}")
    for attempt in range(MAX_RETRIES):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
                encoding="utf-8",
                errors="replace",
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr)

            name_without_ext = Path(page_pdf_path).stem
            md_path = os.path.join(output_dir, f"{name_without_ext}_markdown.md")

            if os.path.exists(md_path):
                with open(md_path, "r", encoding="utf-8") as f:
                    return f.read().strip()
            else:
                raise FileNotFoundError(f"OCR output not found: {md_path}")
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                logger.warning(f"OCR attempt {attempt + 1} failed: {e}, retrying...")
            else:
                logger.error(f"OCR failed after {MAX_RETRIES} attempts: {e}")
                return None
    return None


def run_vlm_subprocess(
    vlm_script: str, page_image_path: str, output_path: str
) -> Optional[str]:
    """Run vlm_ocr.py as subprocess for a mixed page. Retries once on failure."""
    cmd = [sys.executable, str(vlm_script), page_image_path, "-o", output_path]

    logger.debug(f"VLM cmd: {' '.join(cmd)}")
    for attempt in range(MAX_RETRIES):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
                encoding="utf-8",
                errors="replace",
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr)

            if os.path.exists(output_path):
                with open(output_path, "r", encoding="utf-8") as f:
                    content = f.read()
                match = re.search(r"<PAGE 1>\s*(.*?)\s*</PAGE 1>", content, re.DOTALL)
                if match:
                    return match.group(1).strip()
                return content.strip()
            else:
                raise FileNotFoundError(f"VLM output not found: {output_path}")
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                logger.warning(f"VLM attempt {attempt + 1} failed: {e}, retrying...")
            else:
                logger.error(f"VLM failed after {MAX_RETRIES} attempts: {e}")
                return None
    return None


def _items_to_md(items: list) -> str:
    """Convert a list of all_pages.json items to markdown (same logic as call_ocr.py)."""
    md_parts = []
    for item in items:
        item_type = item.get("type", "")

        if item_type == "text":
            text = item.get("text", "")
            if not text:
                continue
            if item.get("text_level"):
                md_parts.append(f"# {text}")
            else:
                md_parts.append(text)

        elif item_type == "table":
            for cap in item.get("table_caption", []):
                md_parts.append(f"**{cap}**")
            table_body = item.get("table_body", "")
            if table_body:
                md_parts.append(table_body)
            for fn in item.get("table_footnote", []):
                md_parts.append(f"*{fn}*")

        elif item_type == "image":
            for cap in item.get("image_caption", []):
                md_parts.append(f"**{cap}**")
            content = item.get("content", "")
            if content:
                md_parts.append(content)
            for fn in item.get("image_footnote", []):
                md_parts.append(f"*{fn}*")

        elif item_type == "list":
            for li in item.get("list_items", []):
                md_parts.append(f"- {li}")

    return "\n\n".join(md_parts).strip()


def run_ocr_batch(
    ocr_script: str,
    pdf_path: str,
    ocr_page_numbers: List[int],
    tmp_dir: str,
) -> Dict[int, str]:
    """Merge OCR pages into one PDF, call OCR once, split result by page_idx.

    Args:
        ocr_script: Path to call_ocr.py
        pdf_path: Original PDF path
        ocr_page_numbers: List of 0-indexed page numbers classified as OCR
        tmp_dir: Temp directory for intermediate files

    Returns:
        Dict mapping original page_num -> markdown content, or empty dict on failure.
    """
    if not ocr_page_numbers:
        return {}

    logger.info(
        f"Batching {len(ocr_page_numbers)} OCR pages into a single API call..."
    )

    # 1. Merge pages into one PDF
    merged_pdf_path = os.path.join(tmp_dir, "ocr_batch.pdf")
    src_doc = fitz.open(pdf_path)
    merged_doc = fitz.open()
    for pn in ocr_page_numbers:
        merged_doc.insert_pdf(src_doc, from_page=pn, to_page=pn)
    merged_doc.save(merged_pdf_path)
    merged_doc.close()
    src_doc.close()

    # 2. Call call_ocr.py subprocess with --keep-zip
    batch_output_dir = os.path.join(tmp_dir, "ocr_batch_output")
    os.makedirs(batch_output_dir, exist_ok=True)

    cmd = [sys.executable, str(ocr_script), merged_pdf_path, "-o", batch_output_dir, "--keep-zip"]
    logger.info(f"OCR batch cmd: {' '.join(cmd)}")

    for attempt in range(MAX_RETRIES):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT * len(ocr_page_numbers),
                encoding="utf-8",
                errors="replace",
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr)
            break
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                logger.warning(f"OCR batch attempt {attempt + 1} failed: {e}, retrying...")
            else:
                logger.error(f"OCR batch failed after {MAX_RETRIES} attempts: {e}")
                return {}

    # 3. Read the ZIP with all_pages.json
    zip_path = os.path.join(batch_output_dir, "ocr_batch.zip")
    if not os.path.exists(zip_path):
        logger.error(f"OCR batch ZIP not found: {zip_path}")
        return {}

    try:
        with zipfile.ZipFile(zip_path, "r") as z:
            json_file = None
            for name in z.namelist():
                if name.endswith("all_pages.json"):
                    json_file = name
                    break
            if not json_file:
                logger.error("all_pages.json not found in ZIP")
                return {}
            with z.open(json_file) as f:
                all_items = json.load(f)
    except Exception as e:
        logger.error(f"Failed to read OCR batch ZIP: {e}")
        return {}

    # 4. Group items by page_idx
    pages_items: Dict[int, list] = {}
    for item in all_items:
        pidx = item.get("page_idx", 0)
        pages_items.setdefault(pidx, []).append(item)

    # 5. Map merged page_idx -> original page_num
    results = {}
    for merged_idx, original_pn in enumerate(ocr_page_numbers):
        items = pages_items.get(merged_idx, [])
        if items:
            results[original_pn] = _items_to_md(items)
        else:
            logger.warning(
                f"No OCR data for merged page {merged_idx} (original page {original_pn + 1})"
            )
            results[original_pn] = ""

    logger.info(
        f"OCR batch complete: {sum(1 for v in results.values() if v)} / {len(ocr_page_numbers)} pages extracted"
    )
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Smart PDF Parser - Intelligently parse PDF pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python smart_parse.py document.pdf
  python smart_parse.py document.pdf -o result.md
  python smart_parse.py document.pdf --image-area-threshold 0.30 -v
        """,
    )

    parser.add_argument("input", help="Path to input PDF file")
    parser.add_argument(
        "-o",
        "--output",
        help="Output markdown path (default: {filename}_smart.md)",
    )
    parser.add_argument(
        "--image-area-threshold",
        type=float,
        default=0.40,
        help="Image area ratio separating OCR from VLM; pages 5%% to this value use OCR, above use VLM (default: 0.40)",
    )
    parser.add_argument("--ocr-script", default=None, help="Path to call_ocr.py")
    parser.add_argument("--vlm-script", default=None, help="Path to vlm_ocr.py")
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable verbose logging"
    )
    parser.add_argument(
        "--classify-only",
        action="store_true",
        help="Only classify pages and print summary, then exit",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=2,
        help="Max concurrent VLM API calls (default: 2)",
    )

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    if not os.path.exists(args.input):
        logger.error(f"File not found: {args.input}")
        return 1

    if not args.input.lower().endswith(".pdf"):
        logger.error("Input must be a PDF file")
        return 1

    logger.info(f"Analyzing: {args.input}")
    pages = classify_pages(args.input, args.image_area_threshold)

    text_count = sum(1 for c, _, _ in pages if c == PAGE_TEXT)
    ocr_count = sum(1 for c, _, _ in pages if c == PAGE_OCR)
    vlm_count = sum(1 for c, _, _ in pages if c == PAGE_VLM)

    logger.info(
        f"Total: {len(pages)} pages "
        f"(text: {text_count}, ocr: {ocr_count}, vlm: {vlm_count})"
    )

    for classification, page_num, desc in pages:
        logger.info(f"  Page {page_num + 1}: {LABEL[classification]} ({desc})")

    if args.classify_only:
        api_pages = ocr_count + vlm_count
        timeout_min = api_pages * 10
        timeout_ms = timeout_min * 60 * 1000
        logger.info(
            f"Recommended timeout: {api_pages} API pages x 10min = "
            f"{timeout_min} minutes ({timeout_ms} ms)"
        )
        return 0

    ocr_script = args.ocr_script or str(DEFAULT_OCR_SCRIPT)
    vlm_script = args.vlm_script or str(DEFAULT_VLM_SCRIPT)

    if not os.path.exists(ocr_script):
        logger.error(f"OCR script not found: {ocr_script}")
        logger.error("Set --ocr-script or ensure ../ocr/scripts/call_ocr.py exists")
        return 1
    if not os.path.exists(vlm_script):
        logger.error(f"VLM script not found: {vlm_script}")
        logger.error(
            "Set --vlm-script or ensure ../vlm-image/scripts/vlm_ocr.py exists"
        )
        return 1

    if args.output:
        output_path = args.output
    else:
        stem = Path(args.input).stem
        output_path = str(Path(args.input).parent / f"{stem}_smart.md")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    tmp_dir = tempfile.mkdtemp(prefix="smart_parse_")

    try:
        results: Dict[int, str] = {}

        scan_output_dir = os.path.join(tmp_dir, "scan")
        os.makedirs(scan_output_dir, exist_ok=True)
        mix_output_dir = os.path.join(tmp_dir, "mix")
        os.makedirs(mix_output_dir, exist_ok=True)
        img_output_dir = os.path.join(tmp_dir, "images")
        os.makedirs(img_output_dir, exist_ok=True)

        ocr_page_numbers: List[int] = []
        vlm_tasks: List[Tuple[int, str, str, str]] = []

        for classification, page_num, desc in pages:
            page_idx = page_num + 1

            if classification == PAGE_TEXT:
                logger.info(
                    f"Processing page {page_idx}/{len(pages)} ({LABEL[classification]})..."
                )
                content = extract_text_page(args.input, page_num)
                results[page_num] = content

            elif classification == PAGE_OCR:
                ocr_page_numbers.append(page_num)

            elif classification == PAGE_VLM:
                page_img = os.path.join(img_output_dir, f"page_{page_idx:04d}.png")
                page_to_image(args.input, page_num, page_img)
                page_pdf = os.path.join(tmp_dir, f"page_{page_idx:04d}.pdf")
                extract_single_page_pdf(args.input, page_num, page_pdf)
                page_result_md = os.path.join(
                    mix_output_dir, f"page_{page_idx:04d}_result.md"
                )
                vlm_tasks.append((page_num, page_img, page_result_md, page_pdf))

        # --- OCR: batch all pages into one API call ---
        if ocr_page_numbers:
            logger.info(
                f"Processing {len(ocr_page_numbers)} OCR pages as a single batch..."
            )
            batch_results = run_ocr_batch(
                ocr_script, args.input, ocr_page_numbers, tmp_dir
            )
            if batch_results:
                for pn, content in batch_results.items():
                    if content:
                        results[pn] = content
                    else:
                        logger.warning(
                            f"Page {pn + 1} OCR returned empty, degrading to text..."
                        )
                        results[pn] = (
                            extract_text_page(args.input, pn)
                            or f"[Extraction failed for page {pn + 1}]"
                        )
            else:
                # Entire batch failed — degrade all to text
                logger.warning("OCR batch failed, degrading all OCR pages to text...")
                for pn in ocr_page_numbers:
                    results[pn] = (
                        extract_text_page(args.input, pn)
                        or f"[Extraction failed for page {pn + 1}]"
                    )

        def process_vlm_task(task):
            page_num, page_img, page_result_md, fallback_pdf = task
            page_idx = page_num + 1
            logger.info(
                f"Processing page {page_idx}/{len(pages)} ({LABEL[PAGE_VLM]})..."
            )

            content = run_vlm_subprocess(vlm_script, page_img, page_result_md)
            if not content:
                logger.warning(f"Page {page_idx} VLM failed, degrading to OCR...")
                content = run_ocr_subprocess(ocr_script, fallback_pdf, scan_output_dir)

            if not content:
                logger.warning(
                    f"Page {page_idx} API extraction failed, degrading to text..."
                )
                content = (
                    extract_text_page(args.input, page_num)
                    or f"[Extraction failed for page {page_idx}]"
                )

            return page_num, content

        if vlm_tasks:
            vlm_executor = ThreadPoolExecutor(max_workers=args.workers)
            try:
                vlm_futures = []
                future_to_page = {}
                for task in vlm_tasks:
                    future = vlm_executor.submit(process_vlm_task, task)
                    vlm_futures.append(future)
                    future_to_page[future] = task[0]  # page_num
                for future in as_completed(vlm_futures):
                    try:
                        page_num, content = future.result()
                        results[page_num] = content
                    except Exception as e:
                        pn = future_to_page[future]
                        logger.error(f"VLM task failed for page {pn + 1}: {e}")
                        results[pn] = f"[Extraction failed for page {pn + 1}]"
            finally:
                vlm_executor.shutdown(wait=True)

        md_lines = []
        for page_num in sorted(results.keys()):
            content = results[page_num]
            md_lines.append(f"<PAGE {page_num + 1}>")
            md_lines.append(content)
            md_lines.append(f"</PAGE {page_num + 1}>")
            md_lines.append("")

        md_content = "\n".join(md_lines)

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(md_content)

        logger.info(f"Output saved to: {output_path}")

        success_count = sum(
            1 for v in results.values() if not v.startswith("[Extraction failed")
        )
        logger.info(f"Done! {success_count}/{len(pages)} pages successfully processed.")

        return 0

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.debug(f"Cleaned up: {tmp_dir}")


if __name__ == "__main__":
    exit(main())
