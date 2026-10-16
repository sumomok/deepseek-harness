# Agent Note: 一个 Host 服务多位成员

Status: implemented

[English](2026-10-05-console-member-peers.md) | 中文

相关：[Peer 身份属性与 Remote 方法级访问控制](2026-10-12-peer-principal-and-remote-access.zh.md) 部分取代本记录。Peer 上的成员身份（`principal`）、`connection.createPeer()`、经 `remoteAccess.decide()` 的方法级访问控制、按策略过滤的事件广播，以及精确 Fetch 路由默认答 403，均属上游；本记录只记叠在它们之上、fork 保留的三个窄补丁。[Remote 双工流](2026-09-19-remote-duplex-stream.zh.md) 描述两份记录共同依赖的 Peer 作用域。

## 问题

fork 的服务器控制台在一个 Host 进程里服务多位成员，每位成员经客户自己的系统登录。上游给 Peer 带上 principal，允许业务包声明非 owner principal 种类并为其注册 remote-access 策略，并按该策略检查每个 Remote 调用、列表结果与广播。对控制台仍有四处缺口。

准入：`connection.admit()` 把每个带有效浏览器 cookie 的可信请求答成 owner `browserPeer`，把 `/connect` 用启动令牌换出的每个 API Cookie 答成 owner API Peer。没有接缝能把已登录成员的请求映射到成员 Peer，所以成员要么以 owner 身份进入 Host，要么进不来。控制台的登录代理会把启动令牌交给每个通过登录门的成员，所以 `/connect` 的兑换同样不能造出 owner 权限。

审批：上游的安全不变量「非 owner 不应答 waterfall」不向非 owner 的 `$events` 流发送任何 waterfall 帧（如工具审批或用户提问），并拒绝其 `$events/result`。成员无法应答自己会话的审批与提问。

精确 Fetch 路由：共享 Fetch handler 对每个非 owner Peer 答 403；上游记录把这一点标为临时，直到各路由声明自己的访问规则。因此成员无法向自己的会话上传文件、导出会话日志或查看文件预览。

在线状态：控制台在成员没有任何打开的 Remote socket 时关闭其空闲成员 Peer，而上游不通告 socket 的打开与关闭。

## 决策

fork 保留三个补丁，每个都是上游未提供的接缝，其余一律使用上游机制。控制台的成员 principal 种类、策略与准入器在控制台插件里，不在核心中。

### 准入接缝与 socket 事件（`connection-member-peers`）

`ctx.connection.peers` 含 `admitWith(admitter)` 与 `requireAdmitter`。`admitWith` 安装唯一的同步 `PeerAdmitter`；第二次安装抛错，注册是安装方 fiber 的 effect。`admit(request)` 先跑 Connection 自己的信任检查，再跑浏览器 cookie 或 API Cookie 认证；任一不过的请求按上游拒绝，不调用准入器。装着准入器时，每个已认证请求（包括 `/connect` 签发的 API Cookie）都代表准入器返回的 Peer，通常是经 `createPeer({ principal })` 创建的 Peer。准入器的 401 或 403 即为拒绝；答 `undefined`、返回已释放的 Peer 或抛出异常时以 401 拒绝，并记日志、不含请求头的值。保留 owner 权限的操作者由准入器返回 owner Peer；不经准入器，任何请求都拿不到 owner 权限。

Config 字段 `requireAdmitter`（默认 `false`）在没有安装准入器时以 401 拒绝每个已认证请求，覆盖准入器插件 apply 之前与其重启期间的窗口。`peers.requireAdmitter` 报告解析后的值，准入器插件据此在缺少它时拒绝启动。`requestRejection()` 对已准入的非 owner Peer 答 403，因为它把关的路由（如 open-in-app 与 inspector 的裸路由）不做其他访问检查。

装着准入器时，`/connect` 签发的 API Cookie 仍指向它自己的凭据记录，升级照上游认领该记录：同一 Cookie 上的第二条 socket 以 409 拒绝，socket 释放时删除该记录并释放其 owner API Peer，从不释放成员 Peer。装着准入器或设置了 `requireAdmitter` 时，`/connect` 至多保留 `maxUnclaimedApiPeers` 个没有 socket 认领的凭据（默认 64），超出时让最早的退役；否则任何持有启动令牌的成员每兑换一次就多留一个 owner API Peer，直到 Host 关闭。

Gateway 的 Remote 流服务器在 socket 绑定到其存活 Peer 之后通告 `remote-stream/socket-opened(peer, socketId)`，在 socket 关闭且其流结束之后通告 `remote-stream/socket-closed(peer, socketId)`。`RemoteSocketId` 是取自进程级计数器的 branded 标识，不上线路。监听器抛错会被记录，不影响 socket。

上游没有对应物：其 `admit()` 把每个已认证浏览器与每个 `/connect` 调用方都映射到 owner Peer，`connection/request` waterfall 在准入之后运行且不能更换 Peer，WebSocket 升级归 Gateway 所有，所以没有插件级扩展点能把成员挂到请求上。

### 成员 waterfall（`remote-event-delivery-filter`）

