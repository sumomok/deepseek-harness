# Agent Note: 一个 Host 服务多位成员

Status: implemented

[English](2026-10-05-console-member-peers.md) | 中文

相关：[Remote 双工流](2026-09-19-remote-duplex-stream.zh.md)（部分被取代——其中「本 Host 只有一个 Peer」与「操作者是唯一的 Peer」描述的是没有安装 Peer 准入器的 Host；本记录补上了那份记录留给第一个需要第二个 Peer 的消费者的准入器、按 id 查找以及 Peer 开关事件）。

## 问题

本 fork 的服务器控制台由一个 Host 进程服务多位成员，每位成员经客户自己的系统登录。上游 `dsh-client-connection` 只有一个 Peer，即操作者。`connection.admit()` 对每个可信且已认证的请求都以它作答；`/api` 拦截器与专用 RPC 通道在注册时就绑定它；精确 Fetch 路由与 `bridge()` 根本拿不到 Peer。于是 Remote 方法分不出是哪位成员在调用，插件也既影响不了 WebSocket 准入，也给不了一元调用标记：`connection/request` waterfall 在准入之后运行、换不了 Peer，升级路由又归 Gateway 所有。

双工流那份记录为第一个需要第二个 Peer 的消费者预留了三处扩展点：`admit` 里的准入器、按 id 查找 Peer、Peer 开关事件，都在 `dsh-client-connection` 里。控制台就是这个消费者。

只知道调用方还不够。控制台必须核对成员一次调用里点名的每个会话 id 都属于这位成员，过滤结果与流的每一项，并整类拒绝某些方法。上游 Gateway 从载体直接分发每个 Remote 方法，插件没法插在载体与方法之间。双工流那份记录把访问控制交给 `vouch` 与 `remote/invoke` waterfall，而基座发布两者都没有实现。

精确 Fetch 路由与专用 RPC 通道不经过 Gateway，所以包在 Remote 调用外面的钩子看不到它们。`/api/file` 就是这样一条路由，能读 Host 能读到的任何文件；`/api/session/uploadFileBinary` 在查询串里点名会话。直接登记在 webserver 上的路由不经过 Connection 的任何钩子，webserver 也不列出它们。

本记录覆盖 Connection 的成员 Peer 与 Gateway 的 socket 事件，以 fork 核心补丁 `connection-member-peers` 承载；Gateway 的 `remote/invoke` waterfall，以 `remote-invoke-guard` 承载；以及 Connection 的 `connection/fetch` waterfall 与 webserver 的路由列举，以 `connection-fetch-guard` 承载。

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

### Remote 调用经过 `remote/invoke`

Gateway 在每次 Remote 方法调用外跑 `remote/invoke` waterfall，不论调用来自 `invoke()`、`stream()`、`wireStream.open()`、`/api` RPC 载体还是 WebSocket mux。事件名用的是双工流那份记录为访问控制预留的名字，所以上游若以不同签名声明它，会与这里的声明编译冲突，逼出退役决定。

Gateway 先解析描述符，再把一个 `RemoteInvokeCall` 交给监听器：endpoint、入口模式、调用方 Peer、描述符的接收者选择（`invocation` 与 `scope`）和参数描述，以及 wire `args`。因此监听器不读 schema 就知道哪些 wire 字段承载 lookup 或 Context 身份。`next()` 执行上游的分发：精确参数检查、接收者与 lookup 解析、调用方法，所用的是监听器看到的那个描述符，不会重新解析，因此监听器等待期间被替换的定义改变不了已核对的参数。故障按上游的顺序发生：endpoint 与描述符的故障发生在 waterfall 之前，参数、codec、lookup 与模式的故障在 `next()` 里发生。

监听器通过抛出 `RemoteError` 拒绝调用，`gateway/forbidden` 是 Gateway 为访问被拒提供的码。拒绝会跳过 `next()`；仓库「waterfall 监听器必须调用 `next()`」的规则管的是委托，拒绝或代替方法作答是监听器自己的决定。监听器赋给 `call.args` 的参数与 Client 发来的参数经过同样的校验，因为 `next()` 在运行时才读这个字段。改写后的一元值与方法结果一样经过 `/api` 编码器，Gateway 对二者都不按 result codec 校验。返回另一种模式的结果时，调用以 `gateway/result-invalid` 失败。

