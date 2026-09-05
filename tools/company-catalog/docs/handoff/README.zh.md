# DSH Desktop 插件提交仓（staging）

同事向公司插件市场**提交自建 tgz** 的暂存区。这里的任何内容都**不会**直接到达员工机器——桌面端所有者（julu）会对每个提交做字节级验证与兼容复验，通过后由所有者签名发布到正式目录 `julu/dsh-desktop-config`。

## 你要做什么（一次提交 = 一个目录）

```
submissions/
  <packageName>-<version>/          ← 目录名的两段必须与包内 package.json 完全一致
    handoff.json                    ← 按 handoff.schema.json 填写的提交单
    <packageName>-<version>.tgz     ← npm pack 产物（自建，字节原样送验）
```

三步：

1. **自验兼容**——用 agent 按 `compat.json` 搭环境测试（见下节）。`compat.json` 是兼容契约的唯一事实源，每次测试前让 agent 重新读它，**不要硬编码版本**。
2. **算指纹**——对 tgz 算 SHA-256 与字节数，填进 `handoff.json` 的 `artifact` 段。所有者会重算，不符当场拒。
3. **填单提交**——`handoff.json` 逐字段按 `handoff.schema.json`（`additionalProperties: false`，多一个字段都过不了）；推到本仓 `master`。

## 自验兼容（agent 指令模板，可直接给你的 agent）

> 读取 https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-plugins/-/raw/master/compat.json
> （本仓 internal：用你的 GitLab 凭据——浏览器登录态、或 curl 头 `PRIVATE-TOKEN: <你的token>`，匿名读会 302）。
> 按 `dsh.commit` 检出 deepseek-harness 到该 commit，安装我方插件（pnpm，workspace 内），
> 启动 client/host 双面验证插件功能。对照 `desktop.version` 用该版桌面端做一次冒烟
> （插件经 dev workspace 侧载，不走市场通道——锁定桌面端不接受未签名安装，这是设计）。
> 测试结果记入 handoff.json 的 evidence：summary 写实际跑过的场景与结果，
> checks 勾选真实执行过的项，没跑的不要勾。

## 所有者会验证什么（透明起见）

```
sha256 重算 → 安全解包（tar 逃逸三层防御）→ 包名/版本/目录名三方一致 →
compat 声明 == compat.json 钉死值（dshCommit/desktopVersion 精确等，
dshRuntimeVersion 需有交集，不符拒绝并注明 retest against 哪个版本）→
内容审计（权限/域名/依赖面）→ 参考安装实测 treeDigest → 桌面端 e2e 安装冒烟 →
通过才进签名清单（签名私钥永远只在所有者侧）
```

任何一环失败都会在提交目录旁回一个 `verdict.md`（原因+retest 指引），修好后换版本号重新提交——**同一版本号的内容不可变**，改了内容必须升版本。

## 边界

- 本仓的提交**不是**上架成功——员工机器只认 `dsh-desktop-config` 的签名清单。
- 高权限插件（申请系统权限/敏感域名的）不适用此快速通道，需走源码审计通道（联系所有者）。
- `compat.json` / `handoff.schema.json` / 本 README 由所有者维护，请勿改动；改动会被回退。
