"""
Retrieve detailed company info via Company Search API.
"""

import sys
import os

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv()

ROUTER_URL = os.getenv("ROUTER_URL")
ROUTER_KEY = os.getenv("ROUTER_API_KEY")

if not ROUTER_URL:
    print("错误: 未设置 ROUTER_URL，请在 .env 文件中配置", file=sys.stderr)
    sys.exit(1)
if not ROUTER_KEY:
    print("错误: 未设置 ROUTER_API_KEY，请在 .env 文件中配置", file=sys.stderr)
    sys.exit(1)

_headers = {"X-Router-Key": ROUTER_KEY}


def _get(path: str, params: dict = None) -> dict | None:
    """GET request helper. Returns parsed 'data' field or None."""
    url = f"{ROUTER_URL}/api/company/{path}"
    try:
        resp = requests.get(url, headers=_headers, params=params, timeout=30, verify=False)
        resp.raise_for_status()
        data = resp.json().get("data")
        return data if data else None
    except Exception as e:
        print(f"[WARN] {path} failed: {e}")
        return None


# ── Individual API fetchers ──

def get_basic_info(company_name: str) -> dict | None:
    """工商照面 (企业基本信息)"""
    return _get("enterprise/getBasicInfo", {"keyword": company_name})


def get_financing(company_name: str) -> list[dict] | None:
    """投融资信息"""
    data = _get("v2/financing/getFinancingByName", {"name": company_name})
    if data:
        return data.get("financing_list")
    return None


def get_news(company_name: str, sentiment: str = "pos") -> list[dict]:
    """新闻列表. sentiment: 'pos' or 'neg'. Returns top 5."""
    data = _get("v2/news/getNewsListByName", {
        "name": company_name,
        "sentiment": f'["{sentiment}"]',
    })
    if data:
        items = data.get("items", [])
        return items[:5]
    return []


def get_change_records(company_name: str) -> list[dict] | None:
    """变更记录. Returns top 5."""
    data = _get("enterprise/getChangeRecords", {"keyword": company_name})
    if data:
        items = data.get("items", [])
        return items[:5]
    return None


def get_employees(company_name: str) -> list[dict] | None:
    """主要人员"""
    data = _get("enterprise/getEmployees", {"keyword": company_name})
    if data:
        return data.get("items")
    return None


def get_partners(company_name: str) -> list[dict] | None:
    """工商股东"""
    data = _get("enterprise/getPartners", {"keyword": company_name})
    if data:
        return data.get("items")
    return None


def get_stock_changes(company_name: str) -> list[dict] | None:
    """股权变更（工商公示）"""
    data = _get("stock/getStockChangesByName", {"name": company_name})
    if data:
        return data.get("list")
    return None


# ── Aggregate: fetch all info in parallel ──

def get_all_company_info(company_name: str) -> dict:
    """
    Fetch all company info in parallel. Returns a dict with all sections.
    """
    tasks = {
        "basic_info":      lambda: get_basic_info(company_name),
        "financing":       lambda: get_financing(company_name),
        "news_positive":   lambda: get_news(company_name, "pos"),
        "news_negative":   lambda: get_news(company_name, "neg"),
        "change_records":  lambda: get_change_records(company_name),
        "employees":       lambda: get_employees(company_name),
        "partners":        lambda: get_partners(company_name),
        "stock_changes":   lambda: get_stock_changes(company_name),
    }

    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fn): key for key, fn in tasks.items()}
        for future in as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
            except Exception as e:
                results[key] = None
                print(f"[WARN] {key} failed: {e}")

    return results


# ── Markdown formatter ──

def to_markdown(info: dict, company_name: str) -> str:
    """Convert aggregated info dict to markdown string."""
    lines = [f"# {company_name}\n"]

    # Basic info
    basic = info.get("basic_info")
    if basic:
        lines.append("## 工商信息\n")
        for k, v in basic.items():
            if v:
                lines.append(f"- **{k}**: {v}")
        lines.append("")

    # Financing
    financing = info.get("financing")
    if financing:
        lines.append("## 投融资信息\n")
        lines.append("| 融资日期 | 融资轮次 | 融资金额 | 投资机构 |")
        lines.append("|----|----|----|----|")
        for item in financing:
            date = item.get("financing_date", "")
            round_ = item.get("financing_round", "")
            amount = item.get("financing_amount", "")
            org = item.get("investor_name", "")
            lines.append(f"| {date} | {round_} | {amount} | {org} |")
        lines.append("")

    # News
    pos_news = info.get("news_positive") or []
    neg_news = info.get("news_negative") or []
    all_news = [(n, "正面") for n in pos_news] + [(n, "负面") for n in neg_news]
    if all_news:
        lines.append("## 新闻信息\n")
        lines.append("| 标题 | 发布日期 | 简介 | 情感属性 | 来源 |")
        lines.append("|----|----|----|----|----|")
        for news, sentiment in all_news:
            title = news.get("title", "")
            date = news.get("publish_time", "")
            summary = news.get("summary", "")
            source = news.get("source", "")
            lines.append(f"| {title} | {date} | {summary} | {sentiment} | {source} |")
        lines.append("")

    # Change records
    changes = info.get("change_records")
    if changes:
        lines.append("## 变更记录\n")
        lines.append("| 变更项目 | 变更类型 | 变更日期 | 变更前 | 变更后 |")
        lines.append("|----|----|----|----|----|")
        for item in changes:
            project = item.get("change_item", "")
            ctype = item.get("change_type", "")
            date = item.get("change_date", "")
            before = item.get("content_before", "")
            after = item.get("content_after", "")
            lines.append(f"| {project} | {ctype} | {date} | {before} | {after} |")
        lines.append("")

    # Employees
    employees = info.get("employees")
    if employees:
        lines.append("## 主要人员\n")
        lines.append("| 姓名 | 是否历史 | 职位 |")
        lines.append("|----|----|----|")
        for emp in employees:
            name = emp.get("name", "")
            history = emp.get("is_history", "")
            title = emp.get("position", "")
            lines.append(f"| {name} | {history} | {title} |")
        lines.append("")

    # Partners
    partners = info.get("partners")
    if partners:
        lines.append("## 工商股东\n")
        lines.append("| 股东名称 | 出资比例 | 认缴出资额 |")
        lines.append("|----|----|----|")
        for p in partners:
            name = p.get("name", "")
            ratio = p.get("invest_ratio", "")
            amount = p.get("invest_amount", "")
            lines.append(f"| {name} | {ratio} | {amount} |")
        lines.append("")

    # Stock changes
    stock_changes = info.get("stock_changes")
    if stock_changes:
        lines.append("## 股权变更\n")
        for i, sc in enumerate(stock_changes, 1):
            lines.append(f"{i}. {sc}")
        lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    import json
    import argparse

    parser = argparse.ArgumentParser(description="Retrieve company info")
    parser.add_argument("company", help="Exact company name")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of markdown")
    args = parser.parse_args()

    info = get_all_company_info(args.company)

    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2, default=str))
    else:
        print(to_markdown(info, args.company))
