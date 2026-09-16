#!/usr/bin/env python3
"""
A 股现金流量表查询
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


def get_cashflow_a(thscode: str, report_type: str = "年报", periods: int = 1) -> list:
    """
    获取 A 股现金流量表

    Args:
        thscode: 同花顺代码（如 "000001.SZ"）
        report_type: 报告类型（"一季报"、"中报"、"三季报"、"年报"）
        periods: 时间期（1、3、5，表示最近 1/3/5 年）

    Returns:
        现金流量表数据列表
    """
    client = SCMSClient()
    endpoint = "/api/report/fin_cashflow_a"
    data = {"thscode": thscode, "report_type": report_type, "periods": periods}
    return client.post(endpoint, data)


def main():
    parser = parse_args("获取 A 股现金流量表")
    parser.add_argument("thscode", help="同花顺代码（如 000001.SZ）")
    parser.add_argument(
        "--report_type", default="年报", help="报告类型：一季报/中报/三季报/年报"
    )
    parser.add_argument("--periods", type=int, default=1, help="时间期：1/3/5 年")
    args = parser.parse_args()

    result = get_cashflow_a(args.thscode, args.report_type, args.periods)
    print(format_output(result, args.format))


if __name__ == "__main__":
    main()
