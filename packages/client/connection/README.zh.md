---
description: "Web GUI 的浏览器与 Host 之间的协议层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

静态桌面页面可以通过 `__DSH_TRANSPORT__.streamBaseUrl` 提供其所拥有 Host 的 HTTP origin。Gateway 将该 origin 用于 WebSocket，HTTP 传输仍独立选择。桌面载体负责认证；仅设置 origin 不会授予访问权限。

一元 RPC 请求使用 JSON。Host handler 可以返回已经从 JSON 兼容结果值中分离的字节附件，每个附件标明其相对于结果的路径。Connection 将这些值写为 multipart 部分。JSON `metadata` 部分包含带 `null` 占位值的 RPC 响应信封，以及记录各路径、codec 和部分标识符的附件表。路径使用字符串键与数字数组下标，不保留任何业务字段名。Client 校验信封、`rpcId`、附件表和各部分，再将每个字节值恢复为以 `ArrayBuffer` 为底层缓冲区的视图。没有附件的结果（包括 base64 字符串）与失败仍使用 JSON。逻辑 RPC 载体直接返回解码后的原生值。Connection 不识别二进制字段，也不依赖 Typert；拥有结果协议的 handler 在返回前执行按类型或按运行时值的投影。不支持二进制参数、事件和二进制流式结果。

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。由 shell 持有的组合通过 `connection.rpc.open` 提供等价的 Remote 流（包括流的上行），不打开 WebSocket。浏览器插件读取页面 transport、恢复设置与 location，再委托 `installConnection(ctx, options)`。持有自身载体的组合可以直接调用同一个安装函数；整机客户端测试档就是这一消费者。每次调用都会创建一个归所属 Context 的服务，因此同一 realm 中的多棵 Client 树可以使用不同载体。Host half 始终提供与载体无关的 RPC 注册表和精确 `GET`/`HEAD`/`POST` 路由注册表。存在 Web 载体时，它还持有唯一 `/api` route、Fetch bridge、浏览器认证与 Host/Origin 校验；由 shell 持有的载体则直接分派共享 Fetch handler。每条精确路由会在 bridge 读取任何字节前声明缓冲或流式请求体处理方式。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载、原始文件上传等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。浏览器原始请求体传输由 [`dsh-client-file-upload`](../file-upload/README.zh.md) 提供。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

