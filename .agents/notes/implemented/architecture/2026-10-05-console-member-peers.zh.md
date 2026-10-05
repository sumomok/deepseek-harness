# Agent Note: 一个 Host 服务多位成员

Status: implemented

[English](2026-10-05-console-member-peers.md) | 中文

相关：[Remote 双工流](2026-09-19-remote-duplex-stream.zh.md)（部分被取代——其中「本 Host 只有一个 Peer」与「操作者是唯一的 Peer」描述的是没有安装 Peer 准入器的 Host；本记录补上了那份记录留给第一个需要第二个 Peer 的消费者的准入器、按 id 查找以及 Peer 开关事件）。

## 问题

本 fork 的服务器控制台由一个 Host 进程服务多位成员，每位成员经客户自己的系统登录。上游 `dsh-client-connection` 只有一个 Peer，即操作者。`connection.admit()` 对每个可信且已认证的请求都以它作答；`/api` 拦截器与专用 RPC 通道在注册时就绑定它；精确 Fetch 路由与 `bridge()` 根本拿不到 Peer。于是 Remote 方法分不出是哪位成员在调用，插件也既影响不了 WebSocket 准入，也给不了一元调用标记：`connection/request` waterfall 在准入之后运行、换不了 Peer，升级路由又归 Gateway 所有。

双工流那份记录为第一个需要第二个 Peer 的消费者预留了三处扩展点：`admit` 里的准入器、按 id 查找 Peer、Peer 开关事件，都在 `dsh-client-connection` 里。控制台就是这个消费者。本记录覆盖 Connection 的成员 Peer 与 Gateway 的 socket 事件，以 fork 核心补丁 `connection-member-peers` 承载。

## 决策

### 每位成员一个 Peer

`ctx.connection.peers` 持有成员 Peer。`open()` 用 `createScope(connectionCtx, peer)` 在 Connection 自己的插件上下文下建一个 `ConnectionPeer` scope，操作者也由同一机制建出；`OperatorPeer` 就是不带关闭回调构造的 `ConnectionPeer`。`get(id)` 与 `list()` 返回尚未调用 `dispose()` 的成员 Peer，都不会返回操作者。成员 Peer 一直存活到它的 `dispose()` 或 Connection 卸载为止，卸载会释放仍开着的每个成员 Peer。

单位是成员，不是 socket。一元 HTTP 请求不属于任何 WebSocket，按 socket 分 Peer 会让 `session/prompt` 这类调用找不到可代表的 Peer。成员在不在线由下面的 socket 事件回答，不由 Peer 的寿命回答。

### 准入与默认拒绝

`peers.admitWith(admitter)` 安装唯一的 `PeerAdmitter`；第二次安装会抛错，注册是安装方 fiber 的一个 effect。此后 `admit(request)` 按以下顺序裁决：

1. 先跑 Connection 自己的 Host/Origin 校验与浏览器认证；在这里被拒就返回 403 或 401，准入器不会被调用。准入器只能收紧准入。
2. 没有准入器时，请求代表操作者，与上游相同；Connection 的 Config 设了 `requireAdmitter` 时则以 401 拒绝（见下文）。
3. 有准入器时，`peers.open()` 返回的、仍活着的 Peer 被接纳；准入器返回的 401 或 403 作为拒绝返回；`undefined`、已释放的 Peer、操作者或任何其他对象一律以 401 拒绝，并记一行不含任何请求头值的 error 日志。

所以一旦装了准入器，就没有 HTTP 请求或 WebSocket 升级代表操作者：仅凭浏览器 cookie 拿不到 Host 权限。`requestRejection(request)` 定义为 `admit(request)` 的判定，因此只用它把关的路由（如 inspector 与 open-in-app 的路由）同样拒绝准入器认不出的 cookie 持有者。释放准入器的注册会恢复没有准入器时的接纳方式。

默认拒绝只在装着准入器时成立，而有两段时间没有准入器：Connection apply 之后、准入器插件 apply 之前，以及准入器插件重启期间，因为它的 disposer 会移除准入器。Connection 的 Config 字段 `requireAdmitter`（默认 `false`）堵住这两段：为 true 时，没有安装准入器期间，通过 Host/Origin 校验与浏览器认证的请求由 `admit` 以 401 拒绝，`requestRejection` 对它也返回 401；index 授权不受影响。这类拒绝不记日志，因为它们是启动期间的预期答复。拒绝码是 401，所以 `ConnectionRequestRejection` 只有 401 与 403 两种状态。设了该字段却没有准入器插件的组合会拒绝每一个这类请求，这是有意的失败即关闭。`peers.requireAdmitter` 暴露解析后的取值；准入器所在的插件在加载时读它，为 false 时拒绝启动，因为后面的配置层会整行替换 Connection 行，前面的层设下的字段可能丢失。

被接纳的 Peer 送达每个载体：`/api` 路由与专用通道把 `admission.peer` 交给 `bridge(req, res, handler, maxBytes, peer)`；`ConnectionFetchHandler.fetch(request, peer?)` 在 shell 自有载体不指明 Peer 时缺省为操作者；`ConnectionFetchRoute.fetch(request, peer)` 收到它；RPC 通道处理器收到每次调用的 Peer；Gateway 的升级路由把 `admission.peer` 交给 mux。每个 Peer 参数都是最后一个参数，因此忽略它的路由或处理器是合法实现，省略可选 Peer 参数的载体代表操作者。

### `admit()` 保持同步

