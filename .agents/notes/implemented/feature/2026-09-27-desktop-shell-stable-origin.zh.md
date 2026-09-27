# Agent Note: Desktop shell: a stable served-UI origin, the loading page's text, and shortcut combinations

Status: implemented

[English](2026-09-27-desktop-shell-stable-origin.md) | 中文

## Problem

自定义快捷键每次重启后都没了。web 客户端把它们存在 `localStorage['dsh.keybindings.v1']`,它属于源 `http://127.0.0.1:<端口>`;壳以 `--port 0` 启动服务器,于是每次启动都从一个存储为空的新源提供 UI。客户端放在 localStorage 里的其他东西(对话区宽度、右侧栏布局、对话草稿)同样如此,`dsh-auth-*` cookie 也是,每次启动多一条,直到 0.1.0-rc.34 开始清理。

快捷键编辑器还以「此浏览器暂不支持该组合」拒绝大多数组合。只有 `Ctrl/Cmd+/`、`Ctrl/Cmd+,`、`Ctrl/Cmd+Alt+键`、`Ctrl/Cmd+Shift+键` 以及三个以上修饰键能通过,因为服务出来的 UI 运行在客户端的 `web` 快捷键运行时里(`packages/client/shortcuts/src/configuration.ts:111`、`binding.ts:96-112`)。

更新重启后,窗口在标题「北冥」之下显示 `HARNESS` 和 `Loading plugins…`。壳自己的启动页是中文的;这段文字来自 web 客户端在语言加载之前的加载页 `packages/client/web/src/boot-page.ts:37,40`,`Failed to load plugins` 在 `:90`。

## Decision

### 复用服务器端口

`src/server-port.ts` 让源保持不变。正在运行的服务器的端口写进 `desktop-state.json` 的 `serverPort`;下一次启动依次在 `127.0.0.1`、`0.0.0.0` 和 `::` 上监听来检查它(机器没有的地址族跳过;在 macOS 上通配地址的监听不妨碍回环地址的监听,只查回环地址会漏掉它),再把它作为 `--port` 传入。检查放在清理遗留服务器之后,因为遗留进程可能还占着这个端口;也放在渲染服务与更新服务之后,它们绑定端口 0,可能恰好落在这个端口上。端口被占用就退回 `--port 0`;在检查与绑定之间被抢走也一样:`dsh web --port N` 遇到被占用的端口会以 1 退出,输出里带 `listen EADDRINUSE`(在临时 home 里对构建好的 CLI 实测),`startOnPort` 认出它并重试一次。崩溃后的换绑一律以 `--port 0` 启动,并记下新端口;原因见下面讲登录的一段。`desktop-state.json` 先写临时文件再改名覆盖旧文件,写到一半崩溃也不会把它清空、连带丢掉 `installedUpdate`。

浏览器存储不复制到退回后的源。Electron 没有在主进程里把一个源的 localStorage 复制到另一个源的 API;退回只在别的进程占着端口时发生,那时丢失的正是以前每次启动都会丢的。

固定端口给登录带来一处变化。`dsh-auth-*` cookie 写明所属的 authority,用 Harness home 跨进程保存的密钥签名(`packages/client/connection/src/browser-auth.ts:287-299` 只检查 authority、有效期和签名),所以一次启动签发的 cookie,在过期之前对下一次启动在同一端口上的服务器有效。本机进程要拿到一份副本,只能在服务器已经没了、窗口还在往那个端口发请求时去监听它。崩溃之后这段时间一直持续到换绑,所以换绑改用新端口:旧端口上从此没有这条 cookie 能用的服务器,下一次启动记住的也是新端口。退出时服务器停下的过程中窗口还开着,所以壳先删掉自己的 `dsh-auth-*` cookie 再停服务器。两次启动之间窗口已关,什么也不发。删除之前被拿走的副本不会因删除而失效;这一点被接受,因为拿到它需要一个本机进程恰好在那一刻监听那个端口,而另一种做法——每次启动换新端口——每次重启都会丢掉全部浏览器偏好。其余不变:窗口只加载服务器子进程打印的 URL,其中的启动令牌每次启动都是新的;`will-navigate` 让窗口留在那个服务器的源上,现在按解析后的源比较,因为原先的前缀判断会放过 `http://127.0.0.1:P@evil.example/`;每次启动前仍清掉陈旧的 cookie;先抢到端口的进程得到的是退回,而不是窗口。

源稳定之后,`dsh.keybindings.v1` 能跨重启保留,不需要桌面快捷键运行时就修好了报告的丢失。

### 加载页的文字

