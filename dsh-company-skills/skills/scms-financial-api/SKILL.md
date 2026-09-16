---
name: scms-financial-api
description: SCMS 财务报表 API 调用工具，支持 A 股和港股上市公司的财务数据查询。使用场景：1) 搜索 A 股/港股公司获取公司代码；2) 获取财务报表（利润表、资产负债表、现金流量表）；3) 获取港股财务指标和主营业务构成；4) 支持多货币单位（CNY/HKD/USD）和报表类型（合并/母公司）；5) 支持多种输出格式（JSON/CSV）。
---

# SCMS Financial API

## Overview

获取 A 股和港股上市公司的财务数据，包括财务报表、财务指标和主营业务构成。

## Quick Start

### 认证配置

> **注意**: `ROUTER_URL` 和 `ROUTER_API_KEY` 由受管桌面构建在技能脚本运行时自动注入环境变量，无需任何手动设置。请勿编辑、创建或读取 `.env` 文件（受管构建负责注入，不要自行修改）。

需要的环境变量：

| 变量名 | 说明 |
|--------|------|
| `ROUTER_URL` | API 基础 URL（受管构建注入） |
| `ROUTER_API_KEY` | API 认证密钥（受管构建注入） |

### 安装依赖

```bash
pip install -r requirements.txt
```

### 使用示例

```bash
# 搜索 A 股公司
python scripts/search_company_a.py "平安银行" --format json

# 获取 A 股利润表
python scripts/get_income_statement_a.py "000001.SZ" --report_type "年报" --periods 3 --format csv

# 搜索港股公司
python scripts/search_company_hk.py "腾讯" --format json

# 获取港股利润表（指定货币和报表类型）
python scripts/get_income_statement_hk.py "T000001" --currency_code "HKD" --statement_type "合并" --format csv
```

## 核心功能

### 1. 公司搜索

查询公司前必须先调用搜索接口获取公司代码：

**A 股搜索** - 获取 `thscode`
```bash
python scripts/search_company_a.py <keyword> [--size 10] [--format json|csv]
```

**港股搜索** - 获取 `org_id`
```bash
python scripts/search_company_hk.py <keyword> [--size 10] [--format json|csv]
```

### 2. A 股财务报表

所有 A 股报表查询需要 `thscode` 参数：

| 报表类型 | 脚本 | 参数 |
|---------|------|------|
| 利润表 | `get_income_statement_a.py` | `thscode`, `report_type`, `periods` |
| 资产负债表 | `get_balance_sheet_a.py` | `thscode`, `report_type`, `periods` |
| 现金流量表 | `get_cashflow_a.py` | `thscode`, `report_type`, `periods` |

通用参数：
- `thscode`: 同花顺代码（如 "000001.SZ"）
- `--report_type`: 报告类型（"一季报"、"中报"、"三季报"、"年报"，默认"年报"）
- `--periods`: 时间期（1、3、5，表示最近 1/3/5 年，默认 1）
- `--format`: 输出格式（"json" 或 "csv"，默认"json"）

示例：
```bash
python scripts/get_income_statement_a.py "000001.SZ" --report_type "年报" --periods 3 --format json
```

### 3. 港股财务报表

所有港股报表查询需要 `org_id` 参数：

| 报表类型 | 脚本 | 参数 |
|---------|------|------|
| 利润表 | `get_income_statement_hk.py` | `org_id`, `currency_code`, `statement_type`, `report_type`, `periods` |
| 资产负债表 | `get_balance_sheet_hk.py` | `org_id`, `currency_code`, `statement_type`, `report_type`, `periods` |
| 现金流量表 | `get_cashflow_hk.py` | `org_id`, `currency_code`, `statement_type`, `report_type`, `periods` |
| 财务指标 | `get_financial_index_hk.py` | `org_id`, `currency_code`, `report_type`, `periods` |
| 主营业务构成 | `get_business_composition_hk.py` | `org_id`, `currency_code`, `report_type`, `periods` |

