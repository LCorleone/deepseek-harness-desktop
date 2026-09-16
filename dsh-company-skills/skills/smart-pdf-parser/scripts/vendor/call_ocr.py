#!/usr/bin/env python3
"""
OCR File Processing Tool
A command-line tool for batch processing PDF files with OCR service.

VENDED COPY (#043 D5, drift risk): this file was copied verbatim from the
`ocr` skill (scripts/call_ocr.py) into smart-pdf-parser because the skill
executor stages each skill in its own private directory and the source tree's
../../ocr sibling lookup cannot resolve there. It will NOT track future edits
to the `ocr` skill — re-vendor (and re-review) whenever that skill changes.
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
import time
import urllib3
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


@dataclass
class OCRConfig:
    """Configuration for OCR service."""

    base_url: str = ""
    router_key: str = ""
    callback_flag: str = "0"
    poll_interval: int = 20
    max_retries: int = 60
    timeout: int = 300

    def __post_init__(self):
        if not self.base_url:
            self.base_url = os.getenv("ROUTER_URL", "")
        if not self.router_key:
            self.router_key = os.getenv("ROUTER_API_KEY", "")

    @property
    def upload_url(self) -> str:
        return f"{self.base_url}/api/ocr/callOcrFileParse"

    @property
    def query_url_template(self) -> str:
        return f"{self.base_url}/api/ocr/queryStatus/{{}}"

    @property
    def download_url_template(self) -> str:
        return f"{self.base_url}/api/ocr/download/{{}}"


@dataclass
class TaskInfo:
    """Task information for tracking."""

    file_id: str
    path: str
    completed: bool = False


class OCRProcessor:
    """OCR file processor."""

    def __init__(self, config: OCRConfig):
        self.config = config

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
        }.get(name, "请求失败")

    def upload_file(self, file_path: str) -> Optional[str]:
        """Upload a file and return the file_id."""
        if not os.path.exists(file_path):
            logger.error(f"File not found: {file_path}")
            return None

        file_info = {
            "callbackFlag": self.config.callback_flag,
        }

        files = {
            "file": open(file_path, "rb"),
            "fileInfo": (None, json.dumps(file_info), "application/json"),
        }
        headers = {"X-Router-Key": self.config.router_key}

        try:
            time.sleep(2)
            logger.info(f"Uploading: {file_path}")
            response = requests.post(
                self.config.upload_url,
                files=files,
                headers=headers,
                verify=False,
                timeout=self.config.timeout,
            )
            response.raise_for_status()
            res_json = response.json()

            if res_json.get("code") == 200 and res_json.get("data"):
                file_id = res_json["data"]
                logger.info(f"Upload successful, File ID: {file_id}")
                return file_id
            else:
                logger.error(f"Upload failed, response: {res_json}")
                return None

        except Exception as e:
            logger.error(f"Upload exception: {self._safe_err(e)}")
            return None
        finally:
            files["file"].close()

    def query_status(self, file_id: str) -> bool:
        """Query the status of the file. Returns True if completed."""
        url = self.config.query_url_template.format(file_id)
        headers = {"X-Router-Key": self.config.router_key}
        try:
            response = requests.post(url, headers=headers, verify=False, timeout=self.config.timeout)
            if response.status_code == 200:
                res_json = response.json()

                if res_json.get("code") == "200" and (
                    res_json.get("message") == "Completed"
                    or res_json.get("bizStatus") == 5
                ):
                    return True
                return False
            return False
        except Exception as e:
            logger.error(f"Query exception: {self._safe_err(e)}")
            return False

    def wait_for_completion(self, file_id: str) -> bool:
        """Wait for file processing to complete with smart polling."""
        poll_interval = self.config.poll_interval
        attempt = 0

        while attempt < self.config.max_retries:
            if self.query_status(file_id):
                logger.info(f"File processing completed (ID: {file_id})")
                return True

            attempt += 1
            if attempt < self.config.max_retries:
                logger.info(
                    f"Waiting {poll_interval} seconds before next query... (Attempt {attempt}/{self.config.max_retries})"
                )
                time.sleep(poll_interval)

        logger.error(
            f"File processing timeout after {self.config.max_retries} attempts"
        )
        return False

    def download_file(
        self, file_id: str, save_path: str, rename_to: Optional[str] = None
    ) -> Optional[str]:
        """Download the file to save_path. Returns the downloaded filepath or None."""
        url = self.config.download_url_template.format(file_id)
        headers = {"X-Router-Key": self.config.router_key}
        try:
            response = requests.get(
                url, headers=headers, stream=True, verify=False, timeout=self.config.timeout
            )
            if response.status_code != 200:
                logger.error(
                    f"Download failed File ID {file_id}, Status: {response.status_code}"
                )
                return None

            content_disposition = response.headers.get("Content-Disposition", "")
            default_filename = f"ocr_file_{file_id}.zip"

            if "filename=" in content_disposition:
                filename = content_disposition.split("filename=")[1].strip("\"'")
            else:
                filename = default_filename

            if rename_to:
                filename = rename_to

            if os.path.isdir(save_path):
                filepath = os.path.join(save_path, filename)
            else:
                filepath = save_path

            os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)

            total_size = int(response.headers.get("content-length", 0))
            with tqdm(
                total=total_size,
                unit="B",
                unit_scale=True,
                desc=f"Downloading {filename}",
            ) as pbar:
                with open(filepath, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            pbar.update(len(chunk))

            logger.info(f"Download completed: {filepath}")
            return filepath

        except Exception as e:
            logger.error(f"Download exception: {self._safe_err(e)}")
            return None

    @staticmethod
    def extract_and_generate_md(zip_path: str, output_md_path: str) -> bool:
        """Extract all_pages.json from zip and generate a markdown file."""
        try:
            with zipfile.ZipFile(zip_path, "r") as z:
                if "all_pages.json" not in z.namelist():
                    json_file = None
                    for name in z.namelist():
                        if name.endswith("all_pages.json"):
                            json_file = name
                            break
                    if not json_file:
                        logger.error(f"Error: all_pages.json not found in {zip_path}")
                        return False
                else:
                    json_file = "all_pages.json"

                with z.open(json_file) as f:
                    data = json.load(f)

            md_content = ""
            for item in data:
                item_type = item.get("type", "")

                if item_type == "text":
                    text = item.get("text", "")
                    if not text:
                        continue
                    if item.get("text_level"):
                        md_content += f"# {text}\n\n"
                    else:
                        md_content += text + "\n\n"

                elif item_type == "table":
                    for cap in item.get("table_caption", []):
                        md_content += f"**{cap}**\n\n"
                    table_body = item.get("table_body", "")
                    if table_body:
                        md_content += table_body + "\n\n"
                    for fn in item.get("table_footnote", []):
                        md_content += f"*{fn}*\n\n"

                elif item_type == "image":
                    for cap in item.get("image_caption", []):
                        md_content += f"**{cap}**\n\n"
                    content = item.get("content", "")
                    if content:
                        md_content += content + "\n\n"
                    for fn in item.get("image_footnote", []):
                        md_content += f"*{fn}*\n\n"

                elif item_type == "list":
                    for li in item.get("list_items", []):
                        md_content += f"- {li}\n"
                    md_content += "\n"

            with open(output_md_path, "w", encoding="utf-8") as f:
                f.write(md_content)

            logger.info(f"Markdown file generated: {output_md_path}")
            return True

        except Exception as e:
            logger.error(f"Exception processing Zip file {zip_path}: {e}")
            return False

    def process_single_file(
        self, file_path: str, output_dir: Optional[str] = None, keep_zip: bool = False
    ) -> bool:
        """Handle single PDF file processing.

        Output naming: {filename}_markdown.md
        Cleanup: Deletes the downloaded ZIP file after generating MD (unless keep_zip=True)
        """
        if not file_path.lower().endswith(".pdf"):
            logger.error("Error: Input file is not a PDF.")
            return False

        file_id = self.upload_file(file_path)
        if not file_id:
            return False

        if not self.wait_for_completion(file_id):
            return False

        if output_dir:
            file_dir = output_dir
            os.makedirs(file_dir, exist_ok=True)
        else:
            file_dir = os.path.dirname(file_path)

        original_filename = os.path.basename(file_path)
        name_without_ext = os.path.splitext(original_filename)[0]

        zip_filename = f"{name_without_ext}.zip"
        downloaded_path = self.download_file(file_id, file_dir, rename_to=zip_filename)

        if downloaded_path:
            try:
                md_filename = f"{name_without_ext}_markdown.md"
                md_path = os.path.join(file_dir, md_filename)
                success = self.extract_and_generate_md(downloaded_path, md_path)

                if success and not keep_zip:
                    try:
                        os.remove(downloaded_path)
                        logger.info(f"Deleted intermediate ZIP file: {downloaded_path}")
                    except Exception as e:
                        logger.warning(
                            f"Failed to delete ZIP file {downloaded_path}: {e}"
                        )

                return success
            except Exception as e:
                logger.error(f"Error processing file: {e}")
                return False

        return False

    def load_tasks_from_file(
        self, file_id_record_path: str
    ) -> Tuple[Dict[str, TaskInfo], Dict[str, str]]:
        """Load tasks from fileid.txt for resumption."""
        existing_file_ids = {}
        tasks = {}

        if os.path.exists(file_id_record_path):
            logger.info("Detected fileid.txt, attempting to resume tasks...")
            try:
                with open(file_id_record_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if "|" in line:
                            fid, fpath = line.split("|", 1)
                            existing_file_ids[fpath] = fid
                            tasks[fid] = TaskInfo(
                                file_id=fid, path=fpath, completed=False
                            )
                logger.info(f"Loaded {len(tasks)} existing tasks.")
            except Exception as e:
                logger.error(f"Failed to read fileid.txt: {e}")

        return tasks, existing_file_ids

    def save_task_to_file(
        self, file_id: str, file_path: str, file_id_record_path: str
    ) -> None:
        """Save task to fileid.txt."""
        try:
            with open(file_id_record_path, "a", encoding="utf-8") as f:
                f.write(f"{file_id}|{file_path}\n")
                f.flush()
        except Exception as e:
            logger.error(f"Failed to save task to fileid.txt: {e}")

    def clear_tasks_file(self, file_id_record_path: str) -> None:
        """Clear the tasks file."""
        try:
            with open(file_id_record_path, "w", encoding="utf-8") as f:
                pass
            logger.info(f"Cleared fileid.txt: {file_id_record_path}")
        except Exception as e:
            logger.error(f"Failed to clear fileid.txt: {e}")

    def process_directory(
        self,
        dir_path: str,
        output_dir: Optional[str] = None,
        skip_existing: bool = False,
    ) -> bool:
        """Handle directory processing.

        Output folder: {folder_name}_result
        MD naming: {filename}_markdown.md
        Cleanup: Deletes all intermediate ZIP files
        """
        dir_path = os.path.normpath(dir_path)

        file_id_record_path = os.path.join(dir_path, "fileid.txt")
        files_to_process = []

        if output_dir:
            output_dir_name = output_dir
        else:
            folder_name = os.path.basename(dir_path)
            output_dir_name = f"{folder_name}_result"
            output_dir = os.path.join(os.path.dirname(dir_path), output_dir_name)

        exclude_dir = output_dir
        for root, dirs, files in os.walk(dir_path):
            if os.path.basename(exclude_dir) in dirs:
                dirs.remove(os.path.basename(exclude_dir))

            for file in files:
                if not file.lower().endswith(".pdf"):
                    continue

                files_to_process.append(os.path.join(root, file))

        logger.info(f"Found {len(files_to_process)} files to process.")

        if not files_to_process:
            logger.info("Directory is empty.")
            return False

        tasks, existing_file_ids = self.load_tasks_from_file(file_id_record_path)

        logger.info("Starting to check and upload files...")
        for file_path in tqdm(files_to_process, desc="Uploading files"):
            if file_path in existing_file_ids:
                logger.debug(
                    f"Skipping already uploaded file: {os.path.basename(file_path)}"
                )
                continue

            file_id = self.upload_file(file_path)
            if file_id:
                tasks[file_id] = TaskInfo(
                    file_id=file_id, path=file_path, completed=False
                )
                self.save_task_to_file(file_id, file_path, file_id_record_path)

        if not tasks:
            logger.info("No files to process.")
            return False

        logger.info("Starting to poll status...")
        completed_count = 0

        with tqdm(total=len(tasks), desc="Processing files") as pbar:
            while completed_count < len(tasks):
                completed_count = 0
                for file_id, task in tasks.items():
                    if not task.completed:
                        if self.query_status(file_id):
                            task.completed = True
                            logger.info(
                                f"File processing completed: {os.path.basename(task.path)}"
                            )
                            completed_count += 1
                            pbar.update(1)
                    else:
                        completed_count += 1

                if completed_count < len(tasks):
                    logger.info(f"Waiting {self.config.poll_interval} seconds...")
                    time.sleep(self.config.poll_interval)

        logger.info("All files processing completed.")

        logger.info(f"Starting to download results to: {output_dir}")
        os.makedirs(output_dir, exist_ok=True)

        success_count = 0
        downloaded_zip_files = []

        for file_id, task in tqdm(tasks.items(), desc="Downloading results"):
            original_path = task.path
            original_filename = os.path.basename(original_path)
            name_without_ext = os.path.splitext(original_filename)[0]

            zip_filename = f"{name_without_ext}.zip"
            downloaded_path = self.download_file(
                file_id, output_dir, rename_to=zip_filename
            )

            if downloaded_path:
                downloaded_zip_files.append(downloaded_path)

                md_filename = f"{name_without_ext}_markdown.md"
                md_path = os.path.join(output_dir, md_filename)
                if self.extract_and_generate_md(downloaded_path, md_path):
                    success_count += 1

        logger.info("Cleaning up intermediate ZIP files...")
        cleanup_count = 0
        for zip_file in downloaded_zip_files:
            try:
                if os.path.exists(zip_file):
                    os.remove(zip_file)
                    logger.debug(f"Deleted: {zip_file}")
                    cleanup_count += 1
            except Exception as e:
                logger.warning(f"Failed to delete {zip_file}: {e}")

        logger.info(f"Deleted {cleanup_count} intermediate ZIP files.")
        logger.info(f"Successfully processed {success_count}/{len(tasks)} files.")
        logger.info(f"Results saved to: {output_dir}")

        self.clear_tasks_file(file_id_record_path)

        return success_count == len(tasks)


def main():
    """Main entry point for command-line interface."""
    parser = argparse.ArgumentParser(
        description="OCR File Processing Tool - Batch process PDF files with OCR service",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process a single file (output: document_markdown.md)
  python call_ocr.py /path/to/document.pdf

  # Process all PDFs in a directory (output: foldername_result/ at same level)
  python call_ocr.py /path/to/directory

  # Process with custom output directory
  python call_ocr.py /path/to/directory -o /output/path

  # Set polling interval to 30 seconds
  python call_ocr.py /path/to/directory --poll-interval 30

  # Enable debug logging
  python call_ocr.py /path/to/directory --verbose

Output naming:
  Single file: {filename}_markdown.md (in same directory as input file)
  Directory:  {foldername}_result/{filename}_markdown.md (at same level as input directory)
  Note: All intermediate ZIP files are automatically deleted.
        """,
    )

    parser.add_argument(
        "input_path", help="Path to a PDF file or directory containing PDF files"
    )

    parser.add_argument(
        "-o",
        "--output",
        dest="output_dir",
        help="Output directory for processed files (default: for directory: {foldername}_result at same level as input directory)",
    )

    parser.add_argument(
        "--api-url",
        dest="api_url",
        help="API base URL for OCR service (or set ROUTER_URL environment variable)",
    )

    parser.add_argument(
        "--poll-interval",
        dest="poll_interval",
        type=int,
        default=20,
        help="Polling interval in seconds (default: 20)",
    )

    parser.add_argument(
        "--max-retries",
        dest="max_retries",
        type=int,
        default=60,
        help="Maximum number of polling retries (default: 60)",
    )

    parser.add_argument(
        "--timeout",
        dest="timeout",
        type=int,
        default=300,
        help="Request timeout in seconds (default: 300)",
    )

    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable verbose (debug) logging"
    )
    parser.add_argument(
        "--keep-zip", action="store_true", help="Keep intermediate ZIP file after generating markdown"
    )

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    if not os.path.exists(args.input_path):
        logger.error(f"Path not found: {args.input_path}")
        return 1

    config = OCRConfig(
        base_url=args.api_url or "",
        router_key="",
        poll_interval=args.poll_interval,
        max_retries=args.max_retries,
        timeout=args.timeout,
    )

    if not config.base_url:
        logger.error(
            "错误: 未设置 ROUTER_URL 环境变量，请在 .env 文件中配置或使用 --api-url 参数"
        )
        return 1

    if not config.router_key:
        logger.error(
            "错误: 未设置 ROUTER_API_KEY 环境变量，请在 .env 文件中配置"
        )
        return 1

    processor = OCRProcessor(config)

    if os.path.isfile(args.input_path):
        logger.info("Detected input as file mode.")
        success = processor.process_single_file(args.input_path, args.output_dir, keep_zip=args.keep_zip)
    elif os.path.isdir(args.input_path):
        logger.info("Detected input as directory mode.")
        success = processor.process_directory(args.input_path, args.output_dir)
    else:
        logger.error("Invalid path, please check input.")
        return 1

    return 0 if success else 1


if __name__ == "__main__":
    exit(main())
