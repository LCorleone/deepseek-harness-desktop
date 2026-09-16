#!/usr/bin/env python3
"""
SCMS API 客户端 - 统一的 API 调用接口
支持认证、错误处理、多种输出格式
"""

import sys
import os

if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import json
import csv
import argparse
from pathlib import Path
from typing import Dict, Any, Optional, List
from io import StringIO

import urllib3
import requests
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

load_dotenv()

API_BASE_URL = os.getenv("ROUTER_URL")
TOKEN = os.getenv("ROUTER_API_KEY")

if not API_BASE_URL:
    print(
        "错误: 未设置 ROUTER_URL 环境变量，请在 .env 文件中配置", file=sys.stderr
    )
    sys.exit(1)

if not TOKEN:
    print("错误: 未设置 ROUTER_API_KEY 环境变量，请在 .env 文件中配置", file=sys.stderr)
    sys.exit(1)


class SCMSClient:
    """SCMS API 客户端"""

    def __init__(self, token: Optional[str] = None):
        self.token = token or TOKEN
        self.session = requests.Session()
        self.session.headers.update(
            {
                "X-Router-Key": self.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

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

    def post(self, endpoint: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """发送 POST 请求"""
        url = f"{API_BASE_URL}/api/scms{endpoint}"
        try:
            response = self.session.post(url, json=data, verify=False)
            response.raise_for_status()
            result = response.json()

            code = result.get("code")
            if code != 10000:
                error_msg = result.get("message", "未知错误")
                print(f"API 错误 (code={code}): {error_msg}", file=sys.stderr)
                sys.exit(1)

            return result.get("data", {})
        except requests.exceptions.RequestException as e:
            print(f"请求失败: {self._safe_err(e)}", file=sys.stderr)
            sys.exit(1)


def format_output(data: Any, output_format: str = "json") -> str:
    """格式化输出"""
    if output_format == "json":
        return json.dumps(data, ensure_ascii=False, indent=2)
    elif output_format == "csv":
        return to_csv(data)
    else:
        raise ValueError(f"不支持的输出格式: {output_format}")


def to_csv(data: Any) -> str:
    """转换为 CSV 格式"""
    output = StringIO()

    if isinstance(data, dict):
        if "tableFields" in data and isinstance(data["tableFields"], list):
            table_fields = data["tableFields"]
            if len(table_fields) == 0:
                return ""

            base_fieldnames = list(table_fields[0].keys())
            all_keys = set()
            for item in table_fields:
                all_keys.update(item.keys())

            new_fieldnames = sorted(all_keys - set(base_fieldnames))
            fieldnames = base_fieldnames + new_fieldnames

            writer = csv.DictWriter(output, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(table_fields)
        elif len(data) == 1:
            key, value = next(iter(data.items()))
            return to_csv(value)
        else:
            writer = csv.DictWriter(output, fieldnames=list(data.keys()))
            writer.writeheader()
            writer.writerow(data)
    elif isinstance(data, list):
        if len(data) == 0:
            return ""

        if isinstance(data[0], dict):
            base_fieldnames = list(data[0].keys())
            all_keys = set()
            for item in data:
                all_keys.update(item.keys())

            new_fieldnames = sorted(all_keys - set(base_fieldnames))
            fieldnames = base_fieldnames + new_fieldnames

            writer = csv.DictWriter(output, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(data)
        else:
            writer = csv.writer(output)
            for item in data:
                writer.writerow([item])
    else:
        return str(data)

    return output.getvalue()


def parse_args(description: str) -> argparse.ArgumentParser:
    """创建通用参数解析器"""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--format", choices=["json", "csv"], default="json", help="输出格式"
    )
    return parser


if __name__ == "__main__":
    print("SCMS API 客户端模块")
    print("使用方式: from api_client import SCMSClient")
