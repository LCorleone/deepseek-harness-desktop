# Tarball-channel fixture · tarball 通道 fixture

`fixture-hello` is the minimal end-to-end fixture of the tarball publish
channel (P7 batch 2b): a few lines of JS with no dependencies, shaped like a
company-patched plugin (the `dsh.bundle.patch` marker and the patch file the
manifest's `bundlePatch` points inside the package at).

It exists for `e2e-tarball.mjs` and the tools test suite —
pack (`pack-tarball --source-dir fixtures/fixture-hello`) → allowlist entry
(`source:{kind:'tarball', path, url}`) → `measure-and-publish` →
publish-local dry-run replay → desktop-side `verifyDesktopCompanyManifest`
cross-check. It is NOT a real plugin and is never listed in the reviewed
`allowlist.json`.

`fixture-hello` 是 tarball 发布通道（P7 批次 2b）的最小端到端 fixture：几行
无依赖 JS，按公司补丁插件形态组织（`dsh.bundle.patch` 标记与清单
`bundlePatch` 指向包内的补丁文件）。它服务于 `e2e-tarball.mjs` 与 tools 测试：
pack → allowlist 条目 → `measure-and-publish` → publish-local 干跑回放 →
桌面侧 `verifyDesktopCompanyManifest` 对拍。它不是真实插件，也绝不进入评审
的 `allowlist.json`。
