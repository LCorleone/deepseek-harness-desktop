# P11 捆绑 Python 运行时 — 任务 brief

## 1. 目标与背景
同事常要跑 python（数据/脚本），公司机器无预装且装不了。目标：像捆绑 Node 一样捆绑 Win embeddable CPython，让终端里 `python`/`pip` 开箱即用；pip 装包落 workspace `.venv`；不污染用户机器。可行性已签收（2026-09-08）：公司代理可达 pypi 全链零配置（pip 拾取 WinINET，`--no-cache-dir` 实测过，清华源备份）；沙箱 WRITE_RESTRICTED 只限写、执行 resources/ 下捆绑 exe 不受限（上游 note 2026-08-08）；规模 M。

## 2. 代码地图（scout 2026-09-10 07:40，行号近似）
- **node-runtime 先例（全链照抄改造）**：`scripts/bundled-node.ts`（版本钉扎 L28、sha256 分发表 L57-77、缓存 `build/node-runtime-cache` L329、staging `build/node-runtime` L330、`DSH_BUNDLED_NODE_ARCHIVE` 离线覆盖 L340）；`scripts/prepare-bundled-node.ts:49-57`（beforePack 钩子）；`package.json:330-337`（extraResources 映射 + beforePack/afterPack）；`.gitignore` 两目录；CI 无缓存步骤=现场下载；digest manifest `lib/node-runtime-sha256.json`。
- **暴露链**：`src/desktop-runtime-environment.ts`（`installDesktopPnpmRuntime` L386-433：stateDir/`bin` 公开/`private/node-bin` 私有；`windowsNodeShim` L216；PATH 幂等 `installPathDirectory` L289）；`src/main.ts:928-937`（stateDir=`userData/runtime-commands`，注入 process.env）；agent 子进程 PATH 先例 `src/pnpm.ts:828-835`；打包内定位+校验 `src/desktop-node-runtime.ts`（`packagedBundledNodePath` L77、digest+指纹缓存 L155、dev 回退 L239）。
- **终端**：`src/desktop-terminal.ts`（Windows 生成 `dsh.cmd/pnpm.cmd/node.cmd` L483-495；PowerShell welcome 前插 shimDir L398-400；`terminalEnvironment` L502）；调用点 `src/electron-runtime.ts:377-399`。
- **沙箱**：`src/windows-pwsh-sandbox.ts`（仅适配器）；真约束=上游 WRITE_RESTRICTED（workspace 可写 ⇒ `.venv` 落 workspace 合法）。
- **遥测/政策**：`src/client-event-reporter.ts:57-62`（CLIENT_EVENT_TYPES）；`src/desktop-policy.ts:31-38`（开关先例）+ `policy/desktop-policy.release.json`。
- **测试基建**：`tests/bundled-node.spec.ts`（假 zip+可注入 seam）、`tests/desktop-runtime-environment.spec.ts:57-294`（shim 内容/PATH 幂等/符号链接拒收）、`tests/desktop-terminal.spec.ts`。

## 3. 约定与约束
- **绝不改 `deepseek-harness/` 子模块**（红线）；desktop 自有实现。
- 镜像 node-runtime 既有形态：钉扎版本+sha256 分发表、缓存/staging、beforePack、extraResources、digest 校验——**但 Python 是目录树非单 exe**，digest 需按目录清单（每文件 sha256 或整树 tar 化，worker 选型，报告说明）。
- 捆绑版本：CPython 3.12.x embeddable amd64（具体补丁版 worker 钉最新稳定）；pip 用 ensurepip 引导（embeddable 缺 pip）——若 ensurepip 不可用则 get-pip.py 离线文件方案，取舍写报告。
- 别名 shim：`python.cmd`/`python3.cmd`/`py.cmd`（终端+PATH 双面）；**不遮蔽用户自装**的前插语义保持 node 先例（登录 shell PATH 覆盖问题记录不解决）。
- pip 装包目标：workspace `.venv`（沙箱写白名单内）；不做全局 site-packages 写。
- Electron 的 HTTPS_PROXY/CA 注入与 pip 的 WinINET 语义不同——Phase B 验证不互相干扰，记录结论。
- 体积预算：安装包 +~60-110MB（NSIS 压缩后），报告实测。
- 测试不真下载（可注入 seam 先例）；e2e 装机冒烟留给用户真机。

## 4. 已做决策与失败尝试
- 2026-09-08 网络可行性=零配置签收；清华源仅备份不默认。
- 沙箱档1「只限写不限执行」已确认，无需为 Python 升档。
- Phase 划分（scout 建议+确认）：**A=捆绑+digest+shim+终端可用**；**B=ensurepip/pip 引导+.venv 约定+agent preset 感知**；**C=遥测事件+政策开关+文档+体积实测**。每 Phase 独立 review。
- 无失败尝试记录。

## 5. 验收标准
- A：打包态终端敲 `python --version` 出 3.12.x、`python3`/`py` 别名可用；digest 校验失败=拒绝启动该面（fail-closed）；PATH 幂等；`tests/bundled-python.spec.ts` 等新 spec 全绿；基线 desktop 测试只增不减；typecheck 0；layout 绿。
- B：`python -m pip --version` 可用；`pip install` 落 workspace `.venv`（沙箱内实测路径断言）；agent preset/终端提示提及 python 可用性（最小面）。
- C：遥测 `python_runtime {available, version, origin}`（形状照 client-event-reporter 先例）；政策开关（release 默认 enabled）；文档（README.zh/telemetry.zh）+ 安装包体积实测数字进战报。
