# Model roster v2 — display name for DSV4 + second provider (Kimi)

## 1. Goal & background

老板拍板（2026-09-07 18:30）：①现有模型 DSV4-DSH 在选择器里显示为
**deepseek-v4-flash**（wire 调用不变，model id 仍是 DSV4-DSH）；②新增第二模型
**kimi-k2.6**——provider 显示名 **Kimi**，同一 nova 网关地址，**另一把 key**。
现状：blob 单 provider {baseUrl, apiKey, models: string[]}，单 env 注入
（DSH_COMPANY_LLM_KEY，含用户凭据让位语义），单 profile 注入 profile.ts:1167。

上游已支持所需形状（**不用动子模块**）：模型条目 `name?`（显示名，wire id 不变）
——llm-pi-ai catalog.ts:538；多 provider profiles 天然支持（providers map）。

## 2. Code map（2026-09-07 18:35，master 6cb205518e，行号近似）

- `dsh-plugin-desktop/src/model-gateway-blob.ts` — 生成文件（v1 单 provider）。
  旧解码值（参考）：baseUrl https://ai.deloitte.com.cn/nova/compatible-mode/v1 ·
  apiKey 9e3b…(masked, ask July) · models ["DSV4-DSH"]。
- `dsh-plugin-desktop/src/model-gateway.ts`（355 行）——常量 L35/43/45：
  route 'dsh-company-gateway' · env 'DSH_COMPANY_LLM_KEY' · 显示名
  'Company LLM Gateway'。严格解码 L97-131（keys 恰好 baseUrl/apiKey/models）；
  `companyModelGatewayProviderProfile` L221-229 返回单 profile（models 无 name）；
  `companyModelGatewayDefaultModel` L238 取 provider#1 model#1；
  `resolveManagedModelGatewayEnvironment`（凭据让位：用户存了同名 ref 就不注入）。
- `dsh-plugin-desktop/src/profile.ts:1167` — providers map 注入单条
  [COMPANY_LLM_GATEWAY_PROVIDER_ROUTE]: profile。
- `dsh-plugin-desktop/src/main.ts:748-765` — 单 env 的让位+注入。
- `dsh-plugin-desktop/scripts/make-model-gateway-blob.mjs` — 生成器
  （env：DSH_GATEWAY_BASE_URL/_API_KEY/_MODELS）。
- 测试：rg model-gateway 的 spec（desktop tests 目录）。
- 上游形状参考：deepseek-harness/packages/llm/llm-pi-ai/src/index.ts:26-46
  （providers map + models[{id,name?,contextWindow?,…}]）+ catalog.ts:538 name?。

## 3. 设计定案（按此实现，不重开）

**Blob v2 schema**（严格解码，keys 恰好 `providers`）：
```json
{"providers":[
  {"route":"dsh-company-gateway","displayName":"Company LLM Gateway",
   "apiKeyEnv":"DSH_COMPANY_LLM_KEY",
   "baseUrl":"https://ai.deloitte.com.cn/nova/compatible-mode/v1",
   "apiKey":"9e3b…(masked, ask July)",
   "models":[{"id":"DSV4-DSH","name":"deepseek-v4-flash"}]},
  {"route":"dsh-company-kimi","displayName":"Kimi",
   "apiKeyEnv":"DSH_COMPANY_KIMI_KEY",
   "baseUrl":"https://ai.deloitte.com.cn/nova/compatible-mode/v1",
   "apiKey":"3a56…(masked, ask July)",
   "models":[{"id":"kimi-k2.6"}]}
]}
```
- profile.models 带 `name`（有则传）；kimi 条目无 name（id 即显示）。
- **默认模型不变**：providers[0].models[0] → {provider:'dsh-company-gateway',
  model:'DSV4-DSH'}。
- **让位语义逐 provider 复刻**：每个 apiKeyEnv 走同一 resolve 模式（用户
  credentials 存了同名 ref → 不注入 launcher 值）。
- route/displayName/apiKeyEnv 进 blob（从常量迁移为数据；旧常量删除或保留
  作 provider#1 缺省由 worker 判断，倾向全数据化+测试钉）。
- 生成器 v2：输入改为 `DSH_GATEWAY_PROVIDERS_JSON`（单 env 传整份 JSON，
  明文只活在调用环境；--out 同旧）。
- 降级/校验语义保持：非法 blob 一次性 fail-loud；providers 至少 1；
  route/apiKeyEnv 不得重复；models 非空；name 可选字符串。

## 4. Conventions & constraints

- 不动 deepseek-harness/ 子模块；blob 明文（两把 key）永不进 commit——生成器
  从 env 读，报告里只报 shape 不报 key。
- 渲染端零改动预期（选择器显示走上游 name 机制）；telemetry 的 provider/model
  字段自然记录 route/id，无需改。
- vitest+typecheck 双跑；单 commit 不 push；worker 长命令 timeout。
- mask-secrets.ts 注释提及 COMPANY_LLM_GATEWAY_API_KEY_ENV——新增 env 名是否
  需要进掩码表，worker 核对（倾向：掩码按 env 名清单，把 DSH_COMPANY_KIMI_KEY
  加进清单）。

## 5. Acceptance criteria

1. 新 blob 由生成器产出并解码验证（报告贴解码后 shape，key 打码）。
2. profile 注入两个 provider（dsh-company-gateway + dsh-company-kimi），
   模型选择器预期显示：deepseek-v4-flash（Company LLM Gateway 下）+
   kimi-k2.6（Kimi 下）——以 profile 数据结构断言（id+name）。
3. 默认模型仍是 DSV4-DSH@dsh-company-gateway。
4. 双 env 让位语义各有测试（用户存 ref → 不注入；未存 → 注入）。
5. 旧 v1 blob 解码被拒（错误可读，指路重新生成）。
6. desktop vitest 全绿+typecheck 0（报数）。
