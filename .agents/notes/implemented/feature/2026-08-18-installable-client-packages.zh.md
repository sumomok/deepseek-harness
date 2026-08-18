# Agent Note: 可安装客户端包

Status: implemented

[English](2026-08-18-installable-client-packages.md) | 中文

## Problem

dsh 有两种应用形态——CLI 和由它 serve 的 `dsh web` 浏览器 UI——以及 npm 与 PyPI 两条分发通道。GUI 产品被期待的三个日常表面:Windows 桌面、macOS 桌面、手机,都没有可安装客户端。三者必须只来自组合层:上游包、`apps/web` 与前端构建保持零改动,检出目录才能持续 fast-forward。

## Decision

三个增量叶子覆盖三个表面,每个都骑在平台已有的扩展点上。

**手机 — `apps/pwa`。** 一个 host 面函数插件以命名 webserver 路由注册 `/manifest.webmanifest`、`/sw.js` 与 `/pwa/*` PNG 图标,并经 `webServer.tapIndex` 注入缺失的 head 引用。manifest 路由在同一 URL 上遮蔽前端自带的最小静态清单,dist 里既有的 `<link rel="manifest">` 因此解析到完整的 standalone 清单,tap 不再注入重复 link。包声明 `dsh.bundle`,`dsh plugin --profile web add` 即激活为 profile 层,无需任何旗标。LAN 暴露保持选择性开启:尊重上游对 `--host 0.0.0.0` 的拒绝,`overlay/lan.patch.yml` 是绑定全部接口的显式补丁,依托 web-app 信任栅栏的 LAN 采样。

**桌面 — `apps/desktop` + `apps/desktop-server`。** `apps/desktop-server` 是纯依赖 deploy root(python/sdk-runtime 模式),`@deepseek-ai/dsh` 闭包整个 `dsh web` 运行时含前端 dist,vendor 框架三件因 deployer 跳过 `link:` 覆盖包而显式列出。`apps/desktop/scripts/package.ts` 按 build-exe 配方暂存——legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接——删除本机编译的原生 `build/` 树以强制走多平台 N-API 预编译产物(node-pty 带 darwin/win32,koffi 全平台),补齐 macOS 安装跳过的平台分包可选依赖的 win32-x64 成员,并按平台捆绑真实 Node v24 运行时。Electron 主进程用该 Node 起部署好的 `bin.js web --port 0`,以 `dsh web:` 行为就绪信号,在沙箱化无 preload 的窗口里打开 URL,退出时拆除进程树。electron-builder 产出 macOS zip+dmg(arm64)与交叉打包的 Windows NSIS x64 安装器;`pnpm-workspace.yaml` 增加 `allowBuilds: electron`(并拒绝 `electron-winstaller`)。

## Verification

PWA 层对着真实启动验证:路由返回期望内容、注入后的 head 恰有一条 manifest link、`127.0.0.1` 上的真实 Chrome 报告 service worker 以 scope `/` 激活且 standalone 清单解析成功。macOS 包在构建机上实际启动并使用。Windows 安装器经交叉构建后做结构校验(win32-x64 预编译、注入的可选变体、捆绑的 node.exe)并复算 NSIS 启动 CRC——对 [0x200, archiveEnd−4) 做 CRC32 与末尾双字比对——该校验在每次 Windows 构建后由流水线强制执行;首次真机安装恰好撞上"integrity check failed"对话框,因此无证书的签名步骤已禁用(`win.signExecutable: false`),此闸保证该故障无法再次出厂。安装器之外的行为分发前仍需真实 Windows 冒烟。

## Alternatives considered

- **Tauri 而非 Electron。** 产物更小,但 macOS 上交叉构建 Windows 安装器需要 Windows 机器;而服务端反正要带 Node 运行时——壳的重量不等于载荷的重量。
- **Electron-as-Node(`ELECTRON_RUN_AS_NODE`)而非捆绑真实 Node。** 省一份运行时下载,但服务端被搬到 Electron 的 Node ABI 与特性集上:`node:sqlite` 可用性和所有 N-API 预编译假设都要随 Electron 升级重新验证。捆绑 v24 让服务端留在被测试的 engines 线上。
- **只做"连接远程服务器"的壳、不内嵌服务端。** 跨平台是容易了,但产品要另装一份 dsh 才可用,那不是可安装客户端。
- **fork `apps/web` 往 dist 里塞 PWA 文件。** 被零上游改动约束否决;webserver 的 index tap 与命名路由存在的意义正是让组合层做这件事。
- **Capacitor/React Native 手机应用。** 后端跑不了在手机上,原生壳仍是远程客户端;它带来签名链与移动工具链(构建机上没有),却没有 PWA 缺失的能力。

## Consequences

三个表面纯靠组合层交付,新增本身就是扩展点的活证:`dsh.bundle` 自动激活、`link:` 装进 profile、index tap、命名路由、deploy-root 暂存配方。代价是背上 Electron 依赖(开发下载约 110 MB,未签名产物约 200 MB)、一份要随 engines 一起升的 Node 运行时钉版,以及一个在本仓库 macOS-only 开发环内无法冒烟的 Windows 产物。会话事件、模型可见面、SDK 投影均未变化,快照面不受影响。签名、公证、自动更新、商店分发、Windows arm64 与 Linux 桌面是记录在包 README 里的刻意非目标。
