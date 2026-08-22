# Company Catalog Publishing Pipeline · 公司签名目录发布管线

Signs the reviewed allowlist into the canonical, ed25519-signed company
manifest that DSH Desktop verifies end to end
(`dsh-community-market/docs/schemas/company-manifest.schema.json`).
Plain Node scripts: no build step, no dependencies beyond Node built-ins and
the built `dsh-community-market` workspace package, which provides the
signing and verification primitives (`verifyCompanyManifest`,
`createCompanyManifestSignature`, canonical JSON).

将评审合入的 allowlist 组装、签名成桌面端可全链验证的规范 JSON 公司清单
（schema 见 `dsh-community-market/docs/schemas/company-manifest.schema.json`）。
纯 Node 脚本：零第三方依赖（仅 Node 内置模块）＋ 已构建的
`dsh-community-market` 工作区包（提供签名/验证原语）。

## Commands · 子命令

```sh
node tools/company-catalog/cli.mjs <command> [options]
# or: corepack yarn catalog <command>   (root package.json passthrough)
```

| Command | Purpose · 用途 |
| --- | --- |
| `keygen` | Generate an ed25519 key pair; print the pipeline env values and the deployment-policy trust root. 生成密钥对并打印管线环境变量值与策略信任根。 |
| `build` | Fetch each allowlist entry's `dist.integrity` from `registry.npmjs.org`, assemble, sign, verify, and publish `out/catalog-manifest.json` (sequence = persisted + 1). 从官方 registry 抓取 integrity，组装→签名→round-trip 验证→发布清单。 |
| `revoke <pkg>[@<version>]` | Mark allowlist entries `revoked:true` (entries are kept) and reissue with a higher sequence. 标记吊销并递增 sequence 重发；条目保留（吊销是状态不是删除）。 |
| `verify [path]` | Verify a manifest file end to end (default `out/catalog-manifest.json`). 全链验证一个清单文件。 |
| `selftest` | CI smoke with an ephemeral key: build → sign → round-trip verify → sequence monotonicity → revocation reissue → expiry. 临时密钥全流程冒烟，绝不发布、绝不改 `state/`、`out/`、`allowlist.json`。 |

Options: `--allowlist`, `--out`, `--state-dir`, `--sequence` (must strictly
exceed the persisted one), `--expires-days` (default 90), and
`--force-offline` (selftest only).

## Allowlist and review · allowlist 与评审

`allowlist.json` is the only human-authored input; it lands exclusively
through review. Each entry pins exactly what the manifest will sign — the
pipeline adds the registry integrity at build time and never trusts local
integrity values:

`allowlist.json` 是唯一的人工输入，只能经评审合入。条目字段与清单 schema 一一对应，
integrity 一律由管线在构建时从官方 registry 抓取，绝不采信本地值：

```jsonc
[
  {
    "packageName": "ms",                  // npm name, scoped names allowed
    "version": "2.1.3",                   // exact stable semver, no prerelease
    "bundlePatch": "./cordis.patch.yml",  // required, non-empty relative path inside the package
    "runtime": {                          // dshRuntimeVersion required; cordis/node optional node-semver ranges
      "dshRuntimeVersion": "^0.1.1"
    },
    "revoked": false                      // revocation state, set by `revoke`
  }
]
```

`bundlePatch` is **required and non-empty** (schema `minLength: 1`); `ms@2.1.3`
is a live registry smoke entry, not a real plugin. See
`allowlist.example.json` for optional runtime fields.

`bundlePatch` **必填且非空**（schema `minLength: 1`）；`ms@2.1.3` 是真实
registry 冒烟条目而非真实插件。可选 runtime 字段见 `allowlist.example.json`。

## Keys · 密钥

- `COMPANY_CATALOG_SIGNING_KEY`: **base64 PKCS#8 DER ed25519 private key,
  single line** — exactly what `keygen` prints. Read from the environment
  only; the pipeline never reads key files and never writes keys to disk.