每个 Host RPC 方法和 WebSocket 流都要求一个浏览器会话，不存在按方法区分的 loopback 层。每个进程生成一个随机启动令牌。`dsh-web-app` 打印并打开带 `?token=...` 的应用 URL，保留调用方的 authority 与挂载；`frontend-static` 把根路径和 index 请求交给 `ctx.connection.authorizeIndex`，后者只在 `GET /` 接受该令牌，写入绑定 authority 的签名 cookie，再重定向到干净的 `./`，移除令牌并保留请求目录。缺失、过期、畸形或 authority 不匹配的 cookie 会在 RPC 分发前得到 401。静态资源保持公开。HTTP 载体不在根路径交换之外接受 query token，也不接受 Authorization header token。

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录。本地提供方把它持久化到 `$DSH_HOME/.credentials.yaml`；`BrowserAuth` 在 Connection 激活期间加载或创建该记录，并把密钥留在内存中，因此请求认证同步执行。删除或替换该记录会在下一次 Connection 激活时生效。cookie 携带绝对签发与过期区间，`cookieMaxAgeDays` 默认设为 30 天，并在确定性名称与签名 payload 中同时绑定规范化 hostname 和 port。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`；随附服务器使用 loopback HTTP，因此刻意不设置 `Secure`。

认证之前，每个请求仍经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)与[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)。

每个被接纳的请求都代表一个 Peer。`ctx.connection.operator` 是操作者的 `PeerScope`：其 `ctx` 是拥有连接期注册的 Cordis scope，随 Connection 一起释放。`ctx.connection.admit(request)` 执行信任与认证检查，以拒绝状态或被接纳的 Peer 作答；`/api` 路由、专用 RPC 通道与 Gateway 的 WebSocket 升级都经它接纳，每个 RPC 处理器、精确 Fetch 路由与流都收到本次调用的 Peer。没有准入器时，每个被接纳的请求都代表操作者，除非设置了 `requireAdmitter`。共享 Fetch 处理器与 `bridge()` 以可选的最后一个参数接收被接纳的 Peer；不指明 Peer 的 shell 自有载体代表操作者。`OperatorPeer` 对外导出，供没有 Connection 的组合（例如 Gateway 的进程内载体）以同一约定拥有一个操作者 scope。

由一个 Host 服务多位成员的部署用 `ctx.connection.peers.admitWith(admitter)` 安装一个准入器。第二次安装会抛错；释放该注册或做出注册的 fiber，即恢复没有准入器时的接纳方式。准入器同步运行，只在 Host/Origin 校验与浏览器认证通过之后调用，对同一组请求头必须给出同一答案。它返回 `ctx.connection.peers.open()` 开出的成员 Peer、表示拒绝的 401 或 403，或 `undefined`。`undefined`、已释放的 Peer，以及任何不是 `open()` 返回的 Peer，都以 401 拒绝并记一条 error 日志，因此装了准入器以后，没有 HTTP 请求或 WebSocket 升级代表操作者。`requestRejection(request)` 向只用它把关的路由给出同样的判定。`peers.get(id)` 与 `peers.list()` 返回尚未调用 `dispose()` 的成员 Peer。`connection/peer-opened` 在 `open()` 返回之前发出，`connection/peer-closed` 在第一次 `dispose()` 完成后发出且只发一次；卸载 Connection 会释放仍开着的每个成员 Peer，操作者不发这两个事件。成员 Peer 不带身份：安装准入器的插件自己记录成员与 Peer 的对应关系。在精确路由运行、专用通道解码信封、`/api` RPC 拦截器解码请求之前，Connection 紧接着再核对一次 Peer：被接纳之后成员 Peer 的 `dispose()` 已被调用的请求（例如在桥接器缓存请求体期间，或 `connection/request`、`connection/fetch` 监听器 await 期间被释放）一个也到不了，答 401 `unauthorized`。操作者不再核对，且只按对象身份识别，即 `peer === ctx.connection.operator`；成员查找落空（例如准入器插件的对应表里查不到一个已释放的成员 Peer）不等于是操作者。`peers.memberAdmission` 在装了准入器或 `requireAdmitter` 为 true 时为 `true`；每次读取都报告当时的状态。决策记录：[一个 Host 服务多位成员](../../../.agents/notes/implemented/architecture/2026-10-05-console-member-peers.zh.md)。

把 Host Connection 行的 `config.requireAdmitter` 设为 `true`，则在没有安装准入器时，每个通过 Host/Origin 校验与浏览器认证的 HTTP 请求和 WebSocket 升级都以 401 拒绝；`requestRejection` 返回同样的 401，index 授权不受影响。这堵住了准入器所在插件 apply 之前以及它重启期间的空窗，默认值 `false` 会在这段时间把这类请求按操作者接纳。`requireAdmitter: true` 而组合里没有准入器插件时，Connection 会拒绝每一个这类请求；这种失败即关闭的结果是有意的。`ctx.connection.peers.requireAdmitter` 报告解析后的取值，因此为依赖默认拒绝的部署安装准入器的插件在加载时读取它，为 `false` 时拒绝启动，因为后面的配置层会整行替换 Connection 行。

通过认证的共享 HTTP 请求在传输请求体之前经过 `connection/request` waterfall。监听器可以拒绝新请求，或等待 `next()` 直到响应完成；释放所属 fiber 会移除准入行为。Desktop 使用此扩展点，在已批准的安装期间锁住新的 API 工作，而不取消已接纳的工作。客户端断开会中止处理函数的信号；桥接器停止写入 socket，并排空剩余响应块。WebSocket 流仍由 API Gateway 负责。

发往精确 Fetch 路由、或发往经 `rpc.handle` 登记的专用通道的每个请求，都在准入与桥接器处理请求体之后、路由运行或通道解码信封之前经过 `connection/fetch` waterfall。精确路由不拥有的请求（包括用它未声明的方法访问它的路径）照常分发、不经过这个 waterfall；RPC 拦截器分发的 `/api` 请求也不经过它，由 Gateway 的 `remote/invoke` waterfall 负责。监听器收到一个 `ConnectionFetchCall`——`kind`（`exact-route` 或 `channel`）、`path`（登记的路由路径或通道前缀；通道下的端点在 `request.url` 上）、`method`、Fetch `request`，以及准入的 `peer`（shell 自有的载体没有指明 Peer 时是 operator）——和 `next()`，后者把请求交给路由或通道，resolve 为它的 Response。监听器不调用 `next()`、直接返回自己的 Response 即为拒绝。通道前缀下的每个请求都会到达监听器，包括通道自己会答 404 的请求。监听器不得消费请求体，路由还要读它；监听器改读 `request.clone()`，读取流式请求的克隆会让请求体为路由缓存在内存里。监听器自己读掉请求体之后，路由就读不到它了：读取时抛错的路由像抛错的路由一样答复，即 400、body 为空并记一条 warning；附件存储为 `@deepseek-ai/dsh-attachment-local` 时，`/api/session/uploadFileBinary` 不存任何附件，答 200，`ok: false`，错误码 `session/attachment-invalid`，原因 `ATTACHMENT_WRITE_FAILED`；通道答 400 `body is not JSON`，尽管请求体是 JSON。不读请求体的路由（例如 `GET /api/file`）不受影响。监听器等待期间登记被撤销的精确路由（例如所在插件卸载）不会运行：`next()` resolve 为 404 `not found`，期间同一路径又登记了别的路由时也是如此。

Cordis 把同一个 `next()` 交给每个 `connection/fetch` 监听器：每次调用都运行下一个尚未运行的监听器，没有剩余时直接交给路由。所以监听器至多调用一次 `next()`；第二次调用（例如在它之后的监听器拒绝之后重试）会跳过所有已经运行过的监听器，一个监听器的拒绝只在它之前的每个监听器都调用一次 `next()` 时成立。路由或通道为 waterfall 结束前调用的 `next()` 产生的每个 Response，只要调用方收不到它、调用方收到的 Response 也不带它的 body（例如为加响应头而以该 body 构造的 Response 就带着它），Connection 就取消它的 body。waterfall 的结果没有 body 或其 body 已被锁住时，在 waterfall 结束时取消。否则调用方的 body 可能在调用方读它时才去读路由的 body，监听器经 `ReadableStream.from()`、异步生成器或在 `pull()` 里才取 reader 的流转交时就是这样，所以取消要等调用方把它的 body 读完、取消了它或读取失败。此时 Connection 交给调用方一个新的 Response：状态码、状态文本和响应头与监听器的相同，body 转交监听器的 body；它不保留监听器 Response 的 `url`、`redirected` 和 `type`，body 也不是字节流。HTTP 载体总会把 body 读完，所以经 HTTP 时取消总会执行；进程内的调用方不读 body 时，路由的 body 一直开着。waterfall 结束前调用的每个 `next()` 都已 resolve 为一个 Response、且调用方收到了该 Response 或其 body 时（没有监听器、或监听器返回 `next()` 的 Response 时就是这样），调用方收到的就是监听器的 Response 对象本身。Connection 按对象身份比较 Response 与 body，所以另一份 undici 构造的 Response 也按同样的规则处理。取消执行时仍未 resolve 的 Response 在 resolve 时取消，不推迟调用方。取消失败（例如监听器或调用方的 body 已锁住该 body）时忽略，没有监听器等待的路由 reject 也被吸收。Connection 拿到最外层监听器的结果或失败时 waterfall 结束，监听器返回前排入的 microtask 在此之前运行。waterfall 结束之后，到达路由或通道的 `next()` 调用不再分发，并以说明「`next()` 在 waterfall 结束后被调用」的错误 reject；尚未运行的监听器仍会先运行，可以自己答复这次调用。监听器丢弃这个 reject 时，留下的是它自己的未处理 rejection。监听器抛错，或 `next()` 交给的路由抛错，都让 Fetch 处理函数像路由抛错一样 reject，HTTP 载体答 400、body 为空并记一条 warning；专用通道对自己处理函数的抛错答 500，所以监听器在通道上抛错时的答复与之不同。没有监听器时每个请求直接交给它的路由或通道。`connection.fetch.list()` 返回当前生效的每个精确路由及其方法，`connection.rpc.channels()` 返回当前生效的每个专用通道，都按路径排序，供门禁测试逼每一项都有分类。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` 逻辑流注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、Remote 流报错、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。默认情况下，挂起的握手在 3 秒后记录 Host 响应缓慢告警，在 15 秒后记录就绪超时并中止，包含等待物理 socket 的时间。取消后，source 必须停止投递、释放资源并结束，替换 source 才能启动；已取消 source 迟到的 ready 不能发布 generation。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试，达到终档后继续尝试直到恢复。每次重试都要求 Gateway 替换一次物理 WebSocket，再重开 `$events`。

