---
name: company-info
description: 'Search Chinese company information via internal API. Two-phase workflow — fuzzy search company names, then retrieve detailed info after user confirms the target company. Use when users ask about a company's business registration, financing, news, change records, key personnel, shareholders, or equity changes. Triggers on "查公司", "公司信息", "搜索公司", "company info", "fuzzy search company", "工商信息", "投融资", "企业查询", or any request to look up Chinese company details.'
---

# Company Info

Two-phase company information lookup.

## Workflow

### Phase 1: Fuzzy Search

When user mentions a company (possibly vague/partial name), run:

```bash
python3 <skill_dir>/scripts/fuzzy_search_company.py "<keyword>"
```

Returns up to 5 matching company names. Present them to the user and ask which one is the target.

### Phase 2: Retrieve Company Info

After user confirms the exact company name, run:

```bash
python3 <skill_dir>/scripts/get_company_info.py "<exact_company_name>"
```

Default output is markdown. Add `--json` for raw JSON (debugging):

```bash
python3 <skill_dir>/scripts/get_company_info.py "<exact_company_name>" --json
```

This fetches **in parallel**:
- 工商照面 (business registration basics)
- 投融资 (financing history)
- 新闻 (positive + negative news, top 5 each)
- 变更记录 (change records, top 5)
- 主要人员 (key personnel)
- 工商股东 (shareholders)
- 股权变更 (equity changes)

Output includes both raw JSON and a formatted markdown summary.

## Configuration

The API endpoint and credentials (`ROUTER_URL`, `ROUTER_API_KEY`) are injected by the managed desktop build when a skill script runs — the managed build injects these; do not edit, create, or read `.env` files for them. No manual setup is required. Optional proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) are honored from the normal environment when present.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ROUTER_URL` | API base URL (injected by the managed build) |
| `ROUTER_API_KEY` | API authentication key (injected by the managed build) |
| `HTTP_PROXY` | HTTP proxy server (optional) |
| `HTTPS_PROXY` | HTTPS proxy server (optional) |
| `NO_PROXY` | Proxy bypass list (optional) |
