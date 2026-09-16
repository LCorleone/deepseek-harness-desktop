"""
Fuzzy search company names via Company Search API.
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


def fuzzy_search(keyword: str, top_k: int = 5) -> list[dict]:
    """
    Fuzzy search companies by keyword. Returns list of dicts with 'name' field.
    """
    url = f"{ROUTER_URL}/api/company/v2/search/advSearch"
    resp = requests.get(url, headers=_headers, params={"keyword": keyword}, verify=False)
    resp.raise_for_status()
    data = resp.json().get("data", {})
    items = data.get("items", [])
    return [{"name": item["name"]} for item in items[:top_k]]


def exact_match(company_name: str) -> str | None:
    """
    Check if a company exists with exact name match.
    Returns the exact company name if found, None otherwise.
    """
    url = f"{ROUTER_URL}/api/company/v2/search/advSearch"
    resp = requests.get(url, headers=_headers, params={"keyword": company_name}, verify=False)
    resp.raise_for_status()
    items = resp.json().get("data", {}).get("items", [])
    for item in items:
        if item.get("name") == company_name:
            return company_name
    return None


if __name__ == "__main__":
    query = sys.argv[1] if len(sys.argv) > 1 else "华为"
    print(f"=== Fuzzy search for: {query} ===")
    results = fuzzy_search(query)
    for i, r in enumerate(results, 1):
        print(f"  {i}. {r['name']}")

    if results:
        first = results[0]["name"]
        matched = exact_match(first)
        print(f"\n=== Exact match for '{first}': {matched} ===")
