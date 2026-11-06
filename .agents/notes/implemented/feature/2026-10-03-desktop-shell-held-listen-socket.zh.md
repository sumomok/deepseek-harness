# Agent Note: Desktop shell: the shell holds the served UI's loopback socket, so a crash rebind keeps the origin

Status: implemented

[English](2026-10-03-desktop-shell-held-listen-socket.md) | 中文

## Problem

服务器意外退出后,窗口会换到一个新源。[稳定源的决定](2026-09-27-desktop-shell-stable-origin.zh.md)让各次启动沿用同一个端口,但崩溃换绑用的是系统挑的端口,而 web 客户端保存的一切都在按源划分的 localStorage 里:打开的会话(`dsh.sessions.current`,`packages/client/ui-workspace/src/client/navigation.ts`)、正在输入的草稿(`dsh.conversation.<sessionId>`)、快捷键与布局。客户端不往 URL 里放任何东西,所以重新加载时没有参数能把它们带过去;一个没有选中会话的源还会复用或新建一个空白会话。一台 macOS 的日志里,一天内有两次崩溃换绑,端口依次是 52520 → 62913 → 63222。

换端口是安全上的应对,不是意外。`dsh-auth-*` cookie 写明它的主机与端口,并用 Harness home 保存的密钥签名,所以对同一端口上后来的任何服务器都有效。没有服务器运行时,窗口和壳自己的通知流都还在连这个端口,于是绑定了它的本机进程可以收到 cookie,或者应答窗口:画出伪造的审批卡或设置表单,或者让页面在这个源里运行它给的脚本。直接再用同一个端口比换新端口更糟:在那里运行过的脚本可以注册一个 service worker,截下下一次 `/?token=` 导航,换到一个 30 天有效、能使用全部 agent API 的 cookie。

## Decision

### 壳占着套接字

启动时,在 `choosePort` 之后、第一个服务器启动之前,壳自己用 `net._createServerHandle`(Node 的 cluster 主进程用的那个 bind)绑定 `127.0.0.1:<端口>`,一直占到进程退出(`apps/desktop-shell/src/listen-socket.ts`)。壳从不在它上面 accept。所有副本指向同一个内核套接字,它从第一次 listen 起就处于监听状态:macOS 上是第一个子进程的 listen,Windows 上是壳自己那份,因为 libuv 在发送监听句柄的进程里调用 `listen()`(`src/win/tcp.c` 的 `uv__tcp_xfer_export`)。只有 `getsockname` 报告的是 `127.0.0.1` 和所请求的端口,这个句柄才被接受:libuv 把 `EADDRINUSE` 推迟到 listen 时才报,而子进程在这样一个没绑上的句柄上监听,会绑到 `0.0.0.0` 上一个系统挑的端口(macOS 实测)。选定的端口占不住时,改占一个系统挑的端口,这次启动像以前一样从新源开始。

每个服务器子进程启动时带 `--import lib/listen-handoff.mjs`、一条 IPC 通道和 `DSH_DESKTOP_LISTEN_HANDOFF_PORT`。预加载(`src/listen-handoff.mts`)在 worker 线程里或没有这个变量时什么也不做,否则:

- 删掉这个变量,注册自己的 `message` 监听,然后写出 `dsh-desktop listen handoff: ready`;壳见到这一行才发送套接字,因为在监听注册之前到达的消息会被丢弃(实测);
- 套接字一到就关闭 IPC 通道,早于任何服务器代码运行,所以服务器运行的任何东西都无法往壳的主进程写入,也继承不到这条通道;壳从不注册 `message` 监听;
- 替换 `net.Server.prototype.listen`,第一个请求 `127.0.0.1` 上该端口的调用(位置参数,即 `@deepseek-ai/dsh-host-webserver` 用的写法,或选项对象)改在套接字上监听,其他调用原样放行;
- 这次监听之后,检查服务器确实监听在 `127.0.0.1` 和该端口上,并在 CLI 的 URL 行之前、在同一个输出流上写出 `dsh-desktop listen handoff: listening on 127.0.0.1:<端口>`;
- 任何失败都写出 `dsh-desktop listen handoff failed: <原因>` 并以 1 退出,对该端口的第二次 listen 也是如此:那时它自己那份套接字已经关闭了。

