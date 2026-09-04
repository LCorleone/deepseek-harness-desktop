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
| `measure-and-publish` | Fill measured tree digests (`--digest-file`) into a **runtime copy** of the allowlist, build (sequence floor: `--sequence-from` or the local state file), verify, and write the manifest + `--meta-out` metadata for the workflow artifact. The reviewed `allowlist.json` is never modified. 把实测树摘要填进 allowlist **运行时副本**，构建、验证并产出清单与元数据供 workflow 产物化；绝不修改评审入库的 `allowlist.json`。 |
| `selftest` | CI smoke with an ephemeral key: build → sign → round-trip verify → sequence monotonicity → revocation reissue → expiry. 临时密钥全流程冒烟，绝不发布、绝不改 `state/`、`out/`、`allowlist.json`。 |

Options: `--allowlist`, `--out`, `--state-dir`, `--sequence` (must strictly
exceed the effective floor), `--sequence-from <url-or-path>` (the deployed
manifest whose sequence is the floor — wins over the local state file, which
stays the fallback when omitted), `--digest-file` and `--meta-out`
(measure-and-publish), `--expires-days` (default 90), and `--force-offline`
(selftest only).

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
    "repository": "https://github.com/o/r", // optional https URL override; default derives from npm metadata
    "runtime": {                          // dshRuntimeVersion required; cordis/node optional node-semver ranges
      "dshRuntimeVersion": "^0.1.1"
    },
    "treeDigest": "<64 lowercase hex>",   // optional: expected installed-tree root digest (see below)
    "approvedBuilds": ["sharp"],          // optional: signed build-script approval list (see below)
    "revoked": false,                     // revocation state, set by `revoke`
    "source": {                           // optional: install channel (P7 dual channel) — omit for npm
      "kind": "tarball",
      "url": "https://gitlab…/-/raw/master/packages/<name>-<version>.tgz",
      "integrity": "sha512-…"            // sha512 of the tarball file itself, not the registry dist
    }
  }
]
```

`bundlePatch` is **required and non-empty** (schema `minLength: 1`); `ms@2.1.3`
is a live registry smoke entry, not a real plugin. See
`allowlist.example.json` for optional runtime fields.

### Install channels · 安装通道（P7 双通道）

Every entry selects its install channel through `source`; the two channels
coexist in one manifest:

- **npm (the default)** — an absent `source` or `{"kind":"npm"}` installs the
  exact public-registry version exactly as before: `build` fetches the dist
  integrity from `registry.npmjs.org`, derives the repository identity from
  the registry metadata, and signs **no `source` key at all** (existing
  entries keep their byte-exact signed shape). npm entries must not carry a
  `url` — the channel installs from the pinned registry, nowhere else.
- **tarball** — `{"kind":"tarball","url":…,"integrity":…}` installs an
  intranet-hosted tarball (modified/forked packages): the desktop downloads
  the url, verifies the signed sha512 over the downloaded bytes, stages the
  file inside the profile's controlled staging area, and installs it through
  the package-manager boundary's one constructible tarball target. The url
  must be https and must live on the deployment's catalog origin
  (`--catalog-origin` / `COMPANY_CATALOG_ORIGIN` here, `companyCatalogOrigin`
  in the desktop policy), and `integrity` is the sha512 of the tarball file
  itself — it is signed as the entry's top-level `integrity` too, because
  that is exactly the integrity the profile lockfile pins for a `file:`
  install. A tarball entry has no trustworthy public-registry metadata, so
  its `repository` must be an explicit allowlist override (the build aborts
  without one), and the desktop installs tarball entries only when they also
  carry a reviewed `treeDigest` (the channel is tree-anchored end to end).

One package name never straddles both channels with **active** entries:
`loadAllowlist` refuses the mix outright (the desktop's per-row install-time
resolution has no single answer for a name served two ways). Revocation is a
state, not a deletion, so revoked entries do not participate in that
judgment — that is the one supported migration path: `catalog revoke
<name>` every entry on the old channel (the signed audit trail stays in the
allowlist and in every reissued manifest), then land the new-channel entries.
Two active channels for one name are refused whatever revoked history sits
next to them.

The signed `source` field is a schema extension the market verifier's
`additionalProperties:false` rejects whole — publishing the first
`source`-carrying manifest therefore rides the same fleet-upgrade gate as
`treeDigest`/`approvedBuilds` (see below: upgrade the fleet first, then
  publish with `--confirm-fleet-upgraded`). A `source`-free manifest stays
  verifiable by every client: `verifyManifestText` proves it against the
  market verifier before publishing.

每个条目通过 `source` 选择安装通道，两种通道在同一份清单内并存：**npm（默认）**——
缺省或 `{"kind":"npm"}` 时照旧从钉住的公网 registry 安装，签名条目**不含任何
`source` 键**（存量条目字节不变；npm 条目禁止带 url）；**tarball**——改造包走内网
GitLab 宿主的 tarball：url 必须是 https 且落在 catalog origin
（`--catalog-origin` / `COMPANY_CATALOG_ORIGIN`，即桌面策略的 `companyCatalogOrigin`），
`integrity` 是 tarball 文件本身的 sha512（同时作为条目顶层 `integrity` 签入，因为那正是
profile 锁文件对 `file:` 安装钉住的完整性值）；tarball 条目必须显式给出 `repository`
覆盖（构建缺少即中止），桌面端只安装携带已评审 `treeDigest` 的 tarball 条目（通道全程
树锚定）。一个包名不允许同时在两条通道上持有**活跃**条目：`loadAllowlist` 直接
拒绝混布（桌面端逐行安装解析对一名两供没有唯一答案）。撤销是状态不是删除，因此
已撤销条目不参与该判定——这也是唯一支持的迁移路径：先 `catalog revoke <name>`
撤销旧通道全部条目（签名审计痕迹留在 allowlist 与每次重发的清单里），再落地新通
道条目；无论旁边留有多少撤销历史，两个活跃通道依然被拒。`source` 是旧客户端整体拒收的 schema 扩展——首次发布走与
`treeDigest`/`approvedBuilds` 相同的 fleet 升级门禁（先全员升级，再
`--confirm-fleet-upgraded` 发布）；不含 `source` 的清单仍对全部客户端可验（发布前会先
过一遍 market 验证器证明这点）。

Every signed entry must carry a **repository identity** — it is what the
desktop install-time verifier back-links against the live npm metadata, so a
package without one cannot be listed. By default `build` derives it from the
same registry response that produced the integrity: both npm spellings work,
the legacy bare string and the dominant object form
`{"url": …, "directory": …}` (a monorepo `directory` is signed as
`subdirectory`), with npm's `git+https://….git` spellings normalized. An
explicit allowlist `repository` overrides that derivation. If neither yields
an https URL, the build aborts.

