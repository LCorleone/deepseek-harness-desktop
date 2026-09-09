# Brief — 快捷方式显示名改为 Deloitte DSH Desktop（2026-09-09 晚，回填）

## 1. Goal & background（目标与背景）

品牌要求：客户端快捷方式显示名体现 Deloitte。硬约束：只改**显示名**，绝不动决定身份的 `productName`——它决定 userData 目录（`%APPDATA%\DSH Desktop`）、安装目录、exe 名与卸载项。改 productName = 数据迁移级事故。

## 2. Code map（代码地图）

- `dsh-plugin-desktop/package.json:321` `build.productName = "DSH Desktop"`（**不动**）。
- `dsh-plugin-desktop/package.json:412` `build.nsis.shortcutName = "Deloitte DSH Desktop"`（本次唯一改动点）。
- `dsh-plugin-desktop/build/installer.nsh:66-79` 新增 `customInstall` 宏：`Delete "$DESKTOP\DSH Desktop.lnk"`、`Delete "$SMPROGRAMS\DSH Desktop.lnk"`、`Delete "$SMPROGRAMS\DSH Desktop\DSH Desktop.lnk"`——只删这三个精确遗留名，不删目录；文件不存在时 Delete 为 no-op。
- commit `74f209b3d9`。

## 3. Conventions & constraints（约定与约束）

- 显示名走 `shortcutName`，`productName` 零改动（userData/安装目录/exe/卸载项身份不变）。
- 升级路径：electron-builder 会按 registry 记录的 `ShortcutName` 重命名自己建的快捷方式；但 keep-shortcuts 分支不重命名时旧名 `.lnk` 会残留→双图标，故 `customInstall` 兜底删除。
- 不改 `appId`，不改安装器其余宏。

## 4. Decisions made & failed attempts（已做决策与失败尝试）

- 曾考虑直接改 `productName` → **否决**：会改 userData/安装目录/exe 名，等于强制迁移，与「只换展示」不符。
- 旧 `.lnk` 清理只删精确名，不做通配、不删目录（避免误删用户自建快捷方式或开始菜单文件夹）。

## 5. Acceptance criteria（验收标准）

- 全新安装与升级后桌面/开始菜单快捷方式显示 `Deloitte DSH Desktop`。
- `%APPDATA%\DSH Desktop`、安装目录、`DSH Desktop.exe`、卸载项名不变。
- 升级不出现双图标（遗留 `DSH Desktop.lnk` 被删）。
- `package.json` 中 `productName` 仍为 `DSH Desktop`。