通用参数：
- `org_id`: 组织机构代码
- `--currency_code`: 货币代码（"CNY"、"HKD"、"USD"，默认"CNY"）
- `--statement_type`: 报表类型（"合并"、"母公司"，默认"合并"）
- `--report_type`: 报告类型（"一季报"、"中报"、"三季报"、"年报"，默认"年报"）
- `--periods`: 时间期（1、3、5，表示最近 1/3/5 年，默认 1）
- `--format`: 输出格式（"json" 或 "csv"，默认"json"）

示例：
```bash
python scripts/get_income_statement_hk.py "T000001" --currency_code "HKD" --statement_type "合并" --report_type "年报" --periods 3 --format json
```

## API 端点对照表

| 功能 | A 股端点 | 港股端点 |
|-----|---------|---------|
| 公司搜索 | `/api/tracker/get_company_list_by_fuzzy` | `/api/tracker/get_company_list_by_fuzzy_hk` |
| 利润表 | `/api/report/fin_income_a` | `/api/report/fin_income_hk` |
| 资产负债表 | `/api/report/fin_balance_a` | `/api/report/fin_balance_hk` |
| 现金流量表 | `/api/report/fin_cashflow_a` | `/api/report/fin_cashflow_hk` |
| 财务指标 | - | `/api/report/fin_findex_hk` |
| 主营业务构成 | - | `/api/report/fin_mbc_hk` |

## 输出格式

### JSON 格式
默认输出格式，适合程序处理：
```json
[
  {
    "period": "2024-12-31",
    "revenue": 123456789000.00,
    "operating_profit": 24691357000.00,
    "net_profit": 18543517750.00
  }
]
```

### CSV 格式
适合 Excel 导入或数据分析：
```
period,revenue,operating_profit,net_profit
2024-12-31,123456789000.00,24691357000.00,18543517750.00
2023-12-31,111111111000.00,22222223000.00,16666667250.00
```

## 错误处理

### 业务状态码

| 状态码 | 说明 |
|-------|------|
| 10000 | 成功 |
| 20000 | 业务失败（参数错误、查询失败、数据不存在等） |
| 20005 | 认证失败（Token 无效、过期等） |

### 常见错误处理

**认证未注入（受管构建异常时才会出现）**
```
错误: 未设置 ROUTER_API_KEY 环境变量
```

**API 错误**
```
API 错误 (code=20000): 参数错误: thscode格式不正确
```

## 注意事项

1. **公司代码获取**：查询财务报表前，必须先调用公司搜索 API 获取 `thscode`（A 股）或 `org_id`（港股）
2. **参数默认值**：`report_type` 默认为 "年报"，`periods` 默认为 1（最近 1 年）
3. **货币单位**：港股 API 支持切换货币单位（CNY/HKD/USD）
4. **报表类型**：港股 API 支持切换 "合并" 或 "母公司" 报表
5. **Token 安全**：Token 为敏感信息，请妥善保管，不要提交到版本控制系统
6. **输出格式**：所有脚本支持 `--format json` 或 `--format csv` 参数

## Resources

### scripts/
可执行的 Python 脚本：

- `api_client.py` - 通用 API 客户端（认证、错误处理、格式转换）
- `search_company_a.py` - A 股公司搜索
- `search_company_hk.py` - 港股公司搜索
- `get_income_statement_a.py` - A 股利润表
- `get_balance_sheet_a.py` - A 股资产负债表
- `get_cashflow_a.py` - A 股现金流量表
- `get_income_statement_hk.py` - 港股利润表
- `get_balance_sheet_hk.py` - 港股资产负债表
- `get_cashflow_hk.py` - 港股现金流量表
- `get_financial_index_hk.py` - 港股财务指标
- `get_business_composition_hk.py` - 港股主营业务构成

### references/
详细的 API 参考文档：
- `api_details.md` - 完整 API 端点、参数说明、字段定义

### assets/
未使用，可删除此目录