Every resolved identity — override or derived — is then run through the
market identity contract (`normalizeRepositoryIdentity`, the same check the
desktop applies to every catalog row): a URL carrying a query or fragment, an
empty path, or a github URL that is not a bare owner/repository pair aborts
the build with the entry name and the rejected URL. Such an entry would
verify as a manifest but brick the whole catalog on every desktop, so the
pipeline refuses to sign it.

Schema evolution: adding or removing required manifest fields is breaking in
**both** directions — old verifiers reject new manifests (`additionalProperties: false`
treats the new field as unknown) and new verifiers reject old ones (the
field is required). The `repository` requirement inside `1.0.0` was exactly
such a change; the next breaking change must bump `manifestVersion` instead
of mutating `1.0.0` in place. Optional fields are **not** an exemption:
old clients reject them too (`additionalProperties: false` refuses any
unknown key, required or not), so gradual enablement holds in one direction
only — a *new* client reading an *old* manifest. The first manifest that
carries `treeDigest`/`approvedBuilds`/`source` therefore requires a fleet
already upgraded to field-aware clients (see the ordering gate in "Optional
authority fields" below).

每个签名条目必须携带 **repository 身份**——桌面端安装期验证器用它与真实 npm
元数据回链比对，没有它的包无法上架。默认情况下 `build` 从产出 integrity 的
同一 registry 响应推导身份：npm 的两种写法均支持——旧式裸字符串与主流对象形
`{"url": …, "directory": …}`（monorepo 的 `directory` 以 `subdirectory` 入签名），
`git+https://….git` 写法会被规范化。allowlist 里显式给出的 `repository` 覆盖该推导。
两者都得不到 https URL 时 build 直接报错。

每个解析出的身份（覆盖或推导）都会再过一遍 market 身份契约
（`normalizeRepositoryIdentity`，即桌面端对每个目录行执行的同一检查）：带 query/
fragment、空路径、或非「owner/repository」两段的 github URL 会让构建带条目名与被拒
URL 直接中止——这类条目虽能作为 manifest 验签，却会在每台桌面上把整个目录打瘫，
所以管线拒签。

schema 演进：增删必填字段是**双向不兼容**变更——旧验证器拒新清单（`additionalProperties:
false` 把新字段当未知字段拒收），新验证器拒旧清单（字段必填）。`1.0.0` 内引入
`repository` 必填正是这样一次变更；下次破坏性变更必须升 `manifestVersion`，
禁止原地改 `1.0.0`。可选字段**不是**豁免：旧客户端同样拒收（`additionalProperties:
false` 对任何未知键一视同仁，与是否必填无关），渐进性只在「新客户端读旧清单」
这一个方向成立。首次发布携带 `treeDigest`/`approvedBuilds` 的清单前，必须先把
fleet 升级到认识这些字段的客户端（见下方「Optional authority fields」的顺序门禁）。
`source`（P7 双通道的安装通道字段）遵守同一条规则。

`bundlePatch` **必填且非空**（schema `minLength: 1`）；`ms@2.1.3` 是真实
registry 冒烟条目而非真实插件。可选 runtime 字段见 `allowlist.example.json`。

### Optional authority fields · 可选权威字段

Two **optional** entry fields extend the per-plugin anchor from the
user-writable install receipt to the signed manifest. Both are gradual-
enablement fields: they are signed verbatim when the reviewed allowlist entry
carries them and omitted otherwise, so a manifest that never uses them (such
as sequence 3 on GitLab) keeps verifying on every client unchanged.

两个**可选**条目字段把单插件的完整性锚点从用户可写的安装 receipt 扩展到签名
manifest。均为渐进启用字段：评审入 allowlist 才会被原样签名，否则省略——
从未使用它们的清单（如 GitLab 上的 sequence 3）在所有客户端上照常验签。

- **`treeDigest`** — the expected root digest (64 lowercase hex SHA-256) of
  the plugin's **installed package tree**, computed with the market
  install tree-digest contract (`computeInstallTreeDigest`: package-relative
  POSIX paths, per-file SHA-256, sorted records, root digest over the
  `sha256:<path>\n<digest>\n` lines). Desktop boot verification treats this
  signed value as the authoritative expectation and measures the on-disk tree
  against it — deleting or forging the local install receipt can no longer
  skip the check. The digest **depends on the installing environment's pnpm
  layout**, so the pipeline never derives it: measure the post-install tree in
  a clean reference environment (the same OS/package-manager matrix the fleet
  deploys), then review the measured value into the allowlist entry and
  reissue. Entries without the field keep the receipt-anchored behavior
  (receipt present → tree measured against it; receipt absent → manifest-only
  load, advisory) until the field lands. Windows reference values are
  produced by the `company-catalog-digest` workflow
  (`.github/workflows/company-catalog-digest.yml`, manual dispatch on a
  `windows-latest` runner): it packs the tarball-channel artifacts and
  measures each through the same reference install — no manual measurement
  on a company Windows machine.
- **`treeDigest`** ——插件**安装后文件树**的期望根摘要（64 位小写十六进制
  SHA-256），按 market 安装树摘要契约计算（`computeInstallTreeDigest`：包内
  相对 POSIX 路径、逐文件 SHA-256、记录按路径排序、根摘要覆盖
  `sha256:<path>\n<digest>\n` 行）。桌面启动验签以该签名值为权威期望值并实
  测磁盘树比对——本地删掉或伪造安装 receipt 都无法再绕过检查。该摘要**依赖
  安装环境的 pnpm 布局**，管线绝不自行推导：在与部署机一致的标准环境中实
  测安装后的树，把实测值评审入 allowlist 条目并重发清单。没有该字段的条目
  维持 receipt 锚定行为（有 receipt → 实测树比对 receipt；无 receipt →
  manifest-only 放行，advisory）直至字段落地。Windows 参考值由
  `company-catalog-digest` workflow
  （`.github/workflows/company-catalog-digest.yml`，手动触发，
  `windows-latest` runner）产出：打包 tarball 通道工件并逐一走同一参考
  安装实测——不再依赖人工在装机机上测量。
- **`approvedBuilds`** — the plugin's signed build-script approval list
  (`string[]`, npm names, scoped allowed, non-empty, unique). Desktop
  pre-approves a small built-in triple (`node-pty`, `esbuild`, `protobufjs`)
  in every profile workspace; after a signed install of an entry carrying
  this field (market install or locked terminal add), Desktop merges
  `built-in ∪ approvedBuilds` into the workspace before pnpm materializes
  the dependency tree, so a catalog plugin with other native build
  dependencies (sharp/sqlite3/…) no longer trips pnpm's build firewall.
  Scope semantics, stated honestly: the merge is **profile-global and
  persistent** — the approved names stay in the workspace after the install,
  including after a rollback (the merge runs before the install's WAL
  snapshot), and a name approved for one plugin's entry also grants build
  approval to the same-named dependency of any other plugin in that profile;
  the name set itself is exactly as trustworthy as the company signature
  that pinned it. Entries without the field use the built-in list only, and
  the list extends the built-in approvals — it can never shrink them.
- **`approvedBuilds`**——签名条目携带的构建脚本批准清单（`string[]`，npm 名，
  允许 scope，非空且不重复）。桌面默认在每个 profile 工作区预批一组内置
  三元组（`node-pty`、`esbuild`、`protobufjs`）；携带该字段的签名条目安装（市
  场安装或锁定终端 add）后、pnpm 物化依赖树之前，桌面会把「内置三元组 ∪
  approvedBuilds」合入工作区，携带其它原生构建依赖（sharp/sqlite3/…）的目录
  插件不再触发 pnpm 构建防火墙。如实声明其语义：该合入是**profile 全局且驻
  留**的——批准名在安装后留在工作区，回滚后也在（合入先于安装的 WAL 快照），
  且为插件 A 的条目批准的名字会让同 profile 内其它插件的同名依赖同样获得构
  建批准；名字集合本身的可信度即公司签名对它的约束。没有该字段的条目仅用内
  置清单，且该清单只能扩展内置批准，绝不能收缩。

**Fleet upgrade ordering (publication gate).** These optional fields are
optional to the *signer*, not to the fleet: before any manifest carrying
`treeDigest`/`approvedBuilds`/`source` is published, **every** client must
already run a build that knows the fields — older clients verify with
`additionalProperties: false`, so one unknown key makes them reject the
**entire** manifest and the whole catalog goes dark on those machines (not
just the one plugin). The publication order is therefore fixed: upgrade the
fleet → measure `treeDigest` in the reference environment → re-sign with a
strictly higher `sequence` (the counter never rolls back, so a bad publish
can only be superseded, never un-published) → push the manifest.
`publish-local.mjs` enforces this mechanically: when the artifact carries a
`treeDigest`/`approvedBuilds`/`source` the deployed manifest's same entry does not
(the first authoritative publish), it refuses with the upgrade guidance
below unless `--confirm-fleet-upgraded` is passed — the operator's
assertion that the whole fleet already runs a field-aware build.

**What "field-aware" means for `source` (the concrete switch).** Carrying
the dual-channel verifier unused is not enough: a build is field-aware for
`source` exactly when **boot verification** (`dsh-plugin-desktop/src/boot-verification.ts`,
`verifyDesktopBootBundles`), **the locked terminal add gate**
(`dsh-plugin-desktop/src/cli-install-channel.ts`, `authorizeLockedPluginAdd`),
**and the locked market catalog provider** (`dsh-community-market`'s
`CompanyCatalogProvider`, which feeds the market UI's catalog rows and the
signed-manifest install whitelist) all verify through
`verifyDesktopCompanyManifest` (`src/desktop-market.ts`) — the P7 batch-2
wiring plus the catalog-provider injection (the desktop host injects the
verifier through the `desktopCompanyManifestVerifier` capability; without
it the provider runs the field-unaware market verifier and a
`source`-carrying manifest blacks out the market catalog scan even though
boot and the terminal gate stay up). Before that switch all three call
sites rejected `source`-carrying manifests whole, so no `source`-carrying
manifest may be published until the whole fleet runs builds at or beyond
it.

**fleet 升级顺序（发布门禁）**。这些字段对签名者是可选的，对 fleet 不是：
任何携带 `treeDigest`/`approvedBuilds`/`source` 的清单上架前，**全部**客户端必须已运行
认识这些字段的构建——旧客户端以 `additionalProperties: false` 验签，一个未知
键就会让它拒收**整份**清单，受影响机器上整个目录瘫痪（而不只是这一个插件）。
因此发布顺序固定：先升级 fleet → 在标准参考环境实测 `treeDigest` → 以严格更
高的 `sequence` 重签（计数器不可回退，坏发布只能被更高 sequence 覆盖，无法
撤销）→ 再 push 清单。`publish-local.mjs` 已把该门禁机制化：当 artifact 携带
`treeDigest`/`approvedBuilds` 而 GitLab 已部署清单的同条目尚未携带（首个权威发
布）时，不带 `--confirm-fleet-upgraded` 直接拒发并打印升级指引——该参数即操作
者对「fleet 已全部运行认识字段的构建」的显式确认。

**对 `source` 而言「认识字段的构建」的具体含义（即本次切换）**：仅仅带上双通道
验证器而未接线不算——`source` 意义上的 field-aware 构建恰好是指 **boot 验证**
（`dsh-plugin-desktop/src/boot-verification.ts` 的 `verifyDesktopBootBundles`）、
**锁定终端 add 门禁**（`dsh-plugin-desktop/src/cli-install-channel.ts` 的
`authorizeLockedPluginAdd`）**与锁定市场目录 provider**（`dsh-community-market` 的
`CompanyCatalogProvider`，它供给市场 UI 的目录行与签名清单安装白名单）三处均通过
`verifyDesktopCompanyManifest`（`src/desktop-market.ts`）验签的构建——即 P7
批次 2 的接线加上目录 provider 的验证器注入（桌面 host 经
`desktopCompanyManifestVerifier` capability 注入；缺注入时 provider 跑字段不感知
的旧市场验证器，此时即便 boot 与终端门禁存活，携带 `source` 的清单仍会把市场
目录扫描整册打黑）。在该切换之前，这三处都会整体拒收任何携带 `source` 的清单；
因此 fleet 全员升至含该切换的构建之前，不得发布任何携带 `source` 的清单。

Both fields fail closed at every gate: the allowlist validator refuses
malformed values (non-hex or truncated digests, empty/duplicate/invalid
names) at review time, and the manifest schema rejects them again at
verification, so a bad value can never be signed by accident.

两个字段在每道门禁都 fail-closed：allowlist 校验器在评审时拒绝畸形值（非十六
进制/截断的摘要、空串/重复/非法名单项），manifest schema 在验签时再次拒绝，
坏值不可能被意外签出。

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
runs (`out/` is gitignored; the state file itself is tracked — see below).
Every publish must strictly exceed it; a corrupt state file aborts rather
than silently restarting the counter. `expiresAt` defaults to now + 90 days
(`--expires-days`).

**The state file is the GitHub-side ratchet and must be committed.** The
publish workflow runs on a GitHub runner that cannot read the intranet
GitLab, so it floors its signature at the in-repo `last-sequence.json`
(state + 1). The intranet-side publisher (`publish-local.mjs`) independently
requires `artifact.sequence == deployed + 1` against the manifest actually
served by GitLab, so a stale or jumped-ahead state file can only fail closed
on the intranet side — never a replayed or skipped sequence. After every
successful publish, commit the bump (`last-sequence.json` → the published
sequence) so the next build floors correctly.

With `--sequence-from <manifest-url-or-path>` the deployed manifest becomes
the sequence source of truth: the next sequence is the deployed one + 1, and
the local state file stays only as the no-remote fallback. The URL is read
under a hard timeout and byte cap (the desktop update-channel discipline);
an unreadable or malformed remote aborts the build instead of silently
falling back to a stale local guess, and a locally-ahead state raises the
floor to the higher value so a sequence clients may have seen is never
reissued. The CLI prints which source won.

`--sequence-from` 后，已部署 manifest 成为 sequence 的事实源：下一个 sequence =
部署值 + 1，本地 state 退居无远程时的回退。URL 读取带超时与字节上限（桌面
更新通道同款纪律）；不可读或畸形的远端直接中止构建，绝不静默退回陈旧的本地
猜测；本地超前时取更高者为下限，绝不重发客户端可能见过的 sequence。CLI 会
打印实际采用的来源。

`state/last-sequence.json` 跨发布持久化最高 sequence（`out/` 已 gitignore；
state 文件本身入库——见上）。每次发布必须严格递增；状态文件损坏即中止，
绝不静默清零。`expiresAt` 默认 now + 90 天。

**state 文件是 GitHub 侧棘轮，必须入库。** 发布 workflow 跑在读不到内网
GitLab 的 GitHub runner 上，因此以仓库内 `last-sequence.json` 为签名下限
（state + 1）；内网侧发布器（`publish-local.mjs`）再独立对拍「artifact.sequence
== GitLab 已部署 + 1」，陈旧或跳前的 state 只会在内网侧 fail-closed——绝不
会重放或跳号。每次成功发布后把 bump（`last-sequence.json` → 已发布
sequence）commit 入库，下一次构建的下限才是对的。

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

## Automatic listing (measure → fill → sign → artifact → intranet push) · 全自动上架（产物化＋内网发布）

`tools/company-catalog/measure.mjs` measures the reference-environment
`treeDigest` for allowlist entries that still lack one: it scaffolds a
temporary profile exactly like a fresh desktop profile (upstream
package.json + hoisted `pnpm-workspace.yaml` + the build-approval merge),
installs `name@version --save-exact` with the repository-pinned pnpm (the
`dsh-plugin-desktop` `pnpm` dependency — the same release the desktop
ships) against the pinned `https://registry.npmjs.org/`, then hashes the
installed tree with the compiled `computeDesktopBootTreeRootDigest`
boot-verification chunk — the exact function the desktop measures the
user's tree with. Because a real desktop install **always** runs pnpm with
the electron runtime env (`npm_config_runtime=electron`,
`npm_config_target=<the desktop's Electron version>`,
`npm_config_disturl=https://electronjs.org/headers` — the trio
`profile-materializer.ts` and `src/pnpm.ts` set on every pnpm child), the
reference install injects the same trio by default, with the target taken
from the `electron` devDependency `dsh-plugin-desktop/package.json` pins;
`--electron-target` overrides the version and `--no-electron-env` drops the
trio for a pure-JS control measurement (its digest may then diverge from
what a desktop would pin). Output: `[{packageName, version, treeDigest}, …]`
for `measure-and-publish --digest-file`, plus a console table. `--all`
re-measures every entry (a mismatch against a reviewed digest fails);
`--desktop-lib` points at a packaged artifact's lib tree instead of the
repository build.

`measure-and-publish` then fills the digests into a **runtime copy** of the
allowlist (idempotent when equal, abort on a reviewed-value conflict or an
unmatched digest record — never silent), builds with the sequence floored at
the local state file (or `--sequence-from`), re-verifies the written manifest
from disk, and — with `--meta-out` — writes the `publish-meta.json` sidecar
(sequence, keyId, fingerprint, a sha256 over the exact manifest bytes, and
the per-entry digest state). Landing a measured digest in the reviewed
`allowlist.json` stays a human review commit: the pipeline signs the runtime
copy only.

Publishing is split across the network boundary: **the GitHub runner cannot
reach the intranet GitLab** (verified empirically), so it never pushes.
`.github/workflows/company-catalog-publish.yml` (manual dispatch, Windows
runner) chains: build the market + desktop libs → pack the tarball-channel
artifacts (`pack-tarball --from-allowlist` — one pack per allowlist entry
whose `source` pins a `path`, from the workflow convention
`tools/company-catalog/plugin-sources/<tarball-stem>/` (the first live entry:
the hardened `dsh-free-search` vendoring, see
`plugin-sources/dsh-free-search-0.4.181/README-hardened.zh.md`); an explicit
no-op while the allowlist pins no such entry; the optional
`COMPANY_CATALOG_ORIGIN`
repository variable feeds the origin validation) → measure →
`measure-and-publish` floored at the in-repo state file (a preflight step
hard-fails when the state file is missing from the checkout) → step summary
with the measured digests, sequence, fingerprint, and entries → upload of
the `company-catalog-signed` artifact (`catalog-manifest.json` +
`publish-meta.json` + `packages/*.tgz` — the layout `publish-local` replays
and pushes; the meta file is enriched with gitSha/runId). `dry-run` (default)
runs the identical measure → sign → verify chain but uploads **no artifact**
— the signed bytes die with the runner; with `dry-run` unchecked the artifact
is uploaded and the summary prints the intranet publish command. No GitLab
credentials exist in the workflow at all.

A non-dry-run also mirrors the artifact's contents to the
`catalog-artifacts` branch (`<run-id>/catalog-manifest.json` +
`<run-id>/publish-meta.json` + `<run-id>/packages/*.tgz`, newest 5 run
directories kept): some intranet
environments cannot reach GitHub's artifact blob storage — `gh run download`
always dies in the TLS handshake there — while GitHub's git transport works
fine. The mirror is an auxiliary channel (a mirror push failure never fails
the workflow — it is recorded in the run summary — and the artifact stays
authoritative) and it never weakens integrity: mirror bytes face the
identical sha256 + signature + ratchet gauntlet, so a tampered branch is
rejected exactly like a tampered artifact.

The intranet side publishes:

```sh
node tools/company-catalog/publish-local.mjs --run <run-id>   # omit --run to take the run owning the newest downloadable company-catalog-signed artifact
```

`publish-local.mjs` (plain Node + `gh`/`git` on PATH, run on a machine that
reaches both GitHub and the intranet) acquires the artifact (`gh run download`
by default; `--from-git <run-id>` reads `<run-id>/` from the
`catalog-artifacts` git branch instead, and `--run <id>` falls back to that
branch automatically when the download fails — e.g. when only the blob
storage is unreachable, or `gh` is missing/broken on PATH), checks the
sidecar's sha256 against the bytes, verifies the signature against the trust
root pinned in the desktop release policy (plus the optional
`COMPANY_CATALOG_KEY_FINGERPRINT` env pin), **ratchet-checks**
`artifact.sequence == deployed + 1` against the manifest served by GitLab
(both values printed on mismatch — no skipping, replaying, or double push),
clones the config repo (PAT from `--token`/`GITLAB_TOKEN`, injected into the
git subprocesses through `GIT_CONFIG_*` — the PAT never appears in a git
child's argv, in the clone's config, or in error output; honest caveat:
`--token` does put the PAT in publish-local's **own** argv for the script's
lifetime, visible to a local `ps` — prefer the `GITLAB_TOKEN` environment
variable, which keeps it out of argv entirely),
overwrites `catalog-manifest.json` **byte-for-byte** (canonical single line —
the GitLab web editor would break verification, so the manifest only ever
moves through git push), commits (message carries sequence/fingerprint/run
id), pushes, and re-reads the raw URL until it serves HTTP 200 with the
pushed sequence **and the exact pushed bytes** (sha256(body) must equal the
sidecar's `manifestSha256`; ≤ 5 min). When the artifact carries a
`treeDigest`/`approvedBuilds` the deployed manifest's same entry does not
(the first authoritative publish), the fleet-upgrade gate above applies:
without `--confirm-fleet-upgraded` the push is refused with the upgrade
guidance. `--dry-run` stops after verification with the push
plan printed; `--artifact-dir` replays a local artifact directory laid out
like the download (tests/drills); `--branch` targets a non-master branch for
drills; `--insecure-tls` mirrors the desktop's accepted intranet TLS posture
(prefer `NODE_EXTRA_CA_CERTS` with the corporate root). Every failure is
fail-closed. After a successful master publish, commit the GitHub-side
state bump (`state/last-sequence.json` → the published sequence).

`measure.mjs` 为缺 `treeDigest` 的 allowlist 条目实测参考环境摘要：按全新桌面
profile 同款模板搭临时 profile（上游 package.json + hoisted
`pnpm-workspace.yaml` + 构建批准合入），用仓库钉死的 pnpm（`dsh-plugin-desktop`
的 `pnpm` 依赖，与桌面随包发布的同一版本）+ 钉死 registry `--save-exact` 安装，
再用编译产物里的 `computeDesktopBootTreeRootDigest`（与桌面实测用户树的同一
函数）算摘要，产出 `measure-and-publish --digest-file` 输入与控制台表格。
桌面真实安装**恒定**以 electron 运行时环境跑 pnpm
（`npm_config_runtime=electron`、`npm_config_target=<桌面 Electron 版本>`、
`npm_config_disturl=https://electronjs.org/headers`——`profile-materializer.ts`
与 `src/pnpm.ts` 对每个 pnpm 子进程都注入这三件套），因此参考安装默认注入同
一三件套，target 取 `dsh-plugin-desktop/package.json` 钉住的 `electron`
devDependency；`--electron-target` 覆盖版本，`--no-electron-env` 整体关闭用于
纯 JS 对照（其摘要可能与桌面钉定值不同）。`--all` 重测全部条目（与评审值不
符即失败）；`--desktop-lib` 可指向打包产物的 lib 树。

`measure-and-publish` 把摘要填进 allowlist **运行时副本**（相等幂等、冲突或
不匹配即中止，绝不静默），以本地 state 文件为 sequence 下限（或
`--sequence-from`）构建、从磁盘复验，并用 `--meta-out` 写出 `publish-meta.json`
边车（sequence、keyId、fingerprint、清单字节的 sha256、逐条目摘要状态）。
实测摘要评审入 `allowlist.json` 仍是人工 commit：管线只签运行时副本。

发布按网络边界拆分：**GitHub runner 读不到内网 GitLab**（已实证），因此它
绝不推送。`.github/workflows/company-catalog-publish.yml`（手动触发，Windows
runner）串起：构建 market + desktop lib → 打包 tarball 通道工件
（`pack-tarball --from-allowlist`——对 allowlist 里每个 `source` 钉了
`path` 的条目各打一个包，源码按 workflow 约定取
`tools/company-catalog/plugin-sources/<tarball-stem>/`（首个落地条目：
收编加固的 `dsh-free-search`，见
`plugin-sources/dsh-free-search-0.4.181/README-hardened.zh.md`）；无此类条目
时是显式空操作；可选的 `COMPANY_CATALOG_ORIGIN` 仓库变量供给 origin 校验）→
测量 → 以仓库内 state 文件为下限跑 `measure-and-publish`（state 文件不在
checkout 里时预检步骤直接硬失败）→ step summary 输出摘要、sequence、指纹
与条目 → 上传 `company-catalog-signed` 产物（`catalog-manifest.json` +
`publish-meta.json` + `packages/*.tgz` ——即 `publish-local` 回放并推送的布
局，后者补记 gitSha/runId）。
`dry-run`（默认）跑同一条 测量→签名→验证 链但**不上传产物**——签名字节随
runner 消亡；取消勾选才上传产物并在 summary 打印内网发布命令。workflow 里
不存在任何 GitLab 凭据。

非 dry-run 还会把同样产物内容镜像到 `catalog-artifacts` 分支
（`<run-id>/catalog-manifest.json` + `<run-id>/publish-meta.json` +
`<run-id>/packages/*.tgz`，只保留最新 5 个 run 目录）：部分内网环境到
GitHub 的 artifact blob 存储完全
通——`gh run download` 在那里恒定死于 TLS 握手——而 git 协议畅通。镜像只是
辅助通道（push 失败不会让 workflow 变红——失败记入 run summary——artifact
仍是权威产物），也不放松完整性：镜像字节走同一套 sha256 + 验签 + 序列对拍，
被篡改的分支会和被篡改的 artifact 一样被拒。

内网侧发布：

```sh
node tools/company-catalog/publish-local.mjs --run <run-id>   # 省略 --run 则按产物名取最新可下载 artifact 对应的 run
```

`publish-local.mjs`（纯 Node ＋ PATH 上的 `gh`/`git`，在同时可达 GitHub 与内网
的机器上跑）获取产物（默认 `gh run download`；`--from-git <run-id>` 改从
`catalog-artifacts` git 分支读 `<run-id>/`，`--run <id>` 在下载失败时自动回
退该分支——例如只有 blob 存储不通、或 PATH 上 `gh` 缺失/损坏的环境）→ 边车
sha256 对拍字节 → 以桌面 release 策略钉死的信任
根验签（外加可选的 `COMPANY_CATALOG_KEY_FINGERPRINT` 环境钉）→ **序列对拍**
`artifact.sequence == GitLab 已部署 + 1`（不等即打印两侧值中止——不跳号、
不重放、不重推）→ 克隆配置仓（PAT 来自 `--token`/`GITLAB_TOKEN`，经
`GIT_CONFIG_*` 注入 git 子进程——PAT 绝不出现在 git 子进程的 argv/克隆配置/报
错里；如实声明：`--token` 会把 PAT 放进 publish-local **自身**的 argv，脚本存
活期内本地 `ps` 可见——推荐用 `GITLAB_TOKEN` 环境变量，完全避开 argv）→
**逐字节**覆盖
`catalog-manifest.json`（规范单行——GitLab 网页编辑器会破坏验签，manifest
只走 git push）→ commit（消息含 sequence/fingerprint/run id）→ push → 回读
raw URL 直到 HTTP 200 且 sequence 一致**且字节即所推字节**（sha256(body) 必须
等于边车 `manifestSha256`；≤5 分钟）。当 artifact 携带 `treeDigest`/
`approvedBuilds` 而 GitLab 已部署清单同条目尚未携带（首个权威发布）时，上方
fleet 升级门禁生效：不带 `--confirm-fleet-upgraded` 拒发并打印升级指引。
`--dry-run` 验证后打印推送
计划即停；`--artifact-dir` 回放同布局的本地产物目录（测试/演练）；`--branch`
指向非 master 分支演练；`--insecure-tls` 与桌面已接受的内网 TLS 姿势对齐
（优先用 `NODE_EXTRA_CA_CERTS` 挂企业根）。所有失败均 fail-closed。master
发布成功后，把 GitHub 侧 state bump（`state/last-sequence.json` → 已发布
sequence）commit 入库。

## Selftest and CI · 自测与 CI

`node tools/company-catalog/cli.mjs selftest` runs the full chain with an
ephemeral key in a temp directory: market library resolution, keypair
fingerprint cross-check, allowlist validation, live registry fetch,
build→sign→verify with byte-exact canonical output, strict sequence
monotonicity (both directions), revocation reissue, and expiry — plus the
automatic-listing segments: the digest fill (idempotent, conflict and
unmatched-record refusals, digest-file shape) and the deployed-sequence
source (local-file stand-in for `--sequence-from`, malformed-source
refusals, and the deployed/local/explicit composition). The
repository-identity segment covers both npm packument forms (object form with
`directory` → `subdirectory` on a fixed offline fixture) and the
market-contract refusals (a github tree URL or a query-bearing override
aborts the build). Offline
(或 `--force-offline`) it skips only the registry segment with an explicit
notice and still exercises the whole signing chain. The GitHub Actions
workflow `.github/workflows/company-catalog.yml` (manual trigger) installs,
builds the market + desktop packages, runs the selftest, the offline unit
test suite (`yarn test:company-catalog`), and the tarball publish channel
e2e drill (`e2e-tarball.mjs`) — the same gate the yarn check chain runs as
`yarn check:company-catalog` (unit tests always; the e2e executes after the
workspace checks have built the libs, and skips itself with a notice when
the prerequisites are absent).

`selftest` 用临时密钥在临时目录跑全链：market 库解析、密钥指纹交叉校验、
allowlist 校验、真实 registry 抓取、构建→签名→验证（磁盘字节即规范字节）、
sequence 严格递增（双向断言）、吊销重发、过期断言；repository-identity 段覆盖
npm packument 双形式（对象形式 directory→subdirectory 用固定离线 fixture）与
market 契约拒绝负例（github tree URL / 带 query 的覆盖会中止构建）。离线（或
`--force-offline`）时仅跳过 registry 段并明示，核心签名链照跑。
`.github/workflows/company-catalog.yml`（手动触发）安装、构建 market +
desktop 包后跑 selftest、离线单元测试（`yarn test:company-catalog`）与
tarball 发布通道 e2e 演练（`e2e-tarball.mjs`）——同一条门也在 yarn check
链里以 `yarn check:company-catalog` 运行（单元测试恒跑；e2e 在 workspace
check 构建完 lib 之后执行，前置缺失时自行跳过并明示）。
