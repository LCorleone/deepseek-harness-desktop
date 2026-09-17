# [Feature] #043 company-skills-0.1.3：九技能入包（office三件+API五件）+共享Python预装清单+密钥宿主注入

**Issue ID**: #043
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-16
**Updated**: 2026-09-17
**Assignee**: Unassigned
**Labels**: feature

---

## 描述

[详细描述功能需求]

## 需求背景

[说明为什么需要这个功能]

## 用户故事

作为 [用户角色]，我希望 [功能描述]，以便 [达成目标]。

## 功能需求

### 基本功能

1. **功能点 1**
   - 子功能 1.1
   - 子功能 1.2

2. **功能点 2**
   - 子功能 2.1
   - 子功能 2.2

### 高级功能（可选）

3. **功能点 3**
   - 子功能 3.1

## 技术方案

### 1. 架构设计

[描述整体架构设计]

### 2. 数据结构

```rust
pub struct NewFeature {
    // 字段定义
}
```

### 3. API 设计

```rust
impl NewFeature {
    pub fn new() -> Self { }
    pub async fn do_something(&self) -> Result<()> { }
}
```

## 实现计划

### Phase 1: 基础功能（估计 X 小时）
- [ ] 任务 1
- [ ] 任务 2

### Phase 2: 高级功能（估计 X 小时）
- [ ] 任务 1
- [ ] 任务 2

### Phase 3: 优化和测试（估计 X 小时）
- [ ] 性能优化
- [ ] 单元测试
- [ ] 集成测试

## 相关文件

- `path/to/new/file.rs` (新增)
- `path/to/modified/file.rs` (修改)

## 相关 Issue

- Depends on: #XXX
- Related: #XXX

## 进展记录


### 2026-09-17
- 0.1.3 仓库侧链完成（2026-09-17 13:18，July 口令「走」）：bump 0.1.3+build+verify:bundle 绿 → corepack yarn pack（npm pack 拉全局 yarn v1 失败，教训）tgz 17,765,184B sha256 0f13a95f… → staging 提交目录+handoff.json（v2，146 字 desc）→ 十步闸门 PASS（treeDigest a2a01b7d…）→ accept-handoff（catalog-origin 补参）入 allowlist（bundleDocumentDigest=826ee8c0… ←P1 解除：CI 重建 bundle 将与 0.1.3 钉值一致）commit 619bbd092e → plugin-sources 快照 18 文件（bundle 23.46MB）→ 待提交+bump commit。下一步=publish（beta seq38，带 notebook 同批）——等 July 口令。
- 【seq38 beta 已上线】（2026-09-17 14:33，July 口令「先推beta 只我们几个先测试」+ --confirm-fleet-upgraded 证据=stable35 自 09-14 带字段在线、b90/b93 全程无黑）：skills 0.1.3（九技能，23.46MB bundle）+ notebook 0.1.0 同批首发；0.1.2 以 revoked 记录留窗（tgz 字节从线上取回补工件，integrity 与冻结签名值 MATCH）；9 tarball 全托管+复读验证。发布路上六层一次性硬化（评审 NEEDS-FIX 三项已修入库 49035e0/5bd24cd/1232b52，P3 测试债记档）：断言豁免/树冻结/包跳过/测量跳过/inline-integrity 形态/工件补字节。后续：0.1.2 无钥 retire（手摘窗，发布吊销已在线=凭证）；stable promote 等 beta 浸泡+口令。测试锚点：名单机重启→市场 skills 0.1.3（11 技能）→装→抽跑 office/API 技能。

### 2026-09-16 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- 任务简报·终版（2026-09-16 立卡，July 全部拍板完毕，未开工）：

【目标】dsh-company-skills 0.1.3 = 现有两技能 + 新九技能；配套：共享 Python 预装清单扩展 + API 密钥宿主注入。源目录 /opt/july/skills-hub/skills/{company-info,docx,ocr,pdf,pptx,scms-financial-api,xlsx,vlm-image,smart-pdf-parser}。