`admit()` 返回 `PeerAdmission` 而不是 promise，准入器也是同步的。`connection/request` waterfall 的签名不带 Peer；需要调用方的 waterfall 监听器或 fork 路由对同一个请求再调一次 `admit(req)` 取回它。这只有在准入同步、且对同一组请求头给出同一答案时才成立，准入器的约定要求了这一点。升级路由与 `requestRejection` 的调用方也都是同步的。从签名请求头认出成员不需要 I/O。

### 生命周期事件

Connection 在 `open()` 返回之前发出 `connection/peer-opened(peer)`，在第一次 `dispose()` 调用让 scope 静默之后发出 `connection/peer-closed(peer)`，无论有多少 `dispose()` 调用并发都只发一次。操作者两个都不发。

Gateway 的 `RemoteStreamMuxServer` 接受一个可选的 socket 观察者，Gateway 用它在 socket 绑定到其 Peer 之后发出 `remote-stream/socket-opened(peer, socketId)`，在 socket 关闭且其上的流都已结束之后发出 `remote-stream/socket-closed(peer, socketId)`。释放 Peer 会以 1001 关闭它的 socket；关闭请求是同步发出的，但关闭握手稍后才完成，因此 `connection/peer-closed` 通常先于对应的 `remote-stream/socket-closed`。`RemoteSocketId` 是由进程级计数器生成的 branded 标识：它只向进程内监听器指明一个 socket，从不上线路。升级时 Peer 已经释放的 socket 直接关闭，两个 socket 事件都不发。

这些事件为安装准入器的插件而设：关闭空闲 Peer 需要知道其成员没有打开的 socket，判断待审批的归属成员是否在线需要 socket 在场情况。四个事件中任何一个的监听器抛错只记日志，既不让 `open()` 或 `dispose()` 失败，也不会进入 WebSocket 服务器。

### Peer 不带身份

成员 Peer 只有 `id`、`ctx` 与 `dispose()`，与双工流那份记录所说一致：Peer 不承载访问模型。一个 Peer 属于哪位成员，只由安装准入器的插件记录。Connection 从不看到成员的主体键，因此这个键进不了 Connection 的日志，也进不了 Connection 交给模型的任何东西。

### 没有准入器时

默认不安装准入器，`requireAdmitter` 默认为 `false`；此时每条路径都与上游相同：`admit` 以操作者作答，`requestRejection` 以 Host/Origin 与认证的判定作答，每个处理器都收到操作者。桌面组合就运行在这种状态下。`peer-admission.host.spec.ts` 断言没有准入器时四条路径都是操作者，`socket-events.host.spec.ts` 断言 socket 事件上是操作者。

### 退役

上游 `dsh-client-connection` 自己实现多 Peer 准入、按 id 查找与 Peer 开关事件时，本补丁退役，fork 改用上游的形式。判据是 `git grep -n "peer-opened\|admitter\|peers\." <tag> -- packages/client/connection/src`。

## 考虑过的替代方案

**每条 WebSocket 一个 Peer。** 那样 Peer 会跟随一条连接的寿命，但一元 HTTP 调用没有 socket，因此不会有 Peer；socket 在场情况改由 socket 事件提供。

**把身份放进 Peer。** 在 `PeerScope` 上加 `principal` 字段，会把成员身份带进 Connection、Gateway 以及每个读 `invocation.peer` 的地方，它在那里可能进入日志和模型请求；这也违背上游「Peer 不承载访问模型」的规则。由插件持有对应关系，身份只留在一个包里。

**异步准入器。** 它会把 `admit()` 变成 promise，改动升级路由与每个 `requestRejection` 调用方，并破坏 waterfall 监听器依赖的再次准入。核验请求头不需要 I/O。

**准入器认不出请求时回落到操作者。** 那样一个带有效浏览器 cookie、却没有成员断言的请求就会以操作者的完整 Host 权限行事。默认拒绝让 cookie 本身不足以拿到这份权限。

**让 `requestRejection` 停留在 Host/Origin 与 cookie 校验上。** 只用它把关的路由会放行一个不是已接纳成员的 cookie 持有者，而 `admit()` 会拒绝同一个请求。

**在插件里做准入。** `connection/request` waterfall 在准入之后运行、替换不了 Peer，WebSocket 升级路由归 Gateway 所有，上游又在注册时把一元处理器绑定到操作者，因此插件层没有扩展点能把成员附到一次调用上。

## 影响

- **得到的**：装了准入器后，每个 RPC、逻辑流与精确 Fetch 路由都知道是哪个成员 Peer 在调用；用 `requestRejection` 把关的路由拒绝非成员；准入器所在的插件从四个事件得知成员在场情况。
- **核心改动面**：Connection 的 `rpc.ts`、`rpc-host.ts`、`index.ts`、`http-bridge.ts`、`operator-peer.ts` 与 Gateway 的 `index.ts`、`stream-server.ts` 与上游不同。Gateway 的 `index.ts` 在上游改动频繁，滚动同步要在那里解冲突。本补丁也会进入桌面线，在那里不起作用。
- **`requireAdmitter: false` 时，移除准入器会重新打开按操作者接纳**，对每个已认证的浏览器都是如此；依赖成员准入的部署设 `requireAdmitter: true`，其准入器插件在 `peers.requireAdmitter` 为 false 时拒绝启动。
- **`requireAdmitter: true` 而没有准入器插件时，每个通过 Connection 自身检查的请求都被拒绝**，直到装上准入器。
- **Connection 不回收成员 Peer**：从未释放的 Peer 一直存活到 Connection 卸载，因此空闲关闭由准入器所在的插件负责。
- **`requestRejection` 会运行准入器**：装了准入器后每次调用都会运行，包括对认不出的请求记的那行 error。
