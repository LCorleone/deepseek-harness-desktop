#!/usr/bin/env python3
"""
VLM OCR - Document OCR using Vision Language Model
Supports image and PDF files with async batch processing
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
import asyncio
import base64
import json
import logging
import mimetypes
import re
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import aiohttp
import fitz
import requests
from dotenv import load_dotenv
from PIL import Image

load_dotenv()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

VLM_EXTRACT_PROMPT = """
# 任务：提取图片中的所有信息
# 要求：
1、提取图片的所有图表，用表格输出，请全量提取，不能用省略号替代
2、提取图片中的文字段落，请全量提取，不能用省略号替代
3、提取其他信息，请全量提取，不能用省略号替代
4、图表文本信息必须全量提取，不能用省略号替代
5、所有信息不允许省略，必须全量提取"""

DEFAULT_TMP_FOLDER = "/tmp/vlm_ocr"


def get_vlm_config(api_key=None, api_url=None):
    """Get VLM configuration with priority: CLI args > Environment > Error if missing"""
    env_router_url = os.environ.get("ROUTER_URL")
    env_router_key = os.environ.get("ROUTER_API_KEY")

    final_router_url = api_url or env_router_url
    final_router_key = api_key or env_router_key

    if not final_router_key:
        print("错误: 未设置 ROUTER_API_KEY 环境变量", file=sys.stderr)
        sys.exit(1)

    if not final_router_url:
        print("错误: 未设置 ROUTER_URL 环境变量", file=sys.stderr)
        sys.exit(1)

    return {
        "API_URL": f"{final_router_url}/api/vlm/chat/completions",
        "ROUTER_KEY": final_router_key,
        "MODEL": os.environ.get("VLM_MODEL_NAME", ""),
    }


def resize_image(
    image_path: str, new_width: int = 2000, new_height: int = 2000
) -> Optional[str]:
    try:
        image = Image.open(image_path)
        folder_name = os.path.dirname(image_path)
        img_name = os.path.basename(image_path).split(".")[0]
        _, ext = os.path.splitext(image_path)

        save_path = os.path.join(folder_name, f"{img_name}_resize{ext}")
        resized_image = image.resize((new_width, new_height), Image.LANCZOS)
        resized_image.save(save_path, quality=100)
        return save_path
    except (OSError, IOError) as e:
        logger.error(f"Failed to resize image {image_path}: {e}")
        return None


def image_to_base64(image_path: str) -> Optional[str]:
    try:
        with open(image_path, "rb") as image_file:
            encoded_string = base64.b64encode(image_file.read())
            return encoded_string.decode("utf-8")
    except (OSError, IOError) as e:
        logger.error(f"Failed to convert image to base64 {image_path}: {e}")
        return None


class VLM:
    """Vision Language Model client with sync and async support"""

    def __init__(self, config: dict, retry: int = 2):
        self.url: str = config.get("API_URL", "")
        self.router_key: str = config.get("ROUTER_KEY", "")
        self.model: str = config.get("MODEL", "")
        self.retry_cnt: int = retry

        self.headers: dict = {
            "X-Router-Key": self.router_key,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _safe_err(e: Exception) -> str:
        """将异常转换为安全的错误消息"""
        name = type(e).__name__
        return {
            "ConnectionError": "连接失败",
            "Timeout": "超时",
            "ConnectTimeout": "超时",
            "ReadTimeout": "超时",
            "HTTPError": "服务器错误",
            "SSLError": "SSL 错误",
            "ClientError": "请求失败",
            "ClientConnectionError": "连接失败",
            "ClientPayloadError": "数据错误",
        }.get(name, "请求失败")

    def _prepare_images(self, img_paths: List[str]) -> List[str]:
        imgs_base64 = []
        for img_path in img_paths:
            resized_path = resize_image(img_path)
            if resized_path:
                img_base64 = image_to_base64(resized_path)
                if img_base64:
                    imgs_base64.append(img_base64)
        return imgs_base64

    def _build_payload(self, prompt: str, imgs_base64: List[str]) -> str:
        content = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{img_base64}"},
            }
            for img_base64 in imgs_base64
        ]
        content.append({"type": "text", "text": prompt})

        return json.dumps(
            {
                "model": self.model,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.01,
                "stream": False,
            }
        )

    def _parse_response(self, response_text: str) -> Optional[str]:
        try:
            answer_json = json.loads(response_text)
            return answer_json["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            logger.error(f"Failed to parse response: {e}")
            return None

    def call(
        self, prompt: str, img_paths: List[str], timeout: int = 600
    ) -> Optional[str]:
        imgs_base64 = self._prepare_images(img_paths)
        if not imgs_base64:
            return None

        payload = self._build_payload(prompt, imgs_base64)

        for attempt in range(self.retry_cnt):
            try:
                response = requests.post(
                    self.url, headers=self.headers, data=payload, timeout=timeout
                )
                result = self._parse_response(response.text)
                if result:
                    return result
            except requests.RequestException as e:
                logger.warning(
                    f"Request failed (attempt {attempt + 1}/{self.retry_cnt}): {self._safe_err(e)}"
                )
                if attempt == self.retry_cnt - 1:
                    return None

        return None

    async def acall(
        self,
        prompt: str,
        img_paths: List[str],
        session: Optional[aiohttp.ClientSession] = None,
        timeout: int = 600,
    ) -> Optional[str]:
        imgs_base64 = self._prepare_images(img_paths)
        if not imgs_base64:
            return None

        payload = self._build_payload(prompt, imgs_base64)

        own_session = session is None
        if own_session:
            session = aiohttp.ClientSession()

        try:
            for attempt in range(self.retry_cnt):
                try:
                    async with session.post(
                        self.url,
                        headers=self.headers,
                        data=payload,
                        timeout=aiohttp.ClientTimeout(total=timeout),
                    ) as response:
                        answer_text = await response.text()
                        result = self._parse_response(answer_text)
                        if result:
                            return result
                except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                    logger.warning(
                        f"Async request failed (attempt {attempt + 1}/{self.retry_cnt}): {self._safe_err(e)}"
                    )
                    if attempt < self.retry_cnt - 1:
                        await asyncio.sleep(0.1)
        finally:
            if own_session:
                await session.close()

        return None


def guess_file_type(file_path: str) -> Optional[str]:
    if not os.path.exists(file_path):
        logger.error(f"File does not exist: {file_path}")
        return None

    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type:
        if mime_type.startswith("image/"):
            return "image"
        elif mime_type == "application/pdf":
            return "pdf"

    ext = os.path.splitext(file_path)[1].lower()
    image_exts = {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".bmp",
        ".tiff",
        ".webp",
        ".svg",
        ".ico",
    }
    pdf_exts = {".pdf"}

    if ext in image_exts:
        return "image"
    elif ext in pdf_exts:
        return "pdf"

    logger.error(f"Unknown file type: {file_path}")
    return None


def find_pdfs_in_directory(directory: str) -> List[str]:
    pdf_files = []
    if not os.path.isdir(directory):
        logger.error(f"Path is not a directory: {directory}")
        return pdf_files

    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(".pdf"):
                pdf_files.append(os.path.join(root, file))

    logger.info(f"Found {len(pdf_files)} PDF files in {directory}")
    return sorted(pdf_files)


def pdf_to_images(
    pdf_path: str, output_dir: str, rotation_angle: int = 0, dpi: int = 300
) -> List[str]:
    pdf_document = fitz.open(pdf_path)
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]

    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    save_folder = os.path.join(output_dir, base_name)
    if not os.path.exists(save_folder):
        os.makedirs(save_folder)

    zoom_x = dpi / 72.0
    zoom_y = dpi / 72.0
    mat = fitz.Matrix(zoom_x, zoom_y)

    img_paths = []
    for page_num in range(len(pdf_document)):
        page = pdf_document.load_page(page_num)
        pix = page.get_pixmap(matrix=mat)

        image_path = os.path.join(save_folder, f"{page_num + 1}.png")
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        img.save(image_path)
        img_paths.append(image_path)

    pdf_document.close()
    logger.info(f"Converted PDF to {len(img_paths)} images")
    return img_paths


class VLM_OCR:
    """VLM-based OCR processor for documents"""

    def __init__(
        self,
        file_path: str,
        vlm_client: Optional[VLM] = None,
        tmp_folder: Optional[str] = None,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
    ):
        self.file_path = file_path
        self.file_type = guess_file_type(file_path)

        if vlm_client:
            self.vlm_client = vlm_client
        else:
            config = get_vlm_config(api_key=api_key, api_url=api_url)
            self.vlm_client = VLM(config=config)

        if tmp_folder:
            self.tmp_folder = tmp_folder
        else:
            file_dir = os.path.dirname(file_path) if os.path.dirname(file_path) else "."
            self.tmp_folder = os.path.join(file_dir, ".vlm_ocr_tmp")

    def call(self, model_name: str = "vlm") -> Optional[str]:
        ocr_text = ""

        if model_name == "vlm":
            if self.file_type == "image":
                img_paths = [self.file_path]
            elif self.file_type == "pdf":
                img_paths = pdf_to_images(
                    self.file_path, os.path.join(self.tmp_folder, "pdf2imgs")
                )
            else:
                logger.error(f"Invalid file type: {self.file_path}")
                return None

            for page, img_path in enumerate(img_paths):
                logger.info(f"Processing page {page + 1}: {img_path}")
                vlm_res = self.vlm_client.call(VLM_EXTRACT_PROMPT, [img_path])
                if vlm_res:
                    ocr_text += (
                        f"\n<PAGE {page + 1}>\n" + vlm_res + f"\n</PAGE {page + 1}>"
                    )
                else:
                    logger.error(f"OCR returned None for: {img_path}")

        elif model_name == "mineru":
            logger.warning("MinerU not implemented yet")
            pass

        return ocr_text

    async def acall(self, model_name: str = "vlm") -> Optional[str]:
        ocr_text = ""

        if model_name == "vlm":
            if self.file_type == "image":
                img_paths = [self.file_path]
            elif self.file_type == "pdf":
                img_paths = pdf_to_images(
                    self.file_path, os.path.join(self.tmp_folder, "pdf2imgs")
                )
            else:
                logger.error(f"Invalid file type: {self.file_path}")
                return None

            tasks = []
            for img_path in img_paths:
                logger.info(f"Queuing async OCR: {img_path}")
                task = self.vlm_client.acall(VLM_EXTRACT_PROMPT, [img_path])
                tasks.append(task)

            results = await asyncio.gather(*tasks, return_exceptions=True)

            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    logger.error(f"OCR failed for {img_paths[i]}: {result}")
                elif result:
                    ocr_text += f"\n<PAGE {i + 1}>\n" + result + f"\n</PAGE {i + 1}>"
                else:
                    logger.error(f"OCR returned None for: {img_paths[i]}")

        elif model_name == "mineru":
            logger.warning("MinerU not implemented yet")

        return ocr_text

    async def acall_batch(
        self, model_name: str = "vlm", batch_size: int = 2
    ) -> Optional[str]:
        ocr_text = ""

        if model_name == "vlm":
            if self.file_type == "image":
                img_paths = [self.file_path]
            elif self.file_type == "pdf":
                img_paths = pdf_to_images(
                    self.file_path, os.path.join(self.tmp_folder, "pdf2imgs")
                )
            else:
                logger.error(f"Invalid file type: {self.file_path}")
                return None

            for i in range(0, len(img_paths), batch_size):
                batch = img_paths[i : i + batch_size]
                tasks = []

                for img_path in batch:
                    logger.info(f"Queuing batch OCR: {img_path}")
                    task = self.vlm_client.acall(VLM_EXTRACT_PROMPT, [img_path])
                    tasks.append(task)

                batch_results = await asyncio.gather(*tasks, return_exceptions=True)

                for j, result in enumerate(batch_results):
                    img_path = batch[j]
                    if isinstance(result, Exception):
                        logger.error(f"Batch OCR failed for {img_path}: {result}")
                    elif result:
                        ocr_text += (
                            f"\n<PAGE {i + j + 1}>\n"
                            + result
                            + f"\n</PAGE {i + j + 1}>"
                        )
                    else:
                        logger.error(f"Batch OCR returned None for: {img_path}")

        return ocr_text


def save_to_markdown(content: str, output_path: str) -> None:
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(content)
        logger.info(f"Result saved to: {output_path}")
    except IOError as e:
        logger.error(f"Failed to save file: {e}")


def main():
    """Main entry point for command line usage"""
    parser = argparse.ArgumentParser(
        description="VLM OCR - Extract text from images and PDFs using Vision Language Model",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Single file
  %(prog)s document.pdf
  %(prog)s image.png
  %(prog)s document.pdf --batch-size 3
  %(prog)s scan.pdf --output custom_result.md

  # Directory (process all PDFs)
  %(prog)s ./pdf_folder
  %(prog)s ./pdf_folder --output ./results
        """,
    )
    parser.add_argument(
        "file", help="Path to input PDF/image file or directory containing PDFs"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=2,
        help="Number of concurrent OCR requests (default: 2)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Output path (file for single input, directory for folder input)",
    )
    parser.add_argument(
        "--api-key",
        help="Router API key (or set ROUTER_API_KEY env var)",
    )
    parser.add_argument(
        "--api-url",
        help="Router URL (or set ROUTER_URL env var)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable verbose logging"
    )
    parser.add_argument(
        "--sync",
        action="store_true",
        help="Use synchronous processing instead of async",
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if not os.path.exists(args.file):
        logger.error(f"Input path does not exist: {args.file}")
        return 1

    is_directory = os.path.isdir(args.file)

    if is_directory:
        pdf_files = find_pdfs_in_directory(args.file)

        if not pdf_files:
            logger.error(f"No PDF files found in directory: {args.file}")
            return 1

        if args.output:
            output_dir = args.output
        else:
            input_path = Path(args.file)
            output_dir = str(input_path.parent / f"{input_path.name}_result")

        os.makedirs(output_dir, exist_ok=True)
        logger.info(f"Output directory: {output_dir}")

        logger.info(f"Starting batch OCR processing for {len(pdf_files)} PDFs")
        start_time = datetime.now()

        success_count = 0
        failed_count = 0

        for idx, pdf_file in enumerate(pdf_files, 1):
            try:
                logger.info(f"[{idx}/{len(pdf_files)}] Processing: {pdf_file}")
                pdf_name = Path(pdf_file).stem
                output_path = os.path.join(output_dir, f"{pdf_name}_result.md")

                ocr_instance = VLM_OCR(
                    pdf_file, api_key=args.api_key, api_url=args.api_url
                )
                os.makedirs(ocr_instance.tmp_folder, exist_ok=True)

                if args.sync:
                    result = ocr_instance.call("vlm")
                else:
                    result = asyncio.run(
                        ocr_instance.acall_batch("vlm", batch_size=args.batch_size)
                    )

                if result:
                    save_to_markdown(result, output_path)
                    logger.info(f"[{idx}/{len(pdf_files)}] Saved: {output_path}")
                    success_count += 1
                else:
                    logger.error(f"[{idx}/{len(pdf_files)}] Failed: {pdf_file}")
                    failed_count += 1

            except Exception as e:
                logger.error(f"[{idx}/{len(pdf_files)}] Error processing {pdf_file}")
                failed_count += 1

        elapsed_time = datetime.now() - start_time
        logger.info(
            f"Batch OCR completed in {elapsed_time.total_seconds():.2f} seconds"
        )
        logger.info(f"Success: {success_count}, Failed: {failed_count}")

        print(f"\n✓ Batch OCR completed!")
        print(f"✓ Output directory: {output_dir}")
        print(f"✓ Success: {success_count}, Failed: {failed_count}")
        return 0 if failed_count == 0 else 1

    else:
        file_type = guess_file_type(args.file)
        if file_type not in ["pdf", "image"]:
            logger.error(f"Unsupported file type: {args.file}")
            return 1

        if args.output:
            output_path = args.output
        else:
            input_path = Path(args.file)
            output_path = str(input_path.parent / f"{input_path.stem}_result.md")

        logger.info(f"Starting OCR processing: {args.file}")
        start_time = datetime.now()

        try:
            ocr_instance = VLM_OCR(
                args.file, api_key=args.api_key, api_url=args.api_url
            )
            os.makedirs(ocr_instance.tmp_folder, exist_ok=True)

            if args.sync:
                result = ocr_instance.call("vlm")
            else:
                result = asyncio.run(
                    ocr_instance.acall_batch("vlm", batch_size=args.batch_size)
                )

            elapsed_time = datetime.now() - start_time
            logger.info(f"OCR completed in {elapsed_time.total_seconds():.2f} seconds")

            if result:
                save_to_markdown(result, output_path)
                print(f"\n✓ OCR completed successfully!")
                print(f"✓ Result saved to: {output_path}")
                return 0
            else:
                logger.error("OCR processing failed - no result returned")
                return 1

        except Exception as e:
            logger.error(f"OCR processing failed", exc_info=args.verbose)
            return 1


if __name__ == "__main__":
    exit(main())
