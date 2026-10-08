---
description: "带类型的 Client 到 Host 调用与流：分派、校验、取消、重连与转发的 Host 事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-gateway

[English](README.md) | 中文

## 概述

为 Host 与 Client 两侧的 Cordis 环境提供 Typert RPC endpoint。Host 入口提供 `ctx.typertGateway`，`@deepseek-ai/dsh-api-gateway/client` 则提供 `ctx.remote`；两者使用同一份生成的 `InvocationDescriptor` 约定，并将业务选择交给 API Remotes。Connection 承载一元调用的请求关联、信任和响应 envelope，Gateway 则拥有多路复用的 Remote 流，每条流都在同一条逻辑流上携带从 Client 到 Host 的上行（uplink）。

## 目录

- [Host 服务：`TypertGatewayService`（ctx key：`typertGateway`）](#host-service-typertgatewayservice-ctx-key-typertgateway)
- [Client 服务：`ClientRemote`（ctx key：`remote`）](#client-service-clientremote-ctx-key-remote)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="host-service-typertgatewayservice-ctx-key-typertgateway"></a>
## Host 服务：`TypertGatewayService`（ctx key：`typertGateway`）

每次调用时，`ctx.typertGateway.invoke()` 都会解析当前的描述符和 Cordis 服务，校验具名参数是否完全匹配，解析已注册的对象或 Context 身份标识，并调用公开的业务方法。业务服务继承 [`dsh-typert-protocol`](../../typert/protocol/README.zh.md) 的 `TypertRemoteService`，并用 `@Remote` 或 `@RemoteScope` 标记方法；已有其他基类时仍可改用 `bindTypertRemote()`。

严格模式从 `ctx.typert.local` 读取生成的调用描述符。查找参数使用 `ctx.typert.lookups` 中当前有效的解析器：业务包注册稳定声明与默认策略，Host 组合可用 effect-scoped `configure()` 覆盖解析行为；`@RemoteScope` 则通过已注册的 Host Context 适配器解析其接收者。SRC 模式是开发阶段的回退路径，适用于从未具备严格定义的端点；它解析简单参数名，并且只允许非查找参数使用可安全表示为 JSON 的值。已观测到的严格定义一旦撤回，系统会直接报错，而不会降低校验强度。对于一元结果，Gateway 在生成 codec 提供 `encode()` 时执行它，否则保持 strict JSON 值不变；SRC 则递归识别运行时字节值。两条路径都向 Connection 返回 JSON 兼容元数据及相对于结果的字节附件，由 Connection 完成传输帧封装。

Connection 可用时，Host 入口会在 Connection 共享的 `/api` FetchHandler 上注册 trusted-host interceptor。Connection 把这个复合 handler 交给 HTTP bridge；handler 将已认领 endpoint 分发给 Gateway，未认领且没有精确 Fetch 路由负责的请求返回 404。直接调用 `invoke()` 会保留业务错误；`TypertGatewayError` 是 `RemoteError` 的子类，其 `gateway/*` 码命名了分发、绑定、提供方、查找、Context、参数、编解码器以及上行各自负责的故障：缓冲帧超过 `streamInboxBytes` 的上行报 `gateway/uplink-overflow`，`end` 之后的上行项报 `gateway/protocol`，被 codec 拒绝的上行项报编解码码 `gateway/input-invalid`。因策略而拒绝的解析器——冷恢复失败或 ownership fence——抛出自己的 `RemoteError`，它选定的码原样到达调用方。

支持取消的 Remote 方法会把 `signal: AbortSignal` 声明为最后一个 Host 参数。signal 是 descriptor 元数据，而不是 wire 参数：Connection 将它提供给 Gateway，Gateway 则在已解码的业务参数之后注入它。SRC 识别这个保留的末位参数名，严格生成还要求它具有全局 `AbortSignal` 类型。

流式 Remote 使用 `@Remote({ mode: 'stream' })` 并返回 `Iterable` 或 `AsyncIterable`。`ctx.typertGateway.stream()` 执行与一元调用相同的 endpoint、参数、lookup 和取消校验，再返回可取消的业务项 iterable。Client 插件激活时打开 Gateway 自有的 `/api/remote.mux` WebSocket，并让它在空闲时保持连接。Connection 拥有重试调度；每次 retry 前，它要求 mux 取消候选或活动 socket，并且只做一次全新的物理连接尝试。Host 按配置的 `websocketHeartbeatIntervalMs` 间隔（默认 2 秒）发送 Ping 控制帧，浏览器在 WebSocket 协议层自动回复 Pong，使空闲网络中间层持续看到流量，而不新增 Remote 流帧。若 socket 尚未回复上一次 Ping，Host 会在下一间隔终止它。可独立取消的逻辑流共享这条连接；进程内 Connection 载体直接提供等价的流，不打开该 WebSocket。

启动器提供 `ctx.appReady` 时，Gateway 仅在应用成功启动后注册 WebSocket 升级路由。此前的连接尝试仍属于载体故障，由 Connection 的重试策略处理，因此重启中的 Host 不会在控制器仍在初始化时接受流。卸载会取消尚未触发的就绪订阅，并关闭已注册的载体。不提供 `appReady` 的嵌入式 Host 会立即注册，并自行负责启动顺序；进程内调用不变。

每个被接受的 `/api/remote.mux` socket 在绑定到其 Peer 后以 `remote-stream/socket-opened(peer, socketId)` 宣告，在 socket 关闭且其上每条逻辑流都已结束后以 `remote-stream/socket-closed(peer, socketId)` 宣告，无论是 Client 关闭了它、其 Peer 被释放，还是 Gateway 卸载。`socketId` 是 Host 生成的 `RemoteSocketId`，从不上线路。升级时 Peer 已经释放的 socket 直接关闭，两个事件都不发。Peer 释放时同步请求关闭，而 WebSocket 关闭握手稍后才完成，因此 `connection/peer-closed` 通常先于该 socket 的 `remote-stream/socket-closed`。抛错的监听器只记日志，不影响 socket。

每条流还在同一条逻辑流上携带从 Client 到 Host 的上行。方法把上行项类型声明为返回类型的第二个类型参数——来自 [`dsh-typert-protocol`](../../typert/protocol/README.zh.md) 的 `RemoteStream<Out, In>`；`In` 缺省为 `never`，返回 `Iterable`、`AsyncIterable` 或 `RemoteStream<Out>` 的方法即声明自己不读上行。运行中的方法通过 `this.ctx.invocation` 读取本次调用：Gateway 从携带该 `RemoteInvocation`（`request`、`service`、`peer`、`signal` 与 `uplink()`）的 Context 派生接收者，因此没有任何东西进入参数列表，而非 Remote 调用派生的 Context 上 `ctx.invocation` 为 `undefined`。`uplink()` 每次调用只能取一次。描述符带 codec 时它在交付前逐项解码；不带时——SRC 方法，或 `In` 为 `never` 的方法——它交付经 JSON 安全校验的 `unknown` 值。Client 在已打开的逻辑流上把每一项作为 `item` 帧发送（顶层 `undefined` 项是不带 `value` 的 `item` 帧），以 `end` 帧表示半关闭；方法通过 `uplink()` 迭代结束感知半关闭，通过 `signal` 感知取消。被拒绝的项使整条流以 `gateway/input-invalid`（字段 `uplink`）失败。上行项在 Host 逐项校验，因为它们来自浏览器；下行项是 Host 方法产出的值，不经校验原样透传。方法结束下行时 Gateway 调用 uplink 迭代器的 return 并丢弃未读的项；发给从未取用 uplink 的方法的项在 inbox 里等到那时为止。每条逻辑流最多缓冲 `streamInboxBytes`（默认 262144）字节的上行帧；超限使流以 `gateway/uplink-overflow` 失败，`end` 之后的项使流以 `gateway/protocol` 失败，两种情况都不关闭 socket。发给 Host 已结束的流 id 的 `item`、`end` 与 `cancel` 帧被丢弃；只有重复的 `open` 会关闭 socket。`$events` 这类 Gateway 自有的流在打开时立即 return 其 uplink，因此它们的 `item` 帧被丢弃而不缓冲。一元方法也可以调用 `uplink()`；其项只在方法运行期间可读。WebSocket 上的流代表 Connection 在升级时接纳的 Peer，没有安装 Peer 准入器且 Connection 未设 `requireAdmitter` 时即操作者（设了该字段又没有准入器时，升级以 401 被拒）；该 Peer 的 scope 释放时 socket 以 1001 关闭；进程内载体的流直接代表操作者。

每次 Remote 方法调用在描述符解析之后都会经过 `remote/invoke` waterfall，无论从哪个入口进入：`invoke()`、`stream()`、`wireStream.open()`、`/api` RPC 载体和 `/api/remote.mux` WebSocket；Gateway 自有的 `$events` 流与 `$events/result` 不经过它。监听器收到一个 `RemoteInvokeCall`——`endpoint`、`mode`（来自 `invoke()` 与 `/api` 的为 `unary`，来自流入口的为 `stream`）、调用方 `peer`、描述符的 `invocation`、`scope` 与 `parameters`，以及尚未校验的 wire `args`——和 `next()`；`next()` 校验 `call.args`、解析接收者与 lookup、调用方法，并解析为 `RemoteInvokeOutcome`，即 `{ kind: 'value', value }` 或 `{ kind: 'stream', source }`。监听器可以在调用 `next()` 之前给 `call.args` 赋一个替换值，替换后的参数与 Client 发来的参数经过同样的字段、codec 与 lookup 检查。它可以返回改写后的值或包装后的 source；在 `/api` 上，改写后的值与方法结果一样编码，二者都不按描述符的 result codec 校验。监听器不调用 `next()`、直接抛出 `RemoteError` 即拒绝调用，访问被拒时用带 `{ endpoint }` details 的 `gateway/forbidden`，调用方收到它的方式与方法自己抛出同一错误时相同；监听器不调用 `next()` 就返回时由它代替方法作答，返回另一种模式的结果时调用以 `gateway/result-invalid` 失败。Gateway 按 Cordis 的 `waterfall()` 的方式解析监听器，自己组装调用链，所以每个监听器的 `next()` 在一次调用里至多运行一次它之后的监听器与方法：重复调用（例如在它之后的监听器拒绝之后重试）返回第一次调用的 promise，或抛出第一次调用同步抛出的错误。因此再次调用 `next()` 绕不过监听器的拒绝，方法在一次调用里至多运行一次。Cordis 的 `internal/dispatch` 监听器收到本次调用与调用链的第一个位置，该位置按顺序运行监听器，与之共享同一个只运行一次的结果。监听器看到的 `call.args` 是它之后的监听器替换之前的值。方法以 Gateway 构造调用时固定下来的 Peer 运行：监听器写入 `call.peer` 的值（经 `Reflect.set` 写入也一样）会被它之后的监听器读到，但到不了方法的 `ctx.invocation.peer`。方法在调用 `next()` 时所处的异步上下文中运行，因此监听器可以在 `AsyncLocalStorage.run()` 里调用 `next()`；流的项由载体在 waterfall 返回之后拉取，需要在产出项时保留该上下文的监听器，要在 source 的每次 `next()` 与 `return()` 外重新进入它。丢弃 `next()` 返回的流结果时，监听器要调用其 iterator 的 `return()`：这会释放本次调用的上行，再打开并 return 方法的 iterator（拉取过项时 return 已打开的那个），该 iterator 上有尚未完成的 `next()` 时在它完成之后进行。流调用失败或结果是 value 时，调用方立即收到监听器的错误或 `gateway/result-invalid`，Gateway 在后台释放瀑布运行期间调用的 `next()` 已打开或仍在打开中的那条流：先以这个错误中止方法的 `signal`，再在流打开之后对它调用 `return()`。监听器抛出 `undefined` 时，调用方收到的仍是 `undefined`，方法的 `signal` 则以 Gateway 的一个 `Error` 中止，因为 `abort()` 会把 `undefined` 换成 `AbortError`。打开或 return 这些流的失败既不取代调用方收到的错误，也不留下未处理的 rejection。Gateway 释放这类流时仍在等待方法 `next()` 的 `next()` 不再等待，在流释放上行、方法的 iterator 完成 return 之后以一个错误完成，不承诺是哪个错误；之后对这条流调用的 `next()` 以 done 完成，在 Gateway 的 `return()` 之前到达这条流时以错误完成。Gateway 只为这些 `next()` 的 rejection 挂上处理，因此丢弃了其中一个的监听器不会留下未处理的 rejection，等待它的监听器会收到错误。方法自身的失败（例如方法的 `next()` reject、iterator 工厂抛错）在释放之前结束的 `next()` 归监听器，即使它的 promise 在释放之后才完成：丢弃它的监听器会留下未处理的 rejection，每个 `dsh` profile 都装有遇错即退的进程守卫，这个 rejection 会让宿主退出。所以监听器不得丢弃 `next()` 返回的流上的 `next()`。async generator 方法的 `return()` 要等方法完成自己尚未完成的 `next()` 才完成，所以流方法必须在它的 `signal` 中止时结束：停在不理会该 signal 的 promise 上的方法永远不会 return，它尚未完成的 `next()` 与方法一样一直挂着。销毁 Gateway 所在的 Context 不等待这些释放。载体自己的 signal 不被中止，所以 WebSocket mux 照样把这个错误作为错误帧发出。Gateway 收到最外层监听器的结果时瀑布结束：该监听器同步抛错时立即结束，否则要等它在返回或抛错之前排入的 microtask 运行完，所以从这样的 microtask 调用的 `next()` 仍会执行方法，流调用失败时 Gateway 会 return 它打开的流。Gateway 收到结果之后，监听器第一次调用的 `next()`（例如在定时器里调用）直接 reject，不执行方法，一元与流调用都是如此，这个 rejection 归调用它的监听器；重复调用的 `next()` 返回该监听器第一次得到的结果。结果是流时，它可能包着本次调用打开的流，所以 Gateway 一条都不 return：这些流都归监听器所有，丢弃其中一条的监听器自己调用它的 `return()`。因此，监听器捕获在它之后的监听器的错误、再以自己的流作答时，方法打开的流若没有监听器 return，就一直保持打开。没有监听器时，成员准入关闭的情况下每次调用直接进入上述校验与调用。成员准入开启时（即 Connection 的 `peers.memberAdmission` 为 true），找不到监听器的调用以 `gateway/service-unavailable` 失败、方法不运行，所有入口与载体都如此，宿主自己的进程内调用也不例外；描述符故障仍在它之前。没有 Connection 的 Host 上成员准入是关闭的。

`claimedEndpoints()` 按排序列出 `/api` 载体认领的方法 endpoint：活跃的严格定义，以及活跃 Service 上的 SRC 标记。载体还认领 `$events/result` 和已撤回的严格 endpoint，它们没有方法提供服务，列表不含它们。

Host 下行、Host 上行和 Client 上行泵的取消与停止状态归属单次读取，不保留已交付项的历史。下行结束也会唤醒尚未完成的上行读取。

Host 组合可通过 `registerRemoteEvents()` 注册唯一的应用事件 source。Gateway 为它保留内部 `$events` logical endpoint，只接受空 `args`，并在 source 撤回时中止该注册打开的流。事件名单、参数校验、每个 Client 的队列及 opening `{ type: 'ready', clientId, host: { home } }` frame 中的 Host home 由 API Remotes 拥有。source factory 在返回 iterable 前同步挂好增量 listener，因此 Client 只在增量投递就绪后发布 generation 并开始 baseline 读取。

每个 `$events` Client 记下打开它的 Peer：WebSocket 的是 Connection 为它准入的 Peer，不点名 Peer 的进程内载体的是操作者。`$events/result` 必须来自同一个 Peer；其他 Peer 为该 Client 发来的结果以 `gateway/forbidden` 拒绝，details 为 `{ endpoint: '$events/result' }`，pending 的 waterfall 保持原样。结果只经 `/api` RPC 载体传送：WebSocket mux 不为 `$events/result` 打开流。没有安装 Peer 准入器时，每个 Client 与每个结果都代表操作者，这项核对不会拒绝。点名调用方自己的 Client、却带着该 Client 从未收到或已经答复过的事件的结果答 ok，什么也不改变。

`filterRemoteEvents(filter)` 把唯一的 `RemoteEventFilter` 安装为调用方 Context 的 effect；第二次安装抛错，返回的 disposer 或该 Context 卸载会移除它。过滤器收到一个 `RemoteEventDelivery`（`{ kind: 'emit', event, args }` 或 `{ kind: 'waterfall', event, agentId, request }`，带的是 Client frame 里同样那份已校验的 JSON）和打开某个 Client 的 Peer，返回 `true` 表示把事件投给这个 Client；返回其他任何值都扣下事件，不记日志。异步过滤器是类型错误：它返回的 promise 让事件被扣下，它产生的 reject 由安装方处理。Gateway 同步调用它，每个 Client 一次，调用点有四处：广播通知时、scoped waterfall 首次到达时、有 pending waterfall 时 Client 连上时，以及有 pending waterfall 时安装过滤器时（对每个尚未收到它们的已连接 Client）。抛错的过滤器按 `false` 处理，Gateway 记一条点名该事件的 warning。没有任何 Client 收到的 waterfall 保持 pending，与没有 Client 连接时相同，之后连上的被接受的 Client 会收到它；它的 pending 生命周期仍随 Agent Context 或取消信号结束，收到它的每个 Client 都以 `next()` 委托之后，Host 链继续执行。没有过滤器时由成员准入决定：成员准入关闭时（即 Connection 的 `peers.memberAdmission` 为 false，或没有挂载 Connection），每个 Client 收到每个事件；成员准入开启时，没有 Client 收到任何事件。

`hasLiveClient()` 检查已有 `$events` 记录中是否有未取消的流。已取消的流即使尚未完成 iterator 清理也不计入，单独的 WebSocket 也不计入。这一同步观察不保证后续投递成功或 Client Provider 已就绪。

<a id="client-service-clientremote-ctx-key-remote"></a>
## Client 服务：`ClientRemote`（ctx key：`remote`）

浏览器载体接受 [Connection](../../client/connection/README.zh.md#use-this-package) 定义的 shell 所拥有的流 origin；逻辑流帧与生命周期保持一致。

`ctx.remote.$mount()` 会校验并注册生成的 Host-for-Client 贡献项，然后为发起调用的 Cordis fiber 安装具体的直接方法和作用域方法。每个 namespace 都是可追踪的 `remote.<namespace>` 子 Service，并在最后一个方法撤回后卸载。重复端点、命名空间冲突，以及缺少生成的严格 codec 的 Client 供值字段，都会在方法可调用前报错。

每次一元调用都会检查位置参数数量，构造与描述符完全匹配的具名 `args`，再把带类型的值原样交给 `ctx.connection.rpc.call('/api', endpoint, ...)`，而不执行 Client 侧 schema；Host 会在业务调用前校验收到的 wire 字段。生成的流方法返回 `dsh-typert-protocol` 的 `RemoteStreamHandle<Out, In>`，并在被调用时就打开一条逻辑流，进程内 Connection 载体可用时通过它打开，否则通过共享的 Gateway WebSocket 打开。句柄只迭代下行一次。`send(item)` 把一个上行项入队，在 `open` 帧之后发出；`end()` 半关闭上行；`dispose()` 在未收到终止帧时发送 `cancel`，并让迭代安静结束。提前跳出迭代等价于 dispose 句柄；下行终止后 `send` 抛错，`end` 被忽略。生成的支持取消的方法接受最后一个可选 `AbortSignal`；Client 会在调用载体前将它与贡献项的挂载生命周期合并。Client 将一元结果转换交给 codec 的可选 `decode()`。生成的解码器校验嵌套元数据与原生字节类型，不逐字节遍历、复制或冻结字节载荷。JSON 一元结果与流项不经 Client 侧类型解析直接传递。撤回贡献项会同时移除其描述符和方法、中止正在进行的调用与流，并使外部仍持有的方法句柄在调用时返回拒绝。

每次一元调用都解析为 `RemoteResult<T>`——`{ ok: true, value }` 或 `{ ok: false, error }`——且绝不因载体问题 reject：本面把断线载体折入错误分支，调用方 signal 中止时答以 `gateway/cancelled`，因此没有消费方需要包一层来兜载体失败。只有装配故障仍会 reject：参数个数不符、方法未挂载、贡献已撤下、缺少 Context 适配器。`error` 是活的 `RemoteError` 实例，所以 `throw result.error` 保持 throw 语义；而 `isRemoteFailure(value)` 是消费方唯一需要的谓词——它认下的捕获值带着 Host 码，它拒绝的一律是本地故障，调用方应当让其崩掉。`carrierFailure(endpoint, error)` 与 `cancelledFailure(endpoint, cause)` 构造这两种折叠结果，测试里的替代实现据此采用相同的折叠方式。

`ctx.remote.$host` 以普通值读取固定的 Host 事实：`home`（首个 ready 帧之前为 undefined）与 `isLoopback`。它不是存储——没有订阅、没有代次计数——所以需要响应重连的消费方去监听 `connection/reset`，而不是轮询它。

`ctx.remote.$stream()` 返回跨越多个物理载体代次的单消费方 `RemoteStream`。Host 仍在线时，它允许一次立即重试；Host 离线时，它等待下一代连接，并为每个流项标注物理代次。领域消费方校验并接受各代次的 opening value；业务与协议错误仍然终止流。一切终态失败离开本面时都是 `RemoteError`，包括重试耗尽和在 opening value 之前就结束的代次，因此流消费方与一元调用方用同一种方式判别。`RemoteStreamCarrierError` 命名的是可重试的物理丢失，它只作为 `carrierFailed` 回调参数到达领域，绝不作为终态结果。`RemoteSnapshotStream` 在此之上规定每代由一个初始快照和后续 delta 组成。`RemoteJournalStream` 基于领域提供的 entry 闭区间提供 follow-before-page、分页、重连追赶与缺口修复；它丢弃完整重复项，并拒绝缺口、倒置区间和部分重叠。领域还可以携带无 cursor 的通知：通知绝不推进或修复持久 cursor，在缺口修复期间收到的通知只会在 replacement page 提交后发布。若更新代次取代该修复，旧代次 held notification 会与其 page 一同丢弃。对任一种流执行 dispose（资源释放）时，系统会取消该流的请求，并在活动 iterator 完全停止后完成资源释放。

`ctx.remote.$on()` 订阅一条被转发的 Host 事件。它的合法键恰好等于 Host 装配声明的转发选择，listener 类型就是事件所属包自己的 Cordis `Events` 声明，因此不存在会与之漂移的第二份签名。每个订阅归属调用方 fiber，并随该 fiber 一起消失。Client Remote 服务激活时就把 `$events` pump 注册为 Connection generation source，无论当前是否存在 `$on` listener。浏览器使用 Remote mux，进程内组合使用 `connection.rpc.open`；opening `ready` 项建立 Connection generation 并提供 Host 信息。物理 carrier 失败、Remote 流故障、意外正常结束、非 ready 首项或畸形事件项都会终止该 generation，由 Connection 按持续且间隔封顶的带抖动指数退避重开。普通通知按注册顺序运行并隔离 listener 失败；Agent-scoped waterfall（瀑布式事件）允许 listener 返回结果、调用 `next()` 或拒绝，Gateway 再通过现有 HTTP 一元载体回送该结果。

Client waterfall 的 Context 解析保持同步。解析器可以返回借用的 Context 或 `TypertOwnedValue<Context>`；Gateway 仅在处理器使用和回复结算均结束后释放 owned value。Context 解析失败保留既有的记录错误并委托语义，处理器失败产生拒绝回复。取消会抑制迟到回复，但不会释放处理器仍在使用的 Context。每个 handler 都必须响应 `request.signal` 并在取消后结束；插件销毁与 Connection generation 替换会等待未结束的 handler 结算。Session Context 的获取本身不执行历史 I/O。

`ctx.remote` 不暴露 Connection 生命周期控制。只有职责包含恢复的消费方才直接读取 `ctx.connection.state` 并调用 `ctx.connection.reconnect()`；普通 Remote 消费方仍只使用生成的 namespace 与 `$stream()`。

生成的声明合并通过共享的 `TypertClientRemote` 约定提供 TypeScript API。Client 入口不包含 Host 服务或 Host Cordis 接口合并；方法查找和调用使用普通对象与函数，而不使用 JavaScript Proxy。

<a id="model-experience"></a>
## 模型体验

无，因为该包分发应用调用，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；被调用的业务服务负责产生任何模型可见结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Connection 适配器对分发故障与未归类异常答以 `gateway/internal`，且不附带详细信息；拥有方或 Gateway 自己抛出的 `RemoteError` 带着自有码、message 与 details 过线。其 `cause` 链与 `TypertGatewayError` 子类身份只对同进程调用方留存。
- SRC 模式仅支持名称唯一的标识符参数，不支持解构、默认值或剩余参数。它只校验值能否安全表示为 JSON，不校验生成的业务类型，也绝不会推断可选字段。
- contribution 挂载时，每个由 Client 供值的字段都必须具备生成的严格 codec。SRC 标记没有 Client 类型投影，不是常规的 Client contribution 输入。
- `$stream()` 监督载体替换，但不推断回放语义；各领域自行拥有恢复 cursor 或替换 baseline 的校验，以及正常结束的分类。Connection generation 会重开内部 `$events` 流；单向通知不会重放，仍处于 pending 的 scoped waterfall 则沿用同一个 event id 重放。
- lookup 解析器按 key 配置；当前无法让单个 Remote 参数或 endpoint 在同一 `agent`/`session` key 下选择 live-only 策略。
- 被转发的事件到达 `$on` 时不做业务载荷投影或脱敏。普通通知在重连后不重放；Agent-scoped waterfall 只投影选择 Client Context 所需的顶层 Agent 身份，并自行携带 pending 生命周期。
- `websocketHeartbeatIntervalMs` 同时是 Ping 周期和 Pong 截止时间。对端未在下一周期前回复时，Host 会终止连接；如果部署的事件循环或网络可能停顿超过该间隔，必须调大此配置。
- 上行除了有界的 Host inbox 之外没有流控：Client 发送快于方法读取，或发给从未取用 uplink 的方法时，其流以 `gateway/uplink-overflow` 失败；上行项不会跨载体代际重放，需要恢复上行的领域在重开的请求里自带确认游标。
- 安装 Remote Event 过滤器会把每个 pending 的 waterfall 投给它接受、且尚未收到它的每个已连接 Client，其他事件都不回头处理：没发给某个 Client 的通知不会重放，移除过滤器也不撤回已入队的事件。`hasLiveClient()` 计入每个打开的 `$events` Client，不管过滤器如何判定。移除从下一次逐 Client 判定起生效，所以过滤器在判定中移除自己时，同一事件余下的 Client 按没有过滤器时的规则处理。
- 成员准入开启而没有安装 Remote Event 过滤器时，`$events` 照常打开并发出 ready frame，但没有 Client 收到任何事件：这段时间里发出的通知到不了任何 Client，与没有 Client 连接时相同，也不会重放；pending 的 waterfall 要等装上过滤器、或被接受的 Client 下次连上时才投给它。
- 过滤器只看得到事件名与其 JSON 载荷；判断事件关乎哪位成员（例如 `agentId` 指向的会话归谁）由安装它的插件负责。
- `remote/invoke` 只覆盖 Remote 方法调用：Gateway 自有的 `$events` 流与 `$events/result`、Connection 的精确 Fetch 路由及其专用 RPC 通道都不经过它。
- `remote/invoke` 没有上行钩子：`RemoteInvokeCall` 不暴露上行，Client 的上行项不经过监听器。
- `RemoteInvokeCall` 不带载体的取消信号，监听器看不到客户端断开：监听器在调用 `next()` 之前的 await 期间载体中止时，`next()` 仍调用方法，方法读到的 `ctx.invocation.signal` 已经中止。一元调用随后以方法的结果完成，不以取消失败，不检查 signal 的一元方法在客户端断开之后照常运行。流调用在被读取时仍以取消失败，async generator 方法体不会运行。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

./stream-protocol 导出为原生桌面调用方提供共享的 Remote 流帧格式和解析器。它们与浏览器客户端使用同一个经过认证的 WebSocket 端点。
