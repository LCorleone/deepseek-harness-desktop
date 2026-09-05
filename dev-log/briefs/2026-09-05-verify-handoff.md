# verify-handoff：同事 tgz 提交的验证命令（staging 通道闭环的最后一块）

## 1. Goal & background
同事向 staging 仓（gitlab julu/dsh-desktop-plugins，internal）提交自建 tgz+提交单；
所有者（julu）负责验证与最终发布。契约四件已上线（staging + 桌面仓权威副本
tools/company-catalog/docs/handoff/）：handoff.schema.json（提交单）、compat.json
（兼容契约）、README.zh.md（流程+验证清单）、example.handoff.json。
本任务实现所有者侧 `verify-handoff` 命令：把契约的每个字段变成一个机械检查，
通过后产出可直接采用的 allowlist 片段（tgz 复制进 out/packages 即被现有发布流消费）。
同事永不持钥；本命令不签名不发布——只验证+备料。

## 2. Code map（master 2030e36adb）
- `tools/company-catalog/cli.mjs` — 子命令注册先例（keygen/build/pack-tarball/
  measure-and-publish/revoke/verify/selftest）；新命令加这里。
- `tools/company-catalog/measure.mjs` — 参考安装测 treeDigest（复用其安装-测量流）。
- `tools/company-catalog/lib/tarball.mjs` — pack/verify 工具；看现有安全解包能力
  （tar symlink 逃逸防御在客户端安装链是三层词法+realpath+walk；本命令的解包至少
  复用同等防御——解未知来源 tgz 必须防逃逸，禁止裸 tar xf）。
- `tools/company-catalog/docs/handoff/{handoff.schema.json,compat.json,example.handoff.json}` —
  契约真身（本批刚落，d9135235bf→2030e36adb）。
- `tools/company-catalog/allowlist.json` — 条目形态先例（source.kind:'tarball'+url+path+
  treeDigest；runtime.dshRuntimeVersion 语义先例）。
- 测试先例：cli selftest 命令 + tools 侧 vitest（company-catalog 工作流跑 selftest/tests/e2e）。
  找到既有 catalog 管线测试文件并把新测试挂进同一链。

## 3. 命令契约（实现目标）
`node tools/company-catalog/cli.mjs verify-handoff <submission-dir> [--smoke] [--json]`
输入=staging clone 里的一个 submissions/<name>-<version>/ 目录。检查序（fail-fast，
首错即停；--json 输出机器可读结果）：
1. **schema**：handoff.json 对 docs/handoff/handoff.schema.json 校验（jsonschema 等价
   手写校验亦可，additionalProperties:false 必须生效）。
2. **artifact 完整性**：tgz 存在、sha256 重算一致、sizeBytes 一致。
3. **安全解包**：防 symlink 逃逸（至少词法拒绝绝对/.. 目标+创建时 realpath 父目录断言）。
4. **三方绑定**：目录名两段 == handoff.plugin.{packageName,version} == 解包后
   package.json 的 name/version，逐字符等。
5. **compat 断言**：dshCommit == compat.json dsh.commit（40hex 精确）；desktopVersion ==
   compat.json desktop.version（精确）；dshRuntimeVersion 与 compat.json runtimeRange
   需有交集（支持 ^x.y.z 与精确两种形式的交集判断，手写+测试，勿引重依赖）。
   不符→错误信息含 "retest against <compat 钉死值>"。
6. **内容审计报告**（不 fail，输出给人看）：依赖清单、声明的网络域/权限面、
   与 catalog 现有条目同名的版本差。
7. **treeDigest 实测**：参考安装实测（复用 measure.mjs 流）。
8. **[--smoke]**：可选重验证（默认关，说明文档注明桌面端 e2e 冒烟另跑
   e2e-install-smoke）。
9. **verdict.md**：无论成败在提交目录旁写 verdict.md（通过=摘要+treeDigest+可采用的
   allowlist 片段；失败=哪步+原因+retest 指引）——README 对同事的承诺。
10. **accept 备料**：通过时把 tgz 复制到 tools/company-catalog/out/packages/
    <name>-<version>.tgz（文件名即现有发布流 fill 步消费的形态）+ 打印 allowlist
    条目片段（含实测 treeDigest、source.kind:'tarball'、url=正式仓 packages 路径）。
    所有者贴进 allowlist.json 后走既有 measure-and-publish/publish-local，零管线改动。

## 4. Conventions & constraints
- 纯 Node mjs，零新运行时依赖（jsonschema 若已有 devDep 可用，没有就手写）。
- Windows CI 可跑（路径分隔符教训：join/normalize，勿手拼反斜杠）。
- 不动 dsh-plugin-desktop 安装链、不动 CI workflow、不动 staging 仓。
- 长命令（参考安装）设 timeout 防挂死；下载/安装失败要清晰报错。
- 单 commit：`feat(catalog): verify-handoff — mechanical checks for staged plugin submissions`。

## 5. Acceptance criteria
- fixture 提交（用 fixtures/fixture-hello 打包或等价最小插件）全绿走通：verify 通过、
  verdict.md 生成、out/packages 就位、allowlist 片段含实测 digest。
- 三红证：sha256 篡改 / 包名-目录名不一致 / compat dshCommit 不符——各自主张的
  检查步失败且错误信息指向该步。
- symlink 逃逸 fixture（若 lib 无现成红证）一红。
- `corepack yarn check` 全绿（基线 1827+7skip）；catalog 测试链挂上新增用例。
- 不 push。
