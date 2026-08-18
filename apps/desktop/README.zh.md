# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

桌面客户端:Electron 壳,主进程启动内嵌的 `dsh web` 服务器——即 [apps/desktop-server](../desktop-server/README.md) 经 pnpm deploy 物化的闭包,跑在随包捆绑的真实 Node 运行时上(绝不用 Electron 内建 Node,服务端因此保持在被测试的 engines 线上,`node:sqlite` 与原装 N-API 预编译产物照常工作)——等到 `dsh web:` URL 行后在原生窗口里打开所服务的 UI。窗口是纯浏览器面:无 preload、无 Node 集成;外部链接交给系统浏览器。退出时拆除整棵服务器进程树(SIGTERM + 超时升级;Windows 走 `taskkill /T`)。

## 构建安装包

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

产物落在 `apps/desktop/dist-app/`。流水线按 python/sdk-runtime 配方暂存服务端(legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接),删掉本机编译的原生 `build/` 树以强制走多平台预编译产物,补齐 macOS 安装时跳过的平台分包可选依赖的 win32-x64 成员,再按平台暂存 Node 运行时(`--skip-repo-build` / `--skip-deploy` 复用既有产物)。

## 信任与签名

产物是未签名的开发构建:macOS Gatekeeper 在非构建机上需要右键打开(或 `xattr -dr com.apple.quarantine`),Windows SmartScreen 会弹未知发布者提示。Windows 包只做了交叉构建与结构校验——交付前务必在真实 Windows 机器上冒烟。

## 服务器环境

服务器在用户主目录启动,环境为 GUI 继承环境加标准 shell PATH 条目(macOS GUI 应用以 launchd 的极简 PATH 启动)。`DEEPSEEK_API_KEY` 走常规凭据链(环境变量 → 托管存储 → `.env`),首启无 key 也能进 UI,在模型设置页补录。服务器输出追加到应用日志目录的 `dsh-server.log`。

## Known Limitations and Deferred Work

- 无自动更新:换包即更新(与 CLI 相同的 npm 发布节奏)。
- Windows arm64 与 Linux 桌面目标未构建;node-pty 预编译已覆盖 win32-arm64,缺口只是打包工作。
- 开发启动(`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`)用的是检出目录的已构建 CLI 和 PATH 里的 Node,不是暂存资源。