壳一侧(`src/server.ts` 的 `startServer`)只在见到 `listening` 行之后、并且端口是占着的那个时,才接受 URL 行。失败行、发送出错、接过套接字之前退出,或没有 `listening` 行的 URL 行,都以 `ListenHandoffFailed` 拒绝。壳不从自己这一侧关闭通道:父进程调用 `disconnect()` 之后,Node 24 不再为子进程发出 `close`,每次退出都要等满 2 s 的输出排空上限。

### 占着套接字时的崩溃路径

从占用成功到壳退出,发往 `127.0.0.1:<端口>` 的连接要么被壳当前的服务器子进程 accept,要么在套接字的队列里等待;别的进程都 accept 不到。这只依赖一条事实:地址一直由壳绑定着,所以没有子进程运行时,别的进程再绑定它会得到 `EADDRINUSE`,而在同一端口上绑定通配地址收不到任何发往回环地址的连接(两者都在 macOS 上由 Node 24.15 和真实的 Electron 43.4.0 主进程实测)。另一条事实只影响用户看到的结果:子进程死后套接字仍处于监听状态,因为壳那份副本让它一直开着,所以这期间发出的请求由下一个子进程应答(macOS 实测;Windows 上那份副本正是 libuv 调用过 listen 的那个,按 libuv 源码同样成立,由 Windows 探针检查)。在 Windows 上,libuv 既不设 `SO_REUSEADDR` 也不设 `SO_EXCLUSIVEADDRUSE`,所以普通绑定同样失败;而设置了 `SO_REUSEADDR` 的同一用户进程能绑定到这个地址上,就像它能绑定到正在运行的服务器的套接字上一样。在 Linux 上,设置了 `SO_REUSEADDR` 的套接字(libuv 在那里每次绑定都会设置)可以绑定一个没有套接字在监听的地址,所以第一条事实要从第一个子进程监听之后才成立;这个应用只为 macOS 和 Windows 打包。

所以意外退出时(`src/server-lifecycle.ts` 的 `respondToCrash`)先停掉通知流,保留记住的端口,删掉 cookie,再进入恢复阶梯;换绑(`rebindOnHeldSocket`)在同一个套接字上启动下一个子进程,窗口带着新的启动令牌重新加载回同一个源。安装失败后的重启也这样在套接字上启动,不经过 `choosePort`,因为它的探测会撞上壳自己的绑定,把端口报为被占用。整个应用重启时套接字随进程释放;下一个实例像任何一次启动一样请求记住的端口,而那时没有窗口开着。

### 降级

在套接字上启动时,若以 `ListenHandoffFailed` 失败,或在预加载写出 `listening` 行之前以 `listen EADDRINUSE` 失败(预加载没有接住这次调用,服务器自己的绑定撞上了壳的绑定),壳关闭套接字,记一行 `[desktop] listen handoff unavailable (<原因>); this run changes origin on every crash rebind`,然后不带套接字启动服务器:启动时用选定的端口,这次运行里还没有窗口到过那个源;崩溃换绑和安装失败后的重启都用系统挑的端口,先忘掉记住的端口、再关闭套接字,因为可能有窗口还开在占着的那个源上。这次运行此后的行为与这个决定之前相同。启动时一个端口都没占住,也落到同样的状态。

### 两种情况都适用的规则

