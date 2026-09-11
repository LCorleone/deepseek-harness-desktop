# Brief: CLI 安装通道的「陈旧 staged 清单」P1 修复（2026-09-11）

## 1. Goal & background

真机 P1：julu 在 b90 客户端上从市场安装 `dsh-company-skills@0.1.0`（beta seq28）失败：

```
dsh-desktop: rejected the company catalog manifest (stale-sequence):
  manifest sequence 25 regressed below the last seen sequence 27
dsh-plugin-desktop: the package manager failed installing the staged tarball (exit 1) — WAL 已回滚
```

链路：Electron launcher 在**开机时**拉一次 stable 清单，把这份字节 stage 到文件并
通过 `DSH_COMPANY_MANIFEST_FILE` 交给 CLI 子进程（`company-manifest-origin.ts:145-205`
`companyManifestFileRequest`）。julu 的客户端 11:xx 开机，那时 stable=`seq25`；
12:43 我们发布了 stable `seq27`（13:0x beta `seq28`）。CLI 子进程验证 staged 的 25 字节时，
反回滚地板是 `lockedPluginAddSequenceFloor()`（`desktop-cli.ts:277-291`）= max(开机回执, **市场棘轮**) = 27
⇒ 25 < 27 → `stale-sequence` → 安装被拒。

**这是回归**：把「市场棘轮并进 CLI 地板」是 b90 修复批（`3ce59e41c5`）里按评审意见做的加固；
在那之前地板只取开机回执（=25），staged 25 能过。现在只要「客户端运行期间目录发布了更高 sequence
且市场刷新过」，任何插件安装都会失败，直到重启客户端 —— 必须先重启才能装东西，不可接受。

设计意图：staged 字节是**开机快照**，天生会随目录推进而陈旧；陈旧不等于回滚。

## 2. Code map（近似行号，HEAD `91766869bd`）

- `dsh-plugin-desktop/src/company-manifest-origin.ts`
  - `:117-143` `fetchCompanyManifestText(policy, options)` —— 受限 origin 抓取
  - `:145-205` `companyManifestFileRequest(manifestFile, network)` —— **优先 staged 字节**，
    只在 staged 文件「不可用」（缺失/不可读/空/超大/设备节点）时回落到网络抓取；**内容陈旧不在回落条件里**
- `dsh-plugin-desktop/src/cli-install-channel.ts`
  - `:337-373` 清单获取：`policy.companyCatalogOrigin === null` ⇒ 读内嵌 asset；否则
    `raw = await fetchCompanyManifestText(policy, options.fetch)`（`options.fetch` 由 `desktop-cli` 注入 staged 边界）
  - `:373-375` `verifyDesktopCompanyManifest(raw, { trustRoots, companyCatalogOrigin, lastSeenSequence })`
    → `!ok` 时 `denied(...)`（本 P1 的落点）
- `dsh-plugin-desktop/src/desktop-cli.ts`
  - `:277-291` `lockedPluginAddSequenceFloor(homeDir)` —— 地板 = max(开机回执, 市场棘轮)（b90 引入）
  - `:478-490` 调 `cli-install-channel`，把地板作为 `lastSeenSequence` 传入
- `dsh-plugin-desktop/src/company-market-install.ts`
  - `:171-220` `acquireManifest()`（launcher 进程内、Electron net 抓取 ⇒ **不 stale**；beta overlay 每次现取）
  - `:285-300` / `:355-370` **beta 清单在每次安装请求时现写** staging 文件 ⇒ beta 侧不 stale
- 测试：`dsh-plugin-desktop/tests/cli-install-channel.spec.ts`（`:240-270` stale 相关、
  `:600-700` 参数化表）、`dsh-plugin-desktop/tests/company-manifest-origin.spec.ts`（若有 staged 边界用例）

## 3. Conventions & constraints

- `edit` 工具改代码；不碰 `deepseek-harness/` 子模块（红线）。
- 只做**最小外科手术**：把「staged 字节 stale ⇒ 网络重试一次」接进现有代码路径，不重构清单获取层。
- **不放松任何信任边界**：重试后的字节仍走同一个 `verifyDesktopCompanyManifest`（签名/信任根/过期/origin 绑定全不变）；
  重试失败必须 fail-closed（拒绝，和现在一样）。
