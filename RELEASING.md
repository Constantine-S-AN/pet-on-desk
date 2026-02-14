# RELEASING

## 1. 版本号规则
- 使用 SemVer：`MAJOR.MINOR.PATCH`。
- Git tag 规范：`vMAJOR.MINOR.PATCH`（例如 `v0.2.0`）。
- 触发发布流水线的条件：push `v*` tag（见 `.github/workflows/release.yml`）。

## 2. 必要前置配置

### 2.1 Updater 配置
- 配置文件：`src-tauri/tauri.conf.json`
- 当前占位更新地址：`https://example.com/live2d-desktop-pet/latest.json`
- 发布前请替换为真实 CDN/对象存储地址。
- `bundle.createUpdaterArtifacts` 已开启，构建时会生成 updater 所需产物。

### 2.2 GitHub Secrets（名称必须一致）
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `APPLE_CERTIFICATE`（base64 编码的 `.p12`）
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`（可选，未配置时 workflow 会尝试自动探测）
- `APPLE_ID`
- `APPLE_PASSWORD`（Apple app-specific password）
- `APPLE_TEAM_ID`
- `KEYCHAIN_PASSWORD`

## 3. 发布步骤
1. 同步版本号（至少这 3 处）：
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
2. 本地验证：
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
3. 提交后打 tag：
```bash
git tag v0.2.0
git push origin v0.2.0
```
4. 等待 GitHub Actions `release` workflow 完成：
- macOS（x86_64 + aarch64）构建
- Windows（x86_64）构建
- macOS codesign + notarize
- 自动上传 release 资产

## 4. latest.json 生成

### 4.1 自动生成（推荐）
- 当前 workflow 使用 `tauri-apps/tauri-action` 且启用了 `uploadUpdaterJson: true`。
- 每次 tag 发布会把 updater JSON（含平台包 URL/签名）上传到 GitHub Release。

### 4.2 手动生成（应急）
- 确保每个平台安装包和对应 `.sig` 已存在。
- 典型结构示例：
```json
{
  "version": "0.2.0",
  "notes": "Release notes",
  "pub_date": "2026-02-14T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "url": "https://your-cdn/app-x86_64.app.tar.gz",
      "signature": "..."
    },
    "darwin-aarch64": {
      "url": "https://your-cdn/app-aarch64.app.tar.gz",
      "signature": "..."
    },
    "windows-x86_64": {
      "url": "https://your-cdn/app-x64-setup.exe",
      "signature": "..."
    }
  }
}
```
- 上传该文件到你在 `endpoints` 中配置的地址（例如 `https://your-cdn/latest.json`）。

## 5. 回滚策略

### 5.1 推荐回滚（热修复版本）
- Updater 默认只升级到更高版本，不建议“降级版本号”。
- 回滚时从最后一个稳定 commit 打一个更高 patch 版本（例如坏版本 `0.2.0`，回滚发 `0.2.1`），重新发布。
- 让 `latest.json` 指向该稳定热修复版本。

### 5.2 紧急止血
- 暂时将线上 `latest.json` 固定到当前确认稳定的版本，阻止继续推送坏更新。
- 同时在 GitHub Release 标记问题版本（例如编辑 release notes 说明不可用）。

## 6. 检查更新按钮
- 设置页已接入“检查更新”按钮，调用 updater `check` 接口。
- 仅做检查，不自动下载安装；便于先验证更新链路与签名配置是否正确。
