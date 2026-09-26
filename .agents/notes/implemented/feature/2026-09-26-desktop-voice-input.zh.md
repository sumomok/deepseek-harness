# Agent Note: The desktop ships upstream's voice input switched off

Status: implemented

[English](2026-09-26-desktop-voice-input.md) | 中文

## 问题

在 dsh 0.1.7-rc.2 上,`@deepseek-ai/dsh` 依赖 `@deepseek-ai/dsh-experimental-voice-input-bundle`,它是上游 `OPTIONAL_BUNDLES` 之一,所以桌面服务端闭包带着它。它的识别器 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` 加载 `sherpa-onnx-node`,后者按 `os.platform()` 与 `os.arch()` 拼出的相对路径 require `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`,并且用 `win` 代替 `win32`。

载荷流水线在三处丢了这个成员。`bundle-closure.ts` 把 `sherpa-onnx-darwin-arm64` 当作无人引用删掉了,因为相对路径不指名任何包,于是载荷门禁让 macOS 打包失败。`stageWindowsVariants` 只补名字里含 `win32-x64` 的可选依赖,所以从不补 `sherpa-onnx-win-x64`,而且会拿 `^1.13.8` 这个字面字符串去拉。门禁的 `variantOf` 不把 `win` 当平台,所以既看不见 Windows 成员从 Windows 载荷里缺失,也看不见它混进 macOS 载荷。

页面在应用窗口里用 `getUserMedia` 录音。应用窗口跑在 Electron 的默认 session 上,这个 session 没有权限处理器,而没有处理器时 Electron 对每个 frame 放行每种权限。macOS 包没有声明 `NSMicrophoneUsageDescription`,hardened runtime 也没有 `com.apple.security.device.audio-input` entitlement。

## 决策

**语音输入按上游的出厂方式随包:在载荷里,默认关闭。**桌面组合层不为它加行。由人在上游的插件页打开它。第一次下载模型,只发生在这个人在插件详情里按下**下载并准备**的时候:约 239 MB 的 INT8 SenseVoice 模型、0.3 MB 的 tokens 与 1.8 MB 的 Silero VAD,来自 `huggingface.co` 或 `hf-mirror.com`,存进 `$DSH_HOME/speech-to-text/sensevoice/models/`。

**两个平台的成员都点名,每份载荷只留自己的。**`apps/desktop-shell/scripts/bundle-closure.ts` 的 `NATIVE` 点了 `sherpa-onnx-node`、`sherpa-onnx-win-x64` 与 `sherpa-onnx-darwin-<arch>`。`platform-dir-rules.ts` 的顶层规则把 `sherpa-onnx-` 当作与 `node-addon-require-builtin-` 一样的平台分包家族,在两个目标上按名字保留 `sherpa-onnx-node`,只留目标平台自己的成员。`namesWindowsX64` 同时认 `win32-x64` 与 `win-x64`。`pinnedVariantVersion` 把版本范围钉到本机已装兄弟成员的那一个版本上,因为这些成员一起发布,更新的 Windows 成员可能配上更旧的 JavaScript 入口;兄弟成员给不出唯一版本的范围会让构建失败。`payload-gate.ts` 把 `win` 这一段读作平台 `win32`。

**只有应用窗口里嵌入服务端提供的页面能打开麦克风。**`apps/desktop-shell/src/microphone-permissions.ts` 移植上游的 `apps/desktop/src/microphone-permissions.ts`,上游检查 `dsh-app:` scheme 的地方,这里改为把请求 URL 与运行中服务端的 origin 比对。`media` 只放行给应用窗口里该 origin 的主 frame、只限音频,macOS 上还要 `systemPreferences.askForMediaAccess('microphone')` 回答允许之后才放行。其余权限保持 Electron 的默认答复。渲染窗口与登录窗口跑在各自拒绝一切的 partition 上。`electron-builder.yml` 加上 `NSMicrophoneUsageDescription`,`build/entitlements.mac.plist` 加上 `com.apple.security.device.audio-input`。

## 备选方案

**像扣下 auto-review 那样扣下语音输入 bundle。**否决:发版负责人决定在 0.1.0-rc.34 带上它,而且与 auto-review 不同,这个 bundle 不与桌面已有功能重复。

**保留 Electron 的默认权限答复,靠系统弹窗。**否决:那样会把麦克风放行给对话列或内容列嵌入的任何 frame、任何来源,并且把 macOS 弹窗交给 Chromium,而不是在页面录音之前先问。

**拉取范围允许的最新版本。**否决:它可能让 Windows 二进制配上更旧的 `sherpa-onnx-node`,macOS 成员与 Windows 成员也会来自不同的发布。

## 后果

无论有没有人打开语音输入,macOS 载荷都增加约 34 MB,Windows 载荷增加约 23 MB。两个模型来源都连不上的机器用不了语音输入。

Windows 载荷在 macOS 上交叉构建,只核对了在不在。`sherpa-onnx.node` 在随包 Node 运行时下能不能从 `sherpa-onnx-win-x64` 加载它的 DLL,以及 Windows 隐私设置里允许桌面应用使用麦克风的开关是否打开,要在真实 Windows 机器上录一次音才知道。macOS 上,打包那次运行核对了签名后应用里的随包 Node 运行时能加载 `sherpa-onnx-node`;麦克风弹窗只在真机上核对。

以后上游再来一个平台成员换了拼法、或者靠相对路径 require 的包,都要做同样三处改动:`NATIVE`、平台规则、门禁对它平台段的解读。

## 相关

[0.1.7-rc.2 基座上的桌面载荷与启动门禁](../process/2026-09-26-desktop-payload-on-the-rc2-base.zh.md)记录同一基座上闭包的其他决定;[桌面载荷裁剪门禁](../process/2026-08-20-desktop-payload-prune-gate.zh.md)记录门禁的各项检查;[插件管理交给上游](2026-09-26-desktop-plugin-management-on-upstream.zh.md)记录打开这个 bundle 的插件页。