【已拍板决策】
D1 密钥=宿主注入：collect 剥离全部 .env；ROUTER_URL/ROUTER_API_KEY 构建期嵌客户端（对齐模型网关 blob 模式），技能执行器 spawn 时注入子进程 env；load_dotenv 无 .env 自动回落 OS env → 九技能零脚本改动。生命周期=仅进程内存、不落盘、关闭即逝。⚠env 剥离规则需放行技能执行器子进程（现 KEY/TOKEN 类剥离挡 agent 进程，注入点在 execute.ts 的 spawn 面）。
D2 Python 预装=共享环境 ensure-present + wheel 随包本地装（不走网络）：清单=技能必需小库+常见小库+PyMuPDF：requests/dotenv/tqdm/openpyxl/python-docx/python-pptx/pypdf/reportlab/pdfplumber(链~13MB)/aiohttp/pillow/markitdown/PyMuPDF(24.6MB)+常见 httpx/bs4/lxml/pyyaml/chardet/rich/dateutil——合计估 60-90MB wheel。自装大库：pandas/matplotlib（SKILL.md 注明用户自装 dsh-pip）。语义=缺则装、有不動（用户自装版本不受扰）；目标=共享环境（可变目标，无精确集合门禁），不动捆绑树（boot 摘要树不涨）。
D3 soffice/playwright/pandoc 依赖的功能路径=0.1.3 明确标注不可用（SKILL.md 文案+市场描述注明），不捆绑外部二进制。
D4 打包修复（源侧）：company-info/pdf 折叠 YAML frontmatter 展平；xlsx 的 [Content_Types].xml 路径处理（packer PATH_PATTERN 或目录布局调整，选不改 packer 安全语义的方案）；5 个超 500 字 description 按 ppt-designer 先例修剪（docx 854/pdf 966/pptx 727/xlsx 809/company-info 533）。
D5 smart-pdf-parser 跨技能寻址修复：vendor 化 ocr/vlm 两脚本进本技能（执行器按技能暂存，../../ 相对寻址会断）。

