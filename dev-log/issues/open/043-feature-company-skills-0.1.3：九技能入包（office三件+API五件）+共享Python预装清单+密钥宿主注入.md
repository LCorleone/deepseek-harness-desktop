# [Feature] #043 company-skills-0.1.3：九技能入包（office三件+API五件）+共享Python预装清单+密钥宿主注入

**Issue ID**: #043
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-16
**Updated**: 2026-09-16
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