监听器共用一个 `next()`，它运行下一个尚未运行的监听器，所以一个监听器的拒绝或检查只在它之前的每个监听器都调用一次 `next()` 时成立，它看到的 `call.args` 是它之后的监听器替换之前的值（[Gateway README](../../../../packages/api/gateway/README.zh.md#host-service-typertgatewayservice-ctx-key-typertgateway)）。因此多人控制台的组合把全部规则放在一个 `remote/invoke` 监听器里，不注册别的。

`next()` 同步开始分发，校验与方法调用在同一异步上下文里继续，所以在 `AsyncLocalStorage.run()` 里调用 `next()` 的监听器能让方法读取到的东西看见调用方。流方法的正文在载体拉取项时才运行，那时 waterfall 已经返回，所以需要在那里保留上下文的监听器，要在它返回的 source 每次被拉取时重新进入该上下文。

`claimedEndpoints()` 列出 `/api` 载体认领的方法 endpoint，即活跃的严格定义与 SRC 标记，这样门禁测试能要求 Gateway 提供的每个 endpoint 都有分类。Gateway 自有的 `$events` 流与 `$events/result` 不进这个 waterfall。

### Fetch 路由与通道经过 `connection/fetch`

Connection 在每个精确 Fetch 路由与每个经 `rpc.handle` 登记的通道前面跑 `connection/fetch` waterfall，把一个 `ConnectionFetchCall` 交给监听器：种类、登记的路径、方法、Fetch 请求与准入的 Peer（shell 自有的载体没有指明 Peer 时是操作者）。`path` 就是登记时用的键，所以路由表的键与 `fetch.list()`、`rpc.channels()` 返回的字符串相同。RPC 拦截器分发的 `/api` 请求仍归 `remote/invoke`，所以 `/api` 上的一个请求至多经过两个 waterfall 中的一个。监听器不调用 `next()`、直接返回自己的 Response 即为拒绝。

这个 waterfall 在准入之后、在桥接器缓存或开始流式传输请求体之后运行，因为监听器拿到的是桥接器构造的 Fetch `Request`；超过缓存上限的请求体在任何监听器运行之前就答 413。监听器只经 `request.clone()` 读请求体，路由照样收到它。

这里的监听器同样共用一个 `next()`（[Connection README](../../../../packages/client/connection/README.zh.md#browser-authentication-and-request-trust)），所以控制台只注册一个 `connection/fetch` 监听器。调用了 `next()` 之后又拒绝或抛错的监听器会留下一个没人读的路由 Response，而没人读的流式 body 会让它的生产者以及它正在读的文件一直开着：没人读的 `/api/session.export` ZIP 会一直占着它正在读的已存附件，直到 body 被取消。因此 Connection 对 `next()` 产生、调用方收不到的每个 Response 取消其 body，除非调用方收到的 Response 带着那个 body。监听器抛错与路由抛错一样让分发 reject，HTTP 载体答 400。

`webServer.routes()` 列出当前生效的具名路由、upgrade 路由与已被占用的回退座位。这些路由不经过 Connection 的任何钩子；控制台的门禁测试读这份列表，所以上游同步带来的新路由在被分类之前会让门禁失败。

### 没有准入器时

默认不安装准入器，`requireAdmitter` 默认为 `false`；此时每条路径都与上游相同：`admit` 以操作者作答，`requestRejection` 以 Host/Origin 与认证的判定作答，每个处理器都收到操作者。桌面组合就运行在这种状态下。`peer-admission.host.spec.ts` 断言没有准入器时四条路径都是操作者，`socket-events.host.spec.ts` 断言 socket 事件上是操作者。没有 `remote/invoke` 监听器时，`remote-invoke.host.spec.ts` 经 `invoke()`、`stream()`、`wireStream.open()`、`/api` 与 WebSocket 断言结果与故障不变，用 `for await` 读流的两个载体（WebSocket mux 与 webworker tunnel）分辨不出 Gateway 的流与上游的流。仍有三处差异。在没有 Connection 的 Host 上，`invoke()`、`stream()` 与不指明 Peer 的 `wireStream.open()` 调用在参数校验之前（而不是之后）就创建 Gateway 自有的操作者 Peer。自己驱动 `stream()` 或 `wireStream.open()` 返回值的 iterator 的调用方会看到，第一次 `next()` 之前的 `return()` 会释放上行并打开、return 方法的 iterator（上游两者都不做），iterator 工厂或 iterator 的 `return()` 抛错时这次 `return()` 以该错误 reject，返回的 iterable 也不是 `AsyncGenerator`：没有 `throw()` 与 `Symbol.asyncDispose`，`Symbol.toStringTag` 也不同。Cordis 的 `internal/dispatch` 监听器能看到每次 `remote/invoke` 分发，连同调用方 Peer 与尚未校验的参数。没有 `connection/fetch` 监听器时，每个请求都到达它的路由或通道，调用方收到的是路由自己的 Response，现有 Connection spec 不改照样通过；同步抛错的路由让共享处理函数的 `fetch` 返回一个 reject 的 promise，而不是同步抛出，`internal/dispatch` 监听器也能看到每次 `connection/fetch` 分发，连同请求与 Peer。

### 退役

上游 `dsh-client-connection` 自己实现多 Peer 准入、按 id 查找与 Peer 开关事件时，本补丁退役，fork 改用上游的形式。判据是 `git grep -n "peer-opened\|admitter\|peers\." <tag> -- packages/client/connection/src`。

上游 Gateway 实现 `remote/invoke` 或等价的 Remote 调用钩子时，`remote-invoke-guard` 退役，控制台的方法表改挂到那个钩子上。判据是 `git grep -n "'remote/invoke'" <tag> -- packages/api/gateway/src`。

上游给精确 Fetch 路由与专用通道提供按调用方裁决的钩子，或自己限制 `/api/file` 的读取范围时，`connection-fetch-guard` 的 Connection 部分退役；上游提供 webserver 已登记路由的列举时，它的 webserver 部分退役。判据是 `git grep -n "'connection/fetch'" <tag> -- packages/client/connection/src` 与 `git grep -n "routes(" <tag> -- packages/host/webserver/src`。

## 考虑过的替代方案

**每条 WebSocket 一个 Peer。** 那样 Peer 会跟随一条连接的寿命，但一元 HTTP 调用没有 socket，因此不会有 Peer；socket 在场情况改由 socket 事件提供。

**把身份放进 Peer。** 在 `PeerScope` 上加 `principal` 字段，会把成员身份带进 Connection、Gateway 以及每个读 `invocation.peer` 的地方，它在那里可能进入日志和模型请求；这也违背上游「Peer 不承载访问模型」的规则。由插件持有对应关系，身份只留在一个包里。

**异步准入器。** 它会把 `admit()` 变成 promise，改动升级路由与每个 `requestRejection` 调用方，并破坏 waterfall 监听器依赖的再次准入。核验请求头不需要 I/O。

**准入器认不出请求时回落到操作者。** 那样一个带有效浏览器 cookie、却没有成员断言的请求就会以操作者的完整 Host 权限行事。默认拒绝让 cookie 本身不足以拿到这份权限。

**让 `requestRejection` 停留在 Host/Origin 与 cookie 校验上。** 只用它把关的路由会放行一个不是已接纳成员的 cookie 持有者，而 `admit()` 会拒绝同一个请求。

**在插件里做准入。** `connection/request` waterfall 在准入之后运行、替换不了 Peer，WebSocket 升级路由归 Gateway 所有，上游又在注册时把一元处理器绑定到操作者，因此插件层没有扩展点能把成员附到一次调用上。

**在每个业务包里做归属检查。** 每个拥有 Remote 方法的包都要自己做检查，同步带进来的新包在补上之前没有保护。Gateway 上的一个 waterfall 覆盖每个方法，基于 `claimedEndpoints()` 的门禁能抓到未分类的 endpoint。

**包装 Connection 的 `/api` 处理器。** 它只覆盖一元 HTTP 调用，WebSocket 流与进程内调用绕过它；它在描述符解析之前看到载荷，分不出 lookup 字段与 JSON 字段。

**在 `next()` 里重新解析描述符。** 监听器等待期间被撤回或替换的定义，会按监听器没有检查过的参数校验。

**在桥接器之前跑 `connection/fetch`。** 监听器看到的会是 node:http 请求，而不是路由收到的 Fetch `Request`；要检查请求体的监听器得在请求大小上限生效之前自己读它。

**让被丢弃的路由 Response 留着不读。** 桥接器只写出它收到的那个 Response，监听器丢弃的 body 会让它的生产者与打开的文件一直留到垃圾回收。

**按 result codec 校验改写后的结果。** Gateway 不校验任何方法结果；只校验改写过的结果，会让同一个值在改写过与未改写的调用里得到不同答复。

## 影响

- **得到的**：装了准入器后，每个 RPC、逻辑流与精确 Fetch 路由都知道是哪个成员 Peer 在调用；用 `requestRejection` 把关的路由拒绝非成员；准入器所在的插件从四个事件得知成员在场情况。组合里唯一的 `remote/invoke` 监听器能按 endpoint 决定谁能调用、参数可以点名哪些身份、结果或流的每一项可以带什么，替换的参数只能经过正常校验到达方法。
- **核心改动面**：Connection 的 `rpc.ts`、`rpc-host.ts`、`index.ts`、`http-bridge.ts`、`operator-peer.ts`，Gateway 的 `index.ts`、`stream-server.ts`、`types.ts`、`remote-error-codes.ts`，以及 webserver 的 `index.ts` 与上游不同。Gateway 的 `index.ts` 在上游改动频繁，滚动同步要在那里解冲突。本补丁也会进入桌面线，在那里不起作用。
- **`requireAdmitter: false` 时，移除准入器会重新打开按操作者接纳**，对每个已认证的浏览器都是如此；依赖成员准入的部署设 `requireAdmitter: true`，其准入器插件在 `peers.requireAdmitter` 为 false 时拒绝启动。
- **`requireAdmitter: true` 而没有准入器插件时，每个通过 Connection 自身检查的请求都被拒绝**，直到装上准入器。
- **Connection 不回收成员 Peer**：从未释放的 Peer 一直存活到 Connection 卸载，因此空闲关闭由准入器所在的插件负责。
- **`requestRejection` 会运行准入器**：装了准入器后每次调用都会运行，包括对认不出的请求记的那行 error。
- **一个 `connection/fetch` 监听器裁决每个精确路由与通道**：控制台的路由表可以把 `/api/file` 限制在成员的根目录内、把上传限制在成员自己的会话上，并拒绝表里没有的路由与通道。
- **直接登记在 webserver 上的路由仍然没有钩子**：`routes()` 让门禁测试能列出它们，每一条仍要有自己的检查。
- **`remote/invoke` 也看到 Host 自己的进程内调用**，它们带的是操作者 Peer；限制成员的监听器要放行操作者的调用。
- **流调用以流作答时，监听器自己 return 它丢弃的每条流**：对 source 的 iterator 调用 `return()` 会释放这次调用的上行，再打开并 return 方法的 iterator（拉取过项时 return 已打开的那个；该 iterator 上有尚未完成的 `next()` 时在它完成之后进行）。只有监听器抛错或返回 value 时，Gateway 才 return 本次调用中 `next()` 已打开或正在打开的流；结果是流时，它可能包着这些流，Gateway 一条都不 return，所以监听器捕获在它之后的监听器的错误、再调用一次 `next()` 时，第一次打开的流若没有监听器 return 就一直保持打开。