`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。只有 ready 项会发布 `connected`。Gateway mux 不拥有独立重试调度。

可通过 Host Connection 行的 `config.recovery` 覆盖重试上限、增长因子或握手告警与取消时间；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-connection)列出接受的字段。Host 校验这些值，并将其注入所提供的每个页面。Client 在提供 Connection 前校验启动数据，并在 Gateway 启动循环时采用这些默认值；显式传给 `start()` 的时序覆盖优先。增长因子必须是至少为一的有限数。若就绪、失败、取消或硬期限先于告警发生，该告警会被取消。修改 Host 恢复配置后需重新加载页面。


<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **缓冲型 `/api` 路由会把每个请求体保留在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）限制普通图片与 RPC 信封。显式启用的流式路由接收带背压的分块并绕过总量上限；路由实现负责持久化、取消与存储配额。
- **浏览器 cookie 不带 `Secure`**：当前随产品提供的传输方式是 loopback HTTP；若部署经明文网络暴露同一 authority，bearer cookie 可能在传输中泄露。
- **没有 logout 操作**：清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话。
- **在 `pull()` 里取路由 body 的 reader、又没有 `cancel()` 的转交，会让路由 body 保持打开**：`connection/fetch` 监听器返回的 Response 的 body 只在首次 `pull()` 里才取路由 body 的 reader、又没有定义 `cancel()` 时，调用方在首次 `pull()` 运行之后取消这个 body（首次 `pull()` 在调用方第一次读时运行；该 body 的 `highWaterMark` 大于 0 时，即默认情况下，构造后随即运行），该 reader 仍锁着路由 body，Connection 对它的取消失败，路由 body 不会被取消。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
