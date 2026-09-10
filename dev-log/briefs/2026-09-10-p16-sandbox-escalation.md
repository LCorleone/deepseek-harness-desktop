# P16 沙箱升权弹窗 + 共享 Python 环境 — 任务 brief

## 1. 目标与背景
真机实证（b84）：agent 沙箱内 pip/virtualenv 因「写被拒」全灭（受限令牌第二遍检查 vs mkdtemp 显式 DACL），工作区内外皆然。用户拍板（2026-09-10 12:03）：①拒写时弹窗让用户授权、免沙箱重跑；②共享 venv 当全局环境（不搬 python、不破 digest）；③本地真 python 优先做基底。

## 2. 代码地图（scout 2026-09-10 12:15，行号近似）
- **执行链**：agent pwsh 工具 `tool-pwsh/src/index.ts:325-397` → `ctx.shell.run` → `SandboxPwshExecutor.run`（`pwsh-sandbox/src/index.ts:94-122`，非 full-access 时 `confine` :181）→ 我们的 adapter `dsh-plugin-desktop/src/windows-pwsh-sandbox.ts:75-97`（argv 前缀改写；:97 判 Electron GUI vs CLI 宿主）。
- **上游已有升权**：模式枚举 `'read-only'|'workspace-write'|'danger-full-access'`（`sandbox/src/index.ts:41`）；`pwsh-sandbox:98-101` 非 confine 分支=完整令牌；拒写分类 `classifyDenial`（:121，helpers.ts:75）→ **`result.sandbox.denied` 现成**，Windows 方言 `['access is denied','access to the path','permission denied']`。
- **弹窗**：host 跑在 Electron 主进程（main.ts:1840 boot；:1870 注释）→ adapter 可直接 `dialog.showMessageBox`（阻塞先例 `electron-runtime.ts:611-621` confirmUpdateDownload）。
- **python 装配点**：main.ts:949-982（installDesktopPythonRuntime + pythonPipAvailable）；shim 生成 `desktop-runtime-environment.ts:87/:282-290/:493-529`；终端镜像 `desktop-terminal.ts:269-278/:148-149`；virtualenv 已在捆绑清单（desktop-python-runtime.ts:443）。
- **遥测**：client-event-reporter.ts:57-62 CLIENT_EVENT_TYPES + main.ts 装配。

## 3. 方案
- **A 弹窗升权（adapter 覆写 run()）**：覆写点见 scout「实现层建议」。前台 run：结果 `sandbox.denied===true` 且非 runnerFailed → Electron 下弹 `dialog.showMessageBox`（标题「沙箱拦截」、正文=spec.command 原文完整展示、按钮 仅此一次允许/拒绝，无记住选项）→ 允许则 `super.run({...spec, sandboxPolicy:{mode:'danger-full-access'}})` 原地重跑（复用同一 spec 含 workdir/env/timeout，不得重拼 shell 串），结果合并（标注 escalation:approved）；拒绝则返回原结果（标注 escalation:rejected）。CLI 宿主（非 Electron）不弹不重跑=现行为。**防连环弹**：同一命令文本（规范化后）每次会话最多弹一次；后台 job（start 路径无同步等待点）不弹。
- **B 共享 venv（pyenv）**：python 装配点后静默创建 `%LOCALAPPDATA%\DSH Desktop\pyenv`：基底=本地真实 python（沿既有 WindowsApps stub 排除逻辑）优先、否则捆绑 python；`<基底> -m virtualenv --always-copy <pyenv>`（幂等：已存在且 Scripts\python.exe 可用即跳过）；失败仅 log+回退现行为。shim 重定向：`python/python3/py/pip` 四别名指向 `pyenv\Scripts`（两处 shim 生成器：runtime-env + terminal 各改目标参数）。**捆绑运行时树零写入**（digest 不破）。
- **C preset**：agent 指引——python 直接用（PATH 即 pyenv）；装包 `pip install <pkg>`（进共享环境，全工作区生效）；首次装包沙箱可能拦截→桌面会弹授权窗，用户允许即成；绝不写程序目录。
- **D 遥测**：新事件 `sandbox_escalation {commandHash, outcome: approved|rejected|suppressed, mode}`（commandHash=sha256 前 16，不存原文——遥测里不传命令明文，弹窗里才显示原文）。

## 4. 约束
- 不改 deepseek-harness 子模块（红线）；adapter 覆写是行替换挂载，升级 0.1.3 时的重放点——注释里写明依赖的上游契约（runArgv/ShellRunResult.sandbox/模式枚举）。
- 弹窗只对 denied=true；不拦 runnerFailed/超时/退出码非零。
- 基线 desktop 2272 passed|8 skipped 只增不减；typecheck 0；check:layout 绿。

## 5. 验收
- 单测：adapter 三路（approved 重跑 full-access/拒绝保持/CLI 降级）+ 同命令去重 + 后台不弹；pyenv 幂等+stub 排除+回退；shim 目标断言（两处生成器）；preset 校验；sandbox_escalation 三态。变异各自红。
- 真机（用户）：agent `pip install requests` → 弹窗 → 允许 → 装进 pyenv；重启后 import 可用；第二个工作区直接可用零弹窗。