这个页面属于 `packages/client/web`,本 fork 不改它。`src/app-boot-text.ts` 在 `did-navigate` 与 `dom-ready` 时用 `webContents.insertCSS` 插入一份样式表,把三段文字画成零字号,通过 `::after` 画出 `北冥` / `正在加载插件…` / `插件加载失败`;或 `Beiming` 与英文原文。语言取设置里选的那种,从桌面 profile 的 `locale` 行(没有则 `settings.yaml`)读取,读法与主题偏好相同;没有选择时取 `app.getLocale()`,也就是菜单标签的规则(`src/menu-text.ts` 的 `shellLanguage`);每次页面加载都重新读取。读屏软件可能把这个页面读两遍,因为被隐藏的文字仍在文档里,`::after` 内容也会暴露出来;样式表设不了 `aria-hidden`。选择器只用 `data-dsh-boot`、`data-dsh-boot-spinner` 和子元素顺序,一个客户端测试拿上游的 `BootPage` 检验它们。样式表生效之前是否仍会先画出一帧英文,要在真机上检查。

### 快捷键组合

组合规则不改。客户端按 `document.documentElement.dataset.platform` 判定运行时(`packages/client/shortcuts/src/client/dom.ts:17-19`),`desktop` 运行时在 macOS 与 Windows 上接受任何组合(`configuration.ts:98`)。不改 `packages/` 而进入它,壳必须同时做到下面几件:

- 一个沙箱 preload,设置 `data-platform`,并暴露带 `keyboard` 与 `shortcuts` 的 `window.dshDesktop`。没有 `keyboard` 时快捷键服务在构造时就抛出 `Desktop keyboard bridge unavailable`(`packages/client/shortcuts/src/client/index.ts:46`),没有半开的模式。
- 一个主进程 `before-input-event` 拦截器,等同上游 `apps/desktop/src/keyboard.ts`(261 行),以及等同 `keybindings.ts` 的文件持久化:在 macOS 与 Windows 上有了 keyboard 桥,DOM 投递就只喂固定动作(`index.ts:71`),没有拦截器就没有任何可配置快捷键会触发。
- 一个不同于上游 `darwin`/`win32` 的 `data-platform` 值,例如 `macos`/`windows`。ui-layout、ui-conversation、dockkit 与 `packages/client/web/src/base.css` 里的 `darwin` 选择器假定的是上游那种 hiddenInset、带 vibrancy 的窗口(页面背景透明、给红绿灯让位、拖动区域),壳的标准边框窗口没有这些。
- 为壳今天不带的代码打包:拦截器需要把 `@deepseek-ai/dsh-client-shortcuts/protocol`(以及经由它的 `dsh-util-values`、`dsh-brand`、`dsh-util-crypto`)放进 asar,沙箱 preload 必须是 CommonJS 包,而壳的主进程只是普通的 `tsc` 输出。

`window.dshDesktop` 并不只属于快捷键。`'dshDesktop' in globalThis` 还会关掉模型页的自动凭据引导和它的欢迎须知(`packages/client/ui-settings-models/src/client/index.ts:81,147`);那里是 `&&`,没有哪个配置值能再打开它们,而本 fork 没有自己的引导。同一个标记还让 `ui-settings-account` 挂出账号与桌面引导界面(`ui-settings-account/src/client/index.ts:43,211`),`account-controller` 在 web-app 包里,所以它会挂上;要压住它就得在 `apps/desktop-app/cordis.patch.yml` 里禁用那一行。`@haoran/dsh-desktop-update` 的设置触发按钮也依赖那个插件什么都不注册。

所以壳留在 `web` 运行时。采用 `desktop` 运行时,意味着接受首启凭据引导的丢失,或者修改 `packages/` 里的 `dshDesktop` 检查;这是一项产品决定。

## Alternatives considered

**自定义协议源,即上游的 `dsh-app://app/`。**它把端口从源里拿掉,但经 `protocol.handle` 提供 UI 需要上游的 host-protocol 与 platform-view 那一套,而 UI 的 `/api/remote.mux` WebSocket 过不了协议处理器。

**用 `--host-resolver-rules` 把固定主机名映射到回环地址。**它只固定了主机部分,源里仍带着端口。

**用 preload 改写加载页的文字。**preload 里的 `MutationObserver` 或 `webFrame.insertCSS` 比主进程的 `insertCSS` 生效得早,但壳没有 preload,它的打包与快捷键桥是同一份未完成的工作。主进程插入两样都不需要。

## Consequences

服务出来的 UI 在多次启动与更新之间保持同一个源,所以自定义快捷键和其他 localStorage 偏好都能保留。崩溃换绑会把 UI 移到一个新源,那些偏好在那里从空开始,直到下一次修改;之后的启动沿用这个源。记住的端口被别处占用的那次启动,会从空源开始一次,之后沿用新端口。固定端口对本机其他进程可见,它们能做的只是抢占它、触发退回。加载页显示产品名与壳的语言,样式表到达之前画出的帧除外。自定义快捷键仍只接受浏览器那一套组合。