owner 的 `$events` 流照上游收到每个 waterfall。`interactions: 'answer'` 的非 owner 流在 remote access 对 waterfall 的 `agentId` 所指资源（种类取 `agent` Host Context 适配器声明的种类）允许动作 `event:<name>` 时收到该 waterfall；没有该声明时任何非 owner 都收不到。Gateway 在 waterfall 首次投递时以及向新连上的流重放挂起 waterfall 时作判定。非 owner 的 `$events/result` 只结算投递给该流的 waterfall。remote access 不再允许该流应答时，Gateway 抛 `gateway/interactions-forbidden`，该 waterfall 对仍被允许的流保持挂起。策略变化不向已打开的流补投；成员重连时收到新被允许的挂起 waterfall。`hasLiveClient()` 仍只计 owner 流。

上游没有对应物：非 owner 的 waterfall 投递与应答被无条件拒绝，没有策略可以判定。

### 带自身访问规则的精确路由（`connection-fetch-guard`）

`ConnectionFetchRoute.serveNonOwner(request, peer)` 是路由自身的访问规则。共享 Fetch handler 把存活非 owner Peer 的每个请求交给它而不是 `fetch`，该 Peer 已释放时答 401，未声明规则的路由保持上游的 403。规则以路由路径为动作调用 `remoteAccess.decide()`，每次调用至少列出一个资源，因为不列资源的请求会被 remote access 放行；被拒或宿主没有 remote access 时答 403。规则判定所用的值与路由随后服务时使用的值出自对请求的同一次解析，所以重复的查询参数无法让判定看到一个会话、读写落到另一个会话。

三条路由声明了规则。原始上传（`/api/session/uploadFileBinary`）在读取请求体之前判定其指明的 `sessionId`。会话日志导出判定所请求的会话，带后代时还判定将纳入的每个后代。`/api/file` 只读取 `sessionId` 所指会话工作区内的文件：remote access 必须对该会话允许 `/api/file`；工作区取会话 header 的 `cwd`，来自活会话或 `sessionPersistence.stat`；工作区与请求路径经 `ctx.fs.resolve` 解析为真实路径，`ctx.fs.contains` 必须判定文件在其内，读取使用同一个已解析目标。Chat 与文档预览在文件 URL 中指明当前查看的会话。

其余精确路由对成员保持 403。`/api/present.open` 与 `/api/changes.open` 以 POST 在服务器本机启动宿主原生打开器，以 GET 列出宿主应用；`/api/present.host` 报告宿主桌面元数据；`/api/changes.summary` 与 `/api/changes.diff` 读取会话级变更记录，未声明规则；inspector 的 bootstrap 提供宿主内部信息。

上游没有对应物：共享 Fetch handler 在每条精确路由上拒绝每个非 owner Peer，路由也没有声明自身规则的途径。`serveNonOwner` 是上游记录预期的形态，即每条路由一条规则，所以各路由的规则随上游的规则一起退役。

`webServer.routes()` 列出当前生效的路由、升级路由与已占用的回退座位，组合的门禁测试据此为每条登记在 Connection 准入之外的路由分类。

### 控制台的义务

控制台插件经 `PrincipalMap` 声明合并声明其成员 principal 种类，注册其 remote-access 策略，安装准入器把已登录成员映射到 `createPeer({ principal })` Peer、把操作者映射到 owner Peer，设置 `requireAdmitter: true`，并依据 socket 事件关闭空闲成员 Peer。其策略在每位成员的会话上列出 Remote 端点、成员应答的审批与提问对应的 `event:<name>` 动作，以及路由路径 `/api/file`、上传路径与导出路径。经 `probeTargets` 的引用探测需要 `global` 角色。

子代理的审批或提问是子会话的 waterfall，其帧的 `agentId` 是子会话的 id。只有 policy 把该子会话也绑给成员时，成员才收得到、答得了。

准入器凭控制台登录代理设置的请求头识别成员，代理先删掉客户端发来的同名头再设置；Host 只能经该代理访问。Connection 分不清代理设置的头与伪造的头。

`/api/file` 把成员限定在会话 `cwd` 解析出的真实路径之内，所以只有 `cwd` 来自控制台时这一限定才成立。上游 `session/create` 接受调用方传入的 `cwd`，所以控制台的 policy 拒绝成员带 `cwd` 的 `session/create`，只留下控制台管理的 `workspaceId`，或者其 condition 在解析出真实路径之后判定 `cwd`；字面前缀判定会被指向外部的符号链接绕过。

上游 `workspaceFiles/read`、`readBytes` 与 `stat` 也能读工作区之外的文件，只有 `list` 限定在工作区内。授给成员就多出一条读取宿主任意可读文件的路径，所以控制台的 policy 不把它们授给成员，或者只在一个按解析后真实路径判定所请求路径的 condition 下授予。文档预览经 `workspaceFiles/read` 读取，所以不授予它也就不提供预览。

### 退役

上游 Connection 提供准入接缝时，`connection-member-peers` 退役：`git grep -n "admitWith\|PeerAdmitter" <tag> -- packages/client/connection/src` 返回上游写的命中。上游通告 Remote socket 在线状态时，socket 事件退役。

