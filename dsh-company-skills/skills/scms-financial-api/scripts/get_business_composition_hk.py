#!/usr/bin/env python3
"""
港股主营业务构成查询
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


def get_business_composition_hk(
    org_id: str, currency_code: str = "CNY", report_type: str = "年报", periods: int = 1
) -> list:
    """
    获取港股主营业务构成

    Args:
        org_id: 组织机构代码
        currency_code: 货币代码（"CNY"、"HKD"、"USD"）
        report_type: 报告类型（"一季报"、"中报"、"三季报"、"年报"）
        periods: 时间期（1、3、5，表示最近 1/3/5 年）

    Returns:
        主营业务构成数据列表
    """
    client = SCMSClient()
    endpoint = "/api/report/fin_mbc_hk"
    data = {
        "org_id": org_id,
        "currency_code": currency_code,
        "report_type": report_type,
        "periods": periods,
    }
    return client.post(endpoint, data)


def main():
    parser = parse_args("获取港股主营业务构成")
    parser.add_argument("org_id", help="组织机构代码")
    parser.add_argument("--currency_code", default="CNY", help="货币代码：CNY/HKD/USD")
    parser.add_argument(
        "--report_type", default="年报", help="报告类型：一季报/中报/三季报/年报"
    )
    parser.add_argument("--periods", type=int, default=1, help="时间期：1/3/5 年")
    args = parser.parse_args()

    result = get_business_composition_hk(
        args.org_id, args.currency_code, args.report_type, args.periods
    )
    print(format_output(result, args.format))


if __name__ == "__main__":
    main()