【Code Map】
源：/opt/july/skills-hub/skills/*（九目录；scout 逐技能表见 2026-09-16 调研存档）
打包：dsh-company-skills/src/bundle.ts + tools/company-skills/lib/bundle.mjs（frontmatter 朴素解析 :340-357；PATH_PATTERN :131,178；desc 500 上限 :89/bundle.ts:41；collect 直拷 collect-skills.mjs 仅剪 __pycache__）
执行：dsh-company-skills/src/execute.ts（按技能暂存 :140,503,647；python 解析 :67,384；120s 硬顶+64KiB 截断 :92-97 → D6 per-skill deadline 配置化，OCR/VLM 技能放宽）
Python 面：dsh-plugin-desktop/src/desktop-shared-python-environment.ts（provision :336+；venv --copies；无精确门禁=可变目标）；wheel 随包=安装器资产（beforePack/afterPack 门禁扩展）
密钥面：dsh-plugin-desktop/src/model-gateway.ts（blob 模式参照）；execute.ts spawn env 注入点；env 剥离=subprocess/src/index.ts:41,60-64
发布链：0.1.2→0.1.3 bump；bundle 22.04→~25MB（30MB 棘轮 tests/container.spec.ts:268-273 余量<5MB，若超需显式调棘轮）；verify→accept→beta 浸泡→stable；accept 审计将点名 10.173.109.204 与 ocr verify=False（内网明文，发布说明记录在案）

【验收标准】
□ 打包器九技能全过（frontmatter/路径/描述长度零豁免）
□ bundle ≤30MB 棘轮或显式调棘轮有评审记录
□ 剥离后 bundle 内 rg 不到 ROUTER_API_KEY/sk- 字样
□ 技能执行子进程 env 含注入变量；agent bash 会话 echo 为空（剥离仍有效）
□ 共享环境 ensure-present 幂等（二启不重装）；预装后 pdfplumber/matplotlib 之外技能依赖 import 全通（matplotlib/pandas 明确不在）
□ smart-pdf-parser 独立暂存可跑（vendor 化验证）
□ OCR/VLM 技能 deadline 放宽后不被 120s 杀
□ soffice 系功能路径在 SKILL.md 标注不可用
□ 0.1.3 走完整受理链（verify/accept/人审三点/beta 浸泡/stable）

【风险与待验证】
① wheel Windows py3.12 全量可得性（本机 Linux 估的体积，Windows 轮子 ±20%）②安装包 +60-90MB 后 NSIS 时长回归（A/B 实验室可量化，见 #041）③30MB 棘轮余量 ④ensure-present 与用户自装版本共存的最低版本声明 ⑤bundled 技能排名低于用户同名技能（pdf/docx/xlsx，by design 记档）⑥ ROUTER 网关本身的可用性/配额（外部依赖，同 #040 D 线）

【批次建议】批A=离线四件(docx/xlsx/pdf/pptx)+D4 打包修复；批B=API 五件+D1 注入+D5 vendor+D6 deadline；批C=共享环境预装清单（动 P11 面，独立评审）；0.1.3 一次发版收口。
- D3 决策修订（2026-09-16 11:21，July）：静态标注不可用【废弃】→ 动态能力探测三段式：①SKILL.md 指导 agent 先检查环境（soffice/pandoc/playwright 在不在 PATH 或已知位置）②缺失则尝试下载安装（pandoc=独立二进制、playwright=npx playwright install chromium 用户级、soffice=便携版/官方安装器，走企业代理+现有审批门）③安装失败才降级为该功能不可用并给替代路径。批A四技能的静态标注需按此返工（docx/pdf/xlsx 三个副本的 SKILL.md；pptx 本无此类依赖）。安全性注记：下载执行走既有沙箱/审批面，不新增通道——与 #040 批准门一致。
- 批A完成+reviewer APPROVED（2026-09-16 12:00）：四离线技能入包（副本制，skills-hub 只读）。D4 打包修复全落地（desc 474/425/481/499≤500、pdf 折叠YAML展平、metadata块移除、xlsx Content_Types 改名+xlsx_pack.py 双拼写别名【packer 零改动，PATH_PATTERN 原样】、docx 空 __init__.py 1字节）；D3′ 三段式动态标注（docx 中央块+5指针、pdf/xlsx 内联；探测具体/用户级安装/代理+审批提示/失败才降级）；D3′ 后追加修 P3×3：①tools/ 安装后需 prepend PATH（soffice.py 只认 PATH）已写入 docx 块②pdf 降级措辞精确化=交 render_body.py 正文版（merge.py 需 --cover）③bundle sk- 审计注记勘误=命中是 ppt-designer 的 dusk-violet 路径子串非 base64。bundle 22,036,045→23,392,117B（+6.2%，30MB 棘轮余量 6.6MB）。门禁：company-skills 93/93、tools 43/43、pack --check ✓、fidelity diff=仅清单内适配。批B衔接点：DEFAULT_SKILLS/SHIPPED_SKILL_NAMES 再扩 API 五件；make.sh 无解释器族+SKILL_DIR 字面路径=批B功能验证项。
- 批B完成+reviewer APPROVED（2026-09-16 13:45）：①五 API 技能入包（company-info YAML 展平 459 字；.env collect 级剥离+五技能 SKILL.md 注入化改写+过期变量表纠正为 ROUTER_*；smart-pdf-parser vendor 化 ocr/vlm 脚本且独立暂存功能实证——OS env 回落链路验证通）。②密钥宿主注入落地：make-company-skills-env-blob.mjs（XOR，空载荷为提交默认）→ company-skills-env.ts（仅锁定构建解码/损坏 fail-closed=启动失败路由/不写 process.env/不进渲染层/不入日志）→ Symbol.for('dsh.companySkillsExecutionEnvironment') 槽（#034/#039 先例，双侧测试钉串）→ execute.ts 显式 env 层合并。reviewer 对抗性核查全过：生成器只打印长度、teardown 清槽、slot 设置时点（policy 后/bootstrap 前）、scrub 天然覆盖 ROUTER_API_KEY。③D6 时限：ocr/vlm-image 1.2M、smart-pdf-parser 【P2 修正→3.6M 对齐其 SKILL.md 多页 1 小时预算】；backstop=max(deadlines)+grace 自动跟尺寸；P3=合并序不变量注释钉住（interpreter.env 只许字面量）。④门禁：112/112（+19）+2492（+13）+双侧 tsc 0+bundle 23,456,901B（余量 6.5MB）+密钥零残留审计。后续挂账：发版管线配 ROUTER_* secret+打包前跑生成器+断言非空（否则五技能优雅降级无凭证）；hub 源头修脚本错误文案的 .env 字样。批C（共享 Python 预装清单）待做；之后 0.1.3 bump+受理链。
- 批C完成+reviewer NEEDS FIX→修复→补评 APPROVED→P3收尾（2026-09-16 17:15）：
【交付】共享 Python 预装 wheel 集（D2）：锁清单 assets/python-wheels-lock.json 48 发行版（19 顶层+闭包传递）/51.98MiB，全 Windows py3.12 wheel 实测下载+sha256 校验；构建脚本 scripts/bundled-python-wheels.ts（精确文件名下载/缓存/离线覆盖/精确集合断言）+ beforePack 适配 + extraResources + afterPack 签名前校验；运行时 ensure-present：启动路径只留只读探测，pip 装腿延后到 finalize 后台（持同一互斥锁）；每 wheel 先验 sha256 且 pip 只收【已验证绝对路径】（不扫目录）；遥测 python_runtime+libs{pinned,installed}。
【reviewer 两轮】首轮 NEEDS FIX 3 真问题全修：①defusedxml 漏钉（docx 主路径硬依赖）→补 0.7.1 ②新装腿拉长最坏持锁→阈值 10→20min 并同步算式 ③哈希闸被同名异版轮子绕过→改绝对路径传参；另修 P2（首启 +330s 阻塞→后台修复、pandas/matplotlib 补 dsh-pip 路由）+P3（文档指针/遥测文档）。补评 APPROVED。二次 P3 收尾：deferred 装前锁内重探（用户窗口期自装不被覆盖）、锁 PID 存活检查（崩溃遗留锁即时回收，免白等 390s）、夹具数字对齐。
【测试】桌面 2528（157 文件）、company-skills 112、tools 43、双侧 tsc 0、bundle 23,458,865B ≤30MB。
【体积】安装包 +52MB（162→~214MB）；markitdown 链按 July 决定移出预装改按需自装。
【待办】0.1.3 bump + 受理链（verify/accept/人审/beta 浸泡/stable）；发版管线配 ROUTER_* secret + 打包前跑 blob 生成器并断言非空。
- 发布顺序铁则 + CI 密钥通道（2026-09-16 17:25）：
【顺序铁则（July 确认）】0.1.3 技能包走目录分发，但技能依赖的 Python 库来自客户端构建 → 必须【先发 b98（含批A/B/C 客户端面）→ 测试组验证（遥测 python_runtime libs{pinned:48,installed:48} + 抽技能实跑）→ 才 bump/publish 0.1.3】，否则全 fleet 装了跑不动的技能。
【CI 密钥通道（已完成）】gh secret set ROUTER_URL/ROUTER_API_KEY（不可读回）；windows-package workflow 在 bake build sequence 后新增步骤：导出两个 secret → 跑 make-company-skills-env-blob.mjs → 若摘要含『EMPTY payload』则构建失败（拒绝出厂无凭证包）。本地实证：真值生成非空 blob（65 明文字符），仓库默认仍为空 blob 不落密钥。
【分发渠道确认】安装包走内部页面（非公开 GitHub）→ 密钥暴露面收敛到员工级，与模型网关 key 同级，接受（软屏障定位不变）。
- b98 整体终审 = RELEASE-READY（2026-09-16 17:40，reviewer 007d49c8）+ 三项修完：
【P1 目录流水线阻塞（跨 session）】skills/ 已 11 技能但包仍 0.1.2，allowlist 钉旧 bundleDocumentDigest → 新鲜 checkout 下 CI 从 skills/ 重建 → refuseBundleDocumentDrift 挡掉 publish/digest 两条链（另一 session 的 dsh-dai-notebook 同批受阻）。解法=顺序：b98 构建→验证→0.1.3 bump+verify+accept（accept 重新钉摘要）→一条 publish 同时带出 notebook+skills。禁止手改钉值。
【P2-a 修复】locked+空 blob 静默 → main.ts 加 electronLogger.error（本地/手工 dist:win 也能看见；CI 侧 workflow 仍硬拒）
【P2-b 修复】wheel 拉取未缓存 → windows-package 加 actions/cache（按锁清单哈希，命中仍逐个 sha256 校验，陈旧条目出不了货）
【P3-b 修复】check:win-package 补 bundled-python-wheels/company-skills-env/desktop-shared-python-environment 三个 spec
【P3-a 记档】deferred 装腿与活着的 dsh-pip 别名窗口不互斥（首启窄窗、可变环境；再探保护的是「用户版本优先」语义）——后续观察项
门禁：typecheck 0、company-skills-env+bundled-python-wheels 29 测试绿、check:layout 绿。
- b98 首次构建失败 → 根因+修复（2026-09-16 17:55）：CI 烘焙真 blob 后，company-skills-env.spec.ts 三处断言『嵌入式默认 blob 为空』失败——测试依赖了构建期注入状态（检查点在 secret 生效时必然红）。修=spec 改用显式 EMPTY 夹具（encode/decode 往返+密钥无明文迹），不再读嵌入式常量；仓库卫生由 CI 步骤的空载荷 throw 兜底。本地模拟 CI（真 blob 烘焙后跑全套）2528 全绿，随后恢复空默认提交。【副作用】失败的 run #98 消耗了构建号 → 下次成功构建 = b99。
- b99 构建第二次失败 → 修复（2026-09-16 18:00）：新入 Windows 门禁的 bundled-python-wheels.spec.ts:310 用手写 POSIX 风格 file:///workspace/... URL → Windows 上 fileURLToPath 抛 ERR_INVALID_FILE_URL_PATH（仓内已知同款坑：上游 module-resolution.spec 因此不能进 Windows 门禁）。修=改用 pathToFileURL(join(cwd,'lib','main.js')) 生成平台正确 URL。预防性扫描三个新 spec：无 file:/// 残留、无路径分隔符断言（59 处 join 构建期望），判定 Windows-safe。【构建号】#98/#99 两次失败已消耗 → 下次 = b100。
- 发布顺序变更（2026-09-16 22:25，July 拍板）：0.1.3 发布链（bump+verify+accept+publish）押后至 #046 prompt 加固【做完+测试完】之后——新顺序：046 client 轮→b102→July 实测（注入生效+模板有效）→ 才走 0.1.3。逻辑：5 个 API 技能带着路由凭证进执行环境，先让绊线层就位。⚠ 跨 session 影响：dsh-dai-notebook 的发布仍被 P1 挡（同一 allowlist/publish 管线），等待期延长——需要知会另一 session。

## 验收标准

- [ ] 功能正常工作
- [ ] 性能满足要求
- [ ] 测试覆盖率 > 80%
- [ ] 文档完善
- [ ] Code Review 通过

---

## 备注

### 参考资料

- [相关文档链接]
- [类似功能实现]

### 讨论记录

[记录讨论要点]
