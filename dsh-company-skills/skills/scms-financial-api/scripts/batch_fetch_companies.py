#!/usr/bin/env python3
"""
批量获取三家公司的财务数据
- 珠免集团 (600185.SH)
- 中国中免 (601888.SH)
- 王府井 (600859.SH)
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
from pathlib import Path

scripts_dir = Path(__file__).parent
sys.path.insert(0, str(scripts_dir))

from api_client import SCMSClient

# 公司列表
COMPANIES = {"珠免集团": "600185.SH", "中国中免": "601888.SH", "王府井": "600859.SH"}

# 输出目录
OUTPUT_DIR = Path(__file__).parent.parent / "data"
OUTPUT_DIR.mkdir(exist_ok=True)


def fetch_income_statement(client, thscode: str, company_name: str) -> dict:
    """获取利润表"""
    endpoint = "/api/report/fin_income_a"
    data = {"thscode": thscode, "report_type": "年报", "periods": 3}
    result = client.post(endpoint, data)
    return result


def fetch_balance_sheet(client, thscode: str, company_name: str) -> dict:
    """获取资产负债表"""
    endpoint = "/api/report/fin_balance_a"
    data = {"thscode": thscode, "report_type": "年报", "periods": 3}
    result = client.post(endpoint, data)
    return result


def fetch_cashflow_statement(client, thscode: str, company_name: str) -> dict:
    """获取现金流量表"""
    endpoint = "/api/report/fin_cashflow_a"
    data = {"thscode": thscode, "report_type": "年报", "periods": 3}
    result = client.post(endpoint, data)
    return result


def extract_key_metrics(data: dict) -> dict:
    """提取关键财务指标"""
    if not data or "tableFields" not in data:
        return {}

    table_fields = data["tableFields"]
    if not table_fields:
        return {}

    metrics = {}
    for period_data in table_fields:
        period = period_data.get("结束日期", "")
        metrics[period] = {
            "营业收入": period_data.get("其中：营业收入", ""),
            "营业成本": period_data.get("其中：营业成本", ""),
            "营业利润": period_data.get("三、营业利润", ""),
            "利润总额": period_data.get("四、利润总额", ""),
            "净利润": period_data.get("五、净利润", ""),
            "归属于母公司所有者的净利润": period_data.get(
                "归属于母公司所有者的净利润", ""
            ),
            "基本每股收益": period_data.get("基本每股收益", ""),
        }

    return metrics


def extract_balance_metrics(data: dict) -> dict:
    """提取资产负债表关键指标"""
    if not data or "tableFields" not in data:
        return {}

    table_fields = data["tableFields"]
    if not table_fields:
        return {}

    metrics = {}
    for period_data in table_fields:
        period = period_data.get("结束日期", "")
        metrics[period] = {
            "总资产": period_data.get("资产总计", ""),
            "总负债": period_data.get("负债合计", ""),
            "所有者权益": period_data.get("所有者权益（或股东权益）合计", ""),
            "流动资产": period_data.get("流动资产合计", ""),
            "流动负债": period_data.get("流动负债合计", ""),
            "非流动资产": period_data.get("非流动资产合计", ""),
        }

    return metrics


def extract_cashflow_metrics(data: dict) -> dict:
    """提取现金流量表关键指标"""
    if not data or "tableFields" not in data:
        return {}

    table_fields = data["tableFields"]
    if not table_fields:
        return {}

    metrics = {}
    for period_data in table_fields:
        period = period_data.get("结束日期", "")
        metrics[period] = {
            "经营活动产生的现金流量净额": period_data.get(
                "经营活动产生的现金流量净额", ""
            ),
            "投资活动产生的现金流量净额": period_data.get(
                "投资活动产生的现金流量净额", ""
            ),
            "筹资活动产生的现金流量净额": period_data.get(
                "筹资活动产生的现金流量净额", ""
            ),
            "现金及现金等价物净增加额": period_data.get("现金及现金等价物净增加额", ""),
        }

    return metrics


def main():
    print("=" * 80)
    print("开始获取三家公司的财务数据")
    print("=" * 80)

    client = SCMSClient()
    all_results = {}

    for company_name, thscode in COMPANIES.items():
        print(f"\n{'=' * 80}")
        print(f"正在处理: {company_name} ({thscode})")
        print(f"{'=' * 80}")

        # 获取三大报表
        print(f"  [1/3] 获取利润表...")
        income_data = fetch_income_statement(client, thscode, company_name)

        print(f"  [2/3] 获取资产负债表...")
        balance_data = fetch_balance_sheet(client, thscode, company_name)

        print(f"  [3/3] 获取现金流量表...")
        cashflow_data = fetch_cashflow_statement(client, thscode, company_name)

        # 保存到文件
        income_file = OUTPUT_DIR / f"{company_name}_income_2y.json"
        balance_file = OUTPUT_DIR / f"{company_name}_balance_2y.json"
        cashflow_file = OUTPUT_DIR / f"{company_name}_cashflow_2y.json"

        with open(income_file, "w", encoding="utf-8") as f:
            json.dump(income_data, f, ensure_ascii=False, indent=2)
        print(f"  ✓ 利润表已保存: {income_file.name}")

        with open(balance_file, "w", encoding="utf-8") as f:
            json.dump(balance_data, f, ensure_ascii=False, indent=2)
        print(f"  ✓ 资产负债表已保存: {balance_file.name}")

        with open(cashflow_file, "w", encoding="utf-8") as f:
            json.dump(cashflow_data, f, ensure_ascii=False, indent=2)
        print(f"  ✓ 现金流量表已保存: {cashflow_file.name}")

        # 提取关键指标
        all_results[company_name] = {
            "代码": thscode,
            "利润表": extract_key_metrics(income_data),
            "资产负债表": extract_balance_metrics(balance_data),
            "现金流量表": extract_cashflow_metrics(cashflow_data),
        }

    # 输出摘要
    print("\n" + "=" * 80)
    print("数据获取完成！关键指标摘要：")
    print("=" * 80)

    for company_name, results in all_results.items():
        print(f"\n【{company_name} ({results['代码']})】")

        # 利润表摘要
        print("\n  利润表:")
        for period, metrics in results["利润表"].items():
            print(f"    {period}:")
            print(f"      营业收入: {metrics['营业收入']} 元")
            print(f"      净利润: {metrics['净利润']} 元")
            print(f"      归母净利润: {metrics['归属于母公司所有者的净利润']} 元")
            print(f"      基本每股收益: {metrics['基本每股收益']} 元")

        # 资产负债表摘要
        print("\n  资产负债表:")
        for period, metrics in results["资产负债表"].items():
            print(f"    {period}:")
            print(f"      总资产: {metrics['总资产']} 元")
            print(f"      总负债: {metrics['总负债']} 元")
            print(f"      所有者权益: {metrics['所有者权益']} 元")
            print(f"      流动资产: {metrics['流动资产']} 元")
            print(f"      流动负债: {metrics['流动负债']} 元")

        # 现金流量表摘要
        print("\n  现金流量表:")
        for period, metrics in results["现金流量表"].items():
            print(f"    {period}:")
            print(f"      经营活动现金流: {metrics['经营活动产生的现金流量净额']} 元")
            print(f"      投资活动现金流: {metrics['投资活动产生的现金流量净额']} 元")
            print(f"      筹资活动现金流: {metrics['筹资活动产生的现金流量净额']} 元")
            print(f"      现金净增加额: {metrics['现金及现金等价物净增加额']} 元")

    print("\n" + "=" * 80)
    print(f"所有数据已保存至: {OUTPUT_DIR}")
    print("=" * 80)


if __name__ == "__main__":
    main()