上游允许策略判定非 owner waterfall 时，`remote-event-delivery-filter` 退役：`git grep -n "only owner Peers answer forwarded Remote events" <tag> -- packages/api/gateway/src` 不再找到上游对非 owner `$events/result` 的拒绝，或 remote-access README 中关于非 owner waterfall 的限制已删除。`answers: peer.principal.kind === 'owner'` 这一行不作判据：本补丁保留了它。

上游路由声明自身的非 owner 规则时，`connection-fetch-guard` 退役：`git grep -n "kind !== 'owner') return Promise.resolve(new Response('forbidden'" <tag> -- packages/client/connection/src/rpc-host.ts` 不再找到一刀切的拒绝。其 `routes()` 部分在 `git grep -n "routes(" <tag> -- packages/host/webserver/src` 找到上游的列举时退役。

## 考虑过的替代方案

**保留早期 fork 机制。** Connection 内的成员 Peer、包住每个 Remote 调用的 `remote/invoke` waterfall、挡在每条精确路由与通道前的 `connection/fetch` waterfall，以及 Gateway 投递过滤器，与上游 principal 和 remote-access 机制现已覆盖的内容重复，使宿主有两套访问模型，并在每次同步上游 Gateway 与 Connection 时冲突。

**在插件里做准入。** `connection/request` waterfall 在准入之后运行且不能更换 Peer，升级路由归 Gateway 所有，所以不在 `admit()` 里开接缝，插件就无法把成员挂到请求上。

**异步准入器。** 它会让 `admit()` 变成 promise，并改动升级路由与每个 `requestRejection` 调用方；从带签名的请求头识别成员不需要 I/O。

**准入器不认识请求时回落到 owner。** 那样仅凭有效浏览器 cookie 就能拿到宿主全部权限。

**让 `/connect` 的 API Cookie 绕过准入器。** 控制台登录代理把启动令牌交给每个通过登录门的成员，这条路径会为任何成员造出 owner Peer。

**按存活时间而不是数量限制未认领的 `/connect` 凭据。** 时间上限只能通过兑换速率间接限制凭据数量，还会让仅用 HTTP 的调用方仍在用的凭据过期；数量上限与速率无关，只让最早的凭据退役。

**对所有非 owner 解除 waterfall 禁令。** 成员会收到并应答其他每位成员会话的审批；改由策略按会话判定。

**策略变化时补投挂起的 waterfall。** remote access 没有为此提供投递时的通知，而重连已经能收到策略当前允许的每个挂起 waterfall。

**为精确路由设一个全路由 waterfall。** 其监听器共用一个 `next()`，必须取消被丢弃的路由 body，并把每条路由都挂在一个 fork 钩子之后；每路由一条规则沿着上游声明的方向走，并能逐路由退役。

**把 `/api/file` 限定在沙箱工作区根、附件存储或字面路径前缀之内。** 沙箱根是部署共用的缺省目录，不属于任何成员；附件已经经过 Gateway 的 Remote 访问检查；字面前缀检查会跟随符号链接走出工作区。

**向成员开放 `/api/present.open` 与 `/api/changes.open`。** 它们在服务器本机启动宿主原生打开器，成员不得触发。

## 影响

- **得到**：成员只能以控制台准入器返回的 Peer 进入宿主；能应答策略授予的会话的审批与提问；能向这些会话上传文件、导出其日志并预览其中文件；控制台经 socket 事件得知成员在线状态。
- **核心改动面**：Connection 的 `rpc.ts`、`rpc-host.ts` 与 `index.ts`；Gateway 的 `index.ts`、`stream-server.ts` 与 `types.ts`；`dsh-client-file-upload`、`dsh-session-log-export` 的路由与 `dsh-api-session-controller` 的媒体引用；`fileMediaUrl` 及其在 Chat 与文档预览中的调用方；webserver 的 `routes()`。这些补丁在桌面线上不生效，桌面线不安装准入器，也不创建非 owner Peer。
- **`requireAdmitter: false` 时，移除准入器会重新对每个已认证浏览器开放 owner 准入**；成员部署将其设为 `true`。
- **`requireAdmitter: true` 而没有准入器时，拒绝每个已认证请求**，直到装上准入器。
- **Connection 不回收成员 Peer**：空闲关闭由准入器插件负责。
- **装着准入器时，一个 API Cookie 只服务一条 socket**：其上的第二条 socket 得到 409；仅用 HTTP 的调用方的凭据在出现 `maxUnclaimedApiPeers` 个更新的未认领凭据后退役。
- **成员读文件有两项残余**：在包含判定与打开之间把工作区内一个已解析的目录换成符号链接，读取会跟随该链接；工作区内一个指向工作区外文件的硬链接不需要竞态就能通过判定。两者都需要对工作区有写权限。
- **未带会话构造的图片 URL 对成员被拒**，显示其 alt 文本。
- **成员离线时其审批等待**，与上游 owner 的情形相同，直到其 Agent Context 或 signal 结束它。