- 每次意外退出都在恢复阶梯之前停掉通知流(`stopNotifications`)。这个决定之前,曾经就绪的通知流会保留内存里的 cookie,每隔几秒重连死掉的端口,并用旧的启动令牌再换一个 cookie,直到换绑把它替换掉;停止对话框被关掉之后则永远不停。
- 停止对话框还在屏幕上或已被关掉时,没有窗口时把应用带到前台(macOS 的 Dock)会转到这个对话框,而不是打开一个等着已停止服务器的窗口;在对话框里重试成功后再打开窗口(`src/server-lifecycle.ts` 的 `createStoppedDialog`)。
- 让 web 服务器那一行重启的 profile 改动会让它第二次 listen;占着套接字时进程随即退出,恢复阶梯在同一个套接字上换绑。在临时 home 里用构建好的 CLI 实测:改 `webserver` 行的配置时如此;加一行无关的插件、或原样重述这一行时不会。

### 打包与检查

electron-builder 把 `lib/listen-handoff.mjs` 解包到 `app.asar.unpacked`,因为打包带的 Node 读不了 asar;它是 `.mjs`,上面没有 package.json 也按 ESM 加载;缺了它,`scripts/after-pack.cjs` 让构建失败。`scripts/staged-boot-gate.ts` 的 `verifyHeldSocketBoot` 通过壳自己的 `startServer`,在同一个占着的套接字上把暂存的载荷启动两次,所以上游改了 web 服务器的 listen 写法会让构建失败,而不是让每一处安装都降级。`render-smoke` 运行的 `scripts/listen-handoff-smoke.mjs` 在 Electron 主进程里再做一遍交接。`tests/listen-handoff.spec.ts` 用真实进程运行两侧。

## Alternatives considered

**把 localStorage 搬到新源。** 原型在进程内读旧源、写新源,借助以 `baseURLForDataURL` 提交到各自源下的 `data:` 文档,对两个端口都不发请求。它输在安全性上:占着旧端口的进程可以在被放弃的源里运行它的脚本(用户手动刷新,或客户端 HMR 的 `EventSource` 重连后收到一帧 graph,去导入一个同源脚本),写入任意 key,搬运再把它们搬进已登录的源,而且每次崩溃都会再搬一次。它只作为启动降级的候选保留,那种情况下这次运行里没有窗口到过旧源。

**转发器:壳占着稳定端口,转发到子进程自己的端口。** 到子进程端口的这一跳重现同样的竞态,而且稳定端口的 cookie 会送到抢到子进程端口的进程手里;每个字节还都要经过 Electron 的主线程。

**看到退出后再去绑定端口。** 子进程死掉时内核就释放了端口,壳最晚 2 s 后才得知;循环绑定的进程会抢先。而且仍然需要交接才能把套接字交给下一个子进程。

**给 `@deepseek-ai/dsh-host-webserver` 加一个继承套接字的监听选项。** 它去掉了预加载的隐式耦合,但这是上游改动(配置、启动标志、CLI 参数、bundle 补丁),fork 每次同步都要带着;而预加载在 fork 自有的壳里就能做到,失配时只降级并记一行日志。

**不占用、直接在同一端口上换绑。** 因 Problem 里的 service worker 原因而不安全。

## Consequences

崩溃换绑保持源不变,窗口回到打开的会话,草稿还在,包括没有服务器运行时敲的字;整个应用重启时,只要端口仍空闲也保持源。空窗期间没有别的进程能在这个端口上 accept,比以前更强:以前从子进程死掉那一刻起端口就空着。

代价是预加载与 web 服务器的 `listen(port, '127.0.0.1')` 调用隐式耦合、asar 之外多一个文件,以及服务器进程在最初几毫秒里带着一条 IPC 通道。这个调用一旦改变,这次运行降级为以前的行为并记一行日志,而暂存启动会先让构建失败。让 web 服务器那一行重启的 profile 改动,现在要付出一次服务器重启和一次窗口重新加载,恢复阶梯把它算作一次意外退出。记住的端口被别处占着的启动,仍然从空源开始。两条事实在 Windows 上的表现,以及打包后的 Windows 构建上的交接,要在发布前在 Windows 机器上检查;若第一条在那里不成立,这个决定由「搬运,并拦截发往被放弃源的请求」取代。