- **只有 `code === 'stale-sequence'` 才重试**：签名失败/过期/结构非法等一律维持原拒绝，不得静默换源。
- 若 staged 边界未启用（无 `DSH_COMPANY_MANIFEST_FILE`）或网络抓取抛错 → 行为与今天一致（拒绝）。
- 失败时报告要保留诊断价值：重试也失败时应把**重试**的 code/reason 报出来（并可在 reason 里点明
  「staged 字节陈旧、已回退网络抓取」），别把原始 stale 文案吞掉导致误判。
- 中文注释解释「为什么」（staged 是开机快照，会随目录推进陈旧；陈旧≠回滚）；提交信息用英文祈使句。

## 4. Decisions made & failed attempts

- **否决**：把 CLI 地板改回「只取开机回执」——那是 b90 刚按评审加固的方向，回退会重开反回滚洞。
- **否决**：让 launcher 每次安装前重新 stage（更彻底，但改动面在 main.ts 的 generation 生命周期 +
  子进程 env 传递，属更大改造）→ 记为后续项，不在本卡做。
- **否决**：把 stale 判断从 CLI 里整体删掉（等于取消反回滚）。
- 已确认 beta 侧不需要修：beta staging 由 `company-market-install.ts` 每次安装现写。
- 已确认 boot 验证不需要修：开机现抓，不会有陈旧 staged 字节。

### 2026-09-11 晚间复盘（b91 真机事件 + 后续修复决策）

**真机症状（julu，唯一 b91 用户；b90 同事正常）**：①卸载成功后点「立即重启」无响应；②卸载
free-search 无限转圈（无事件、未提交）；③卸载 npm 通道插件一切正常。全面评审（range diff
b90→b91）结论：

- 症状①②**都不是 b91 新代码造成**：吞响应守卫/token 表/latch 均为 8/18 老代码（b90 已 shipped）；
  卸载不走锁定 gate（gate 仅 `plugin add`），卡死属「generation 中止吞响应 + 客户端无超时」老类。
  tarball/npm 相关性为巧合（卸载代码不分通道）。
- b91 真正新增的风险面只有：**安装路径的重试无界**（子进程 TLS 卡住 → 挂）。已在 `c521a0d803`
  修复（8s 硬超时 + 每次操作 re-stage——即本卡当初否决的「launcher 每次安装前重新 stage」，
  落点改在 `company-market-install.ts` 的 per-operation staging，避开了 main.ts 生命周期改造）。
- 剩余 4 条路由（state/media/sources/open-terminal）同守卫补齐：`313e42b6e7`。

**本卡遗留缺陷坐实（原 P3，升级为必修）——棘轮混轨**：地板 = max(回执, 棘轮) 把 **beta 序号**
（tester 的 beta overlay 到过 29）也计入，却拿去比 **stable** staged 字节（27）⇒ stable 永远
"陈旧" ⇒ 重试注定失败：子进程能联网也一样（拿到的最新 stable 就是 27 < 29；8s 只是上限，
不是必经）。曾考虑的绕过 = promote stable 到 ≥29（实际会是 30）；**根治 = 棘轮分轨**
（stable 水位只管 stable 字节、beta 水位只管 beta handoff；迁移时 stable 水位回真实高水位 27，
不削弱防回滚）——实现中，完成后 promote 退回纯发版决策、不再是 b92 前置。
- **保留**（用户拍板）：stale 重试不删（终端裸 `dsh plugin add` 场景仍可能救一次），但永远受
  8s 上限约束。

## 5. Acceptance criteria

1. 回归用例：staged 字节 `seq N`、地板 `N+2`、网络抓取返回 `seq N+2` ⇒ **安装放行**（不再 stale-sequence 拒绝）。
2. staged 陈旧 + 网络也陈旧（网络返回 `seq N`）⇒ 仍拒绝（报 stale-sequence，fail-closed）。
3. staged 陈旧 + 网络抓取抛错/超时 ⇒ 仍拒绝，且 reason 反映网络失败原因。
4. staged 字节**签名非法**（非 stale）⇒ 仍拒绝，且**不**依赖网络返回（钉住「只有 stale-sequence 才重试」）。
5. 未设 staged 边界（网络模式）⇒ 行为与今天逐字节一致（既有用例不红）。
6. `corepack yarn workspace dsh-plugin-desktop test`（全绿，含既有 `client-desktop-settings` 等）、
   `corepack yarn typecheck` 0 错误；改动只落在上述文件 + 测试。
7. 报告里给出：改动文件清单、每个 AC 对应的测试名、跑过的命令与结果。