- `COMPANY_CATALOG_KEY_ID`: keyId embedded in the signature block
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`).
- `COMPANY_CATALOG_KEY_FINGERPRINT`: optional pinned sha256 fingerprint of
  the raw public key (64 lowercase hex); a mismatch aborts before any
  fetch or write.

Copy the `keygen` trust root (`{keyId, fingerprint}`) into the desktop
deployment policy `trustRoots`; the manifest only verifies against pinned
roots.

- `COMPANY_CATALOG_SIGNING_KEY`：**单行 base64 PKCS#8 DER ed25519 私钥**（即
  `keygen` 打印的格式）。只从环境变量读取，绝不读文件路径、绝不落盘。
- `COMPANY_CATALOG_KEY_ID`：写入签名块的 keyId。
- `COMPANY_CATALOG_KEY_FINGERPRINT`：可选的公钥 sha256 指纹（64 位小写十六
  进制）；不匹配则在任何网络/写入前中止。

把 `keygen` 的信任根 `{keyId, fingerprint}` 抄入桌面部署策略的
`trustRoots`；清单只对钉住的信任根可验。

## Registry rule · registry 规则

Dist integrity and the tarball URL always come from
`https://registry.npmjs.org/<pkg>/<version>`. The tarball origin must be
`https://registry.npmjs.org` — **mirrors that repack tarballs break the
signed integrity binding and are rejected**. Unpublished versions are hard
errors; the pipeline never substitutes a closest match.

integrity 与 tarball URL 一律取自官方 `registry.npmjs.org`，且 tarball origin
必须是 registry.npmjs.org —— **重打包的镜像会破坏签名完整性绑定，直接拒绝**。
未发布版本硬报错，绝不猜替代版本。

## Sequence state · sequence 状态

`state/last-sequence.json` persists the highest published sequence across
runs (both `state/` and `out/` are gitignored). Every publish must strictly
exceed it; a corrupt state file aborts rather than silently restarting the
counter. `expiresAt` defaults to now + 90 days (`--expires-days`).

`state/last-sequence.json` 跨发布持久化最高 sequence（`state/`、`out/` 均已
gitignore）。每次发布必须严格递增；状态文件损坏即中止，绝不静默清零。
`expiresAt` 默认 now + 90 天。

## Publishing runbook · 发布运行手册

1. New plugin: add the reviewed entry to `allowlist.json` (PR + review).
   新增插件：向 `allowlist.json` 加评审条目（PR + 评审）。
2. `keygen` once per rotation; store the private key in a secret manager,
   pin the trust root in the desktop deployment policy.
   每轮换密钥跑一次 `keygen`；私钥入秘密管理器，信任根钉进桌面部署策略。
3. Publish: `node tools/company-catalog/cli.mjs build`
   (env: `SIGNING_KEY`, `KEY_ID`, optionally `KEY_FINGERPRINT`).
   发布：设置环境变量后跑 `build`。
4. Serve the manifest — either:
   - **static hosting**: upload `out/catalog-manifest.json` to your HTTPS
     origin and point `companyManifestUrl` at it (origin mode), or
   - **embed with the build**: copy `out/catalog-manifest.json` to the
     desktop bundled asset path `<lib>/company-market/catalog-manifest.json`
     (content mode). The consumer already exists: desktop's
     `companyManifestAssetPath` resolves the policy path
     `company-market/catalog-manifest.json` against the bundled module
     directory. Do not modify the desktop package for this copy step.
   分发清单，二选一：静态托管（origin 模式）或随构建内嵌——把
   `out/catalog-manifest.json` 拷到桌面打包资产路径
   `<lib>/company-market/catalog-manifest.json`（content 模式）。消费端已存在：
   桌面的 `companyManifestAssetPath` 按策略路径
   `company-market/catalog-manifest.json` 相对捆绑模块目录解析。此拷贝步骤
   不需要也不应当改动 desktop 包。
5. Smoke the served artifact: `node tools/company-catalog/cli.mjs verify <path>`.
   冒烟验证分发产物。
6. Emergency withdrawal: `revoke <pkg>[@<version>]`, then serve the reissued
   manifest exactly as above.
   应急吊销：跑 `revoke`，按上面同样方式分发重发清单。

## Selftest and CI · 自测与 CI

`node tools/company-catalog/cli.mjs selftest` runs the full chain with an
ephemeral key in a temp directory: market library resolution, keypair
fingerprint cross-check, allowlist validation, live registry fetch,
build→sign→verify with byte-exact canonical output, strict sequence
monotonicity (both directions), revocation reissue, and expiry. Offline
(或 `--force-offline`) it skips only the registry segment with an explicit
notice and still exercises the whole signing chain. The GitHub Actions
workflow `.github/workflows/company-catalog.yml` (manual trigger) installs,
builds the market package, and runs the selftest.

`selftest` 用临时密钥在临时目录跑全链：market 库解析、密钥指纹交叉校验、
allowlist 校验、真实 registry 抓取、构建→签名→验证（磁盘字节即规范字节）、
sequence 严格递增（双向断言）、吊销重发、过期断言。离线（或
`--force-offline`）时仅跳过 registry 段并明示，核心签名链照跑。
`.github/workflows/company-catalog.yml`（手动触发）安装、构建 market 包后跑
selftest。
