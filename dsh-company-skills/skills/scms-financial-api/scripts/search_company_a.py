#!/usr/bin/env python3
"""
A股公司搜索 - 通过关键词获取同花顺代码
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
from api_client import SCMSClient, format_output, parse_args


def search_company_a(keyword: str, size: int = 10) -> dict:
    """
    搜索 A 股公司

    Args:
        keyword: 搜索关键词（公司名、拼音首字母、股票代码）
        size: 返回数据条数

    Returns:
        公司列表数据
    """
    client = SCMSClient()
    endpoint = "/api/tracker/get_company_list_by_fuzzy"
    data = {"keyword": keyword, "size": size}
    return client.post(endpoint, data)


def main():
    parser = parse_args("搜索 A 股公司，获取同花顺代码")
    parser.add_argument("keyword", help="搜索关键词")
    parser.add_argument("--size", type=int, default=10, help="返回数据条数")
    args = parser.parse_args()

    result = search_company_a(args.keyword, args.size)
    print(format_output(result, args.format))


if __name__ == "__main__":
    main()
