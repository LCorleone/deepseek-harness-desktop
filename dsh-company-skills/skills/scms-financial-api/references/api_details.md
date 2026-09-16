# SCMS API 详细说明

## 基础配置

### API 域名
- **基础域名**: `SCMS_API_BASE_URL`
- **协议**: HTTPS
- **编码**: UTF-8

### 认证方式

所有 API 请求需要在 HTTP Header 中携带认证 Token：

| Header 名称 | 值类型 | 说明 |
|-----------|--------|------|
| token | String | 认证 Token |
| Content-Type | String | 固定为 `application/json` |
| Accept | String | 固定为 `application/json` |

### 响应格式

所有 API 响应统一使用以下 JSON 格式：

**成功响应**:
```json
{
  "code": 10000,
  "message": "success",
  "data": { /* 具体数据 */ }
}
```

**错误响应**:
```json
{
  "code": 20000,
  "message": "参数错误",
  "data": null
}
```

## A 股公司搜索 API

### 端点
`/api/tracker/get_company_list_by_fuzzy`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| keyword | String | 是 | 搜索关键词，支持公司名、拼音首字母、股票代码 | "平安银行"、"zgjz"、"000001" |
| size | Integer | 否 | 返回数据条数，默认 10 | 10 |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| thscode | String | 同花顺代码（用于查询财务报表） |
| stockCode | String | 股票代码 |
| name | String | 公司名称 |
| shortName | String | 简称 |
| orgName | String | 机构名称 |
| orgFullName | String | 机构全称 |
| stockShortName | String | 股票简称 |

## 港股公司搜索 API

### 端点
`/api/tracker/get_company_list_by_fuzzy_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| keyword | String | 是 | 搜索关键词，支持公司名、股票代码 | "腾讯"、"00700"、"阿里巴巴" |
| size | Integer | 否 | 返回数据条数，默认 10 | 10 |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| org_id | String | 组织机构代码（用于查询财务报表） |
| stockCode | String | 股票代码 |
| name | String | 公司名称 |
| orgName | String | 机构名称 |
| orgFullName | String | 机构全称 |
| stockShortName | String | 股票简称 |
| phoneticShortName | String | 拼音简称 |
| thsCode | String | 同花顺代码 |

## A 股利润表 API

### 端点
`/api/report/fin_income_a`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| thscode | String | 是 | 同花顺代码，格式如 "000001.SZ" | - |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| revenue | Decimal | 营业收入 |
| operating_cost | Decimal | 营业成本 |
| operating_profit | Decimal | 营业利润 |
| net_profit | Decimal | 净利润 |

## A 股资产负债表 API

### 端点
`/api/report/fin_balance_a`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| thscode | String | 是 | 同花顺代码，格式如 "000001.SZ" | - |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| total_assets | Decimal | 资产总计 |
| total_liabilities | Decimal | 负债合计 |
| total_equity | Decimal | 所有者权益合计 |
| current_assets | Decimal | 流动资产 |
| current_liabilities | Decimal | 流动负债 |

## A 股现金流量表 API

### 端点
`/api/report/fin_cashflow_a`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| thscode | String | 是 | 同花顺代码，格式如 "000001.SZ" | - |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| operating_cash_flow | Decimal | 经营活动现金流净额 |
| investing_cash_flow | Decimal | 投资活动现金流净额 |
| financing_cash_flow | Decimal | 筹资活动现金流净额 |
| net_cash_flow | Decimal | 现金及现金等价物净增加额 |

## 港股利润表 API

### 端点
`/api/report/fin_income_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| org_id | String | 是 | 机构号（组织机构代码） | - |
| currency_code | String | 否 | 货币代码，默认 "CNY" | "CNY"(人民币)、"HKD"(港币)、"USD"(美元) |
| statement_type | String | 否 | 报表类型，默认 "合并" | "合并"(合并报表)、"母公司"(母公司报表) |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| revenue | Decimal | 营业收入 |
| operating_cost | Decimal | 营业成本 |
| operating_profit | Decimal | 营业利润 |
| net_profit | Decimal | 净利润 |
| currency | String | 货币单位 |

## 港股资产负债表 API

### 端点
`/api/report/fin_balance_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| org_id | String | 是 | 机构号（组织机构代码） | - |
| currency_code | String | 否 | 货币代码，默认 "CNY" | "CNY"(人民币)、"HKD"(港币)、"USD"(美元) |
| statement_type | String | 否 | 报表类型，默认 "合并" | "合并"(合并报表)、"母公司"(母公司报表) |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| total_assets | Decimal | 资产总计 |
| total_liabilities | Decimal | 负债合计 |
| total_equity | Decimal | 所有者权益合计 |
| currency | String | 货币单位 |

## 港股现金流量表 API

### 端点
`/api/report/fin_cashflow_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| org_id | String | 是 | 机构号（组织机构代码） | - |
| currency_code | String | 否 | 货币代码，默认 "CNY" | "CNY"(人民币)、"HKD"(港币)、"USD"(美元) |
| statement_type | String | 否 | 报表类型，默认 "合并" | "合并"(合并报表)、"母公司"(母公司报表) |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| operating_cash_flow | Decimal | 经营活动现金流净额 |
| investing_cash_flow | Decimal | 投资活动现金流净额 |
| financing_cash_flow | Decimal | 筹资活动现金流净额 |
| currency | String | 货币单位 |

## 港股财务指标 API

### 端点
`/api/report/fin_findex_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| org_id | String | 是 | 机构号（组织机构代码） | - |
| currency_code | String | 否 | 货币代码，默认 "CNY" | "CNY"(人民币)、"HKD"(港币)、"USD"(美元) |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| roe | Decimal | 净资产收益率 |
| roa | Decimal | 总资产收益率 |
| debt_ratio | Decimal | 资产负债率 |
| current_ratio | Decimal | 流动比率 |
| currency | String | 货币单位 |

## 港股主营业务构成 API

### 端点
`/api/report/fin_mbc_hk`

### 请求参数

| 参数名 | 类型 | 必填 | 说明 | 可选值 |
|--------|------|------|------|--------|
| org_id | String | 是 | 机构号（组织机构代码） | - |
| currency_code | String | 否 | 货币代码，默认 "CNY" | "CNY"(人民币)、"HKD"(港币)、"USD"(美元) |
| report_type | String | 否 | 报告类型，默认 "年报" | "一季报"、"中报"、"三季报"、"年报" |
| periods | Integer | 否 | 时间期，默认 1 | 1(最近 1 年)、3(最近 3 年)、5(最近 5 年) |

### 响应字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| period | String | 报告期 |
| business_name | String | 业务名称 |
| business_revenue | Decimal | 业务收入 |
| revenue_ratio | Decimal | 收入占比 |
| currency | String | 货币单位 |

## 错误处理

### HTTP 状态码

所有 API 请求的 HTTP 状态码统一返回 `200`，业务状态通过响应体中的 `code` 字段判断。

### 业务状态码

| 业务码 | 说明 | 使用场景 |
|--------|------|---------|
| 10000 | 成功 | 所有操作成功返回 |
| 20000 | 业务失败 | 参数错误、查询失败、数据不存在等 |
| 20005 | 认证失败 | Token 无效、过期、用户不存在等 |

### 错误响应示例

**业务失败**:
```json
{
  "code": 20000,
  "message": "参数错误: thscode格式不正确",
  "data": null
}
```

**认证失败**:
```json
{
  "code": 20005,
  "message": "Token无效或已过期",
  "data": null
}
```
