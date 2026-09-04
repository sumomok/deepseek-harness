# Agent Note: 把控制台挂到部署路径前缀下，而这个前缀只有浏览器知道

Status: implemented

[English](2026-09-04-base-path-for-the-server-console.md) | 中文

## Problem

server 线要在一台共享 nginx 后面给每位用户发一个外壳，唯一撑得住的地址空间是路径前缀——`https://host/console/`，而不是一个进程一个子域名。harness 挂不上去。一个 `dsh` 进程对前缀一无所知：`WebServer` 的 `Config` 只有 `host` 与 `port`，`packages/`、`apps/`、`examples/` 里没有任何地方读 `x-forwarded-prefix` 或 `basePath` 的任一种拼法，而每条路由都是根绝对注册的（`/api`、`/plugins`、`/manifest.webmanifest`，外加本仓自有插件认领的七条）。所以在 `location /console/ { proxy_pass http://…/; }` 后面，进程看到的正是它注册的那些路径，并且答得没错。

坏掉的是浏览器这一半，而且是三处彼此独立的坏法，现有测试一处都看不见。

- 构建出来的外壳按 origin 根寻址。Vite 没有 `base`，`dist/index.html` 里写的是 `/assets/…`、`/favicon.svg`、`/manifest.webmanifest`；挂上前缀后这就是四个 404 和一张白页，一行应用代码都还没跑。
- 页面在运行期拼的每个 URL 都按 `location.origin` 解析。同一个 `resolveBase()` 有三份互相独立的复制——`client/connection/src/client/rpc.ts`、`host/apiproxy/src/fetch/client.ts`、`session-log-export/src/client/controller.ts`，连 `INTERNAL_BASE` 字面量都各写各的——再加上两条 WebSocket 下行、HMR 的 `EventSource`，以及本仓四个自有插件各自去取的 settings 路由。
- 插件 bundle 在 boot manifest 里是根绝对命名的，其中两个还在任何脚本跑起来之前就被请求：`client-modules` 把 `client-modules` 与 `client-runtime` 作为解析阻塞的 `<script src>` 行注入，任何运行期钩子都够不着它们。

验证面上有一处对应的缺口。`apps/web/tests/assembled-boot.ts` 把页面地址钉死在 `'/'`，所以任何装配级场景都分辨不出根绝对 URL 与前缀相对 URL；而 `auth-gate.e2e.ts` 用 `location.pathname === '/'` 统计外壳加载次数，挂上前缀后，这会把「镜像恰好重载了一次」静默翻转成「外壳一次都没加载」，而且不会在任何读者会去看的地方失败。

## Decision

**前缀只活在一个插件的 `Config` 里，并以两条 index 注入行抵达浏览器。** `@deepseek-ai/dsh-experimental-server-base` 在加载期校验 `basePath`——首斜杠、尾斜杠、无查询串、无片段、无空段，且只含 URL 路径段允许的字符——随后经 `webserver/index-inject` 贡献 `<base href="<basePath>">` 与一条 `{ kind: 'global', name: '__DSH_BASE__' }`，两条都带 `{ prepend: true }`。那个字符集正是让 `<base>` 这一行可以直接插值写出来的原因：`"`、`<`、`>`、`&` 都在集合之外，所以配置与被服务的标记之间不需要任何转义步骤。`prepend` 是承重的而非风格：head 行按表内顺序渲染，而 `<base>` 只管辖排在它之后的 URL，所以由一个更早注册的监听器贡献的行（那两个解析阻塞的 bundle 标签就在其中）会改按文档 URL 解析。

**路由常量在所有地方都保持根绝对；`clientUrl` 是把常量变成浏览器可请求 URL 的唯一受支持途径。** `packages/client/connection/src/client/base.ts` 导出 `INTERNAL_BASE`、`resolveClientBase()` 与 `clientUrl(path)`，`@deepseek-ai/dsh-client-connection/client` 把三者一并再导出。`clientUrl` 在解析前剥掉全部前导斜杠，因为根绝对路径会替换掉前缀而不是延长它。三份重复的 `resolveBase()` 收敛到它，`API_PATH` 与本仓自有插件的六个路由常量都保留根绝对拼法，也没有任何包新添一份 segment 形状的路径副本——node 半边注册这个常量，浏览器半边解析同一个常量。

`resolveClientBase()` 的 authority 恒取自 `location.origin`，只让 `__DSH_BASE__` 与 `document.baseURI` 贡献路径部分。这比「优先 `document.baseURI`」更窄：一个指向别的 origin 的 `<base href>` 无法把 Host 流量引走，而一个 URL 不能作基址的文档（`about:blank`、沙箱化的 frame）在退回兜底的路上也不会抛异常。

**bundle URL 在它唯一的组装点上被相对化。** `client/modules/src/index.ts` 里的 `graphRow` 产出 `plugins/<id>/client.js?rev=<rev>`，两个消费者——解析期 preload 与模块系统的 `el.src`——随后都经文档基址解析。`client/system.ts` 刻意不再自己补基址；两者是二选一，都做就是加两次前缀。

**镜像 cookie 被收窄到前缀。** auth-gate 的 `mirrorCookieLine`/`clearCookieLine` 接收 `path`，`windowGateBrowser` 只算一次 `new URL(resolveClientBase()).pathname`，让写入与清除逐字重复同一个值——浏览器按名字、路径、域名匹配一次删除，属性对不上就会写出第二枚空 cookie，而把 token 留在原地。`server-sidebar` 的退出流程用自己那份复制的 cookie 行清同一枚 cookie，因此 `windowSignOutBrowser` 用同样的方式解析这个前缀；有一条单测把两行相比，而不是信任那份复制品。

**`apps/web/vite.config.ts` 设的是 `base: './'`，不是前缀。** 一份构建产物因此能挂在任意前缀下，这正是一用户一进程的拓扑所要求的；`base: '/console/'` 会把某一个前缀烙进产物。

## Alternatives considered

**用 `__DSH_TRANSPORT__` 复刻整套传输。** 否决。它确实是文档化的整体替换缝——`createApiClient`、`fetch`、`loadBundle`——也确实能保住「不改上游」的字面。但它盖不住那两个解析阻塞的 `<script src>` preload（它们在任何脚本跑起来之前就发出），也盖不住构建外壳自身的资源，所以构建配置无论如何都得改。为这个字面付出的代价是在本仓再实现一遍三条传输通道，而对面只是上游六处小而同形的改动——一旦上游自己长出 `basePath`，退化条款当天就让这些补丁退役。

**让进程知道自己的前缀，并按前缀注册路由。** 否决。那样前缀就得在四处各自独立匹配路径的地方同时被照顾——`WebServer` 的路由表、`rpc-host.ts` 的 `endpointFromPath`、`apiproxy/fetch/handler.ts` 的三处 `/api/` 字符串判断，以及 `connection/src/index.ts` 的特权方法围栏——而只改到第一处的改动会产出一批 404，其症状指向路由而不是指向前缀。nginx 本来就是靠剥前缀吃饭的；进程只保留一套路径。

**在 Vite 配置里写 `base: '/console/'`。** 否决：它把前缀从一个校验过的运行期值搬进了构建产物，于是一份构建跑不了两个前缀，而且这个值会存在两处、没有任何机制保证它们相等。

**在 nginx 里用 `sub_filter`。** 否决：它只能改写文本响应体里的字面量，而这里几乎每个坏掉的 URL 都是运行期拼出来的（`new URL(path, origin)`、`new WebSocket(url)`、`el.src = url`），这些字符串根本不会以它能匹配的形式出现在响应体里。它还要求关掉上游压缩，而该模块并未编译进这个部署所用的那台 nginx。

**直接把 `resolveClientBase()` 加进 `apiproxy` 的 `AbstractApiClient`。** 作为依赖环否决：`client/connection` 在包清单与工程引用里都已经依赖 `host/apiproxy`，反向 import 会闭合一个 npm 与 `tsc -b` 都拒绝的环。改法是覆盖 `resolveBase()`——它本来就是 `protected` 的平台缝——覆盖点放在浏览器子类 `WebApiClient`，而 `apiproxy` 只新增一个私有的、仅剥前导斜杠的 `carrierUrl`。没有任何基址解析逻辑被复制；被复制的只有 `INTERNAL_BASE` 这个字面量。

**给 `content-frame` 的 `pages[].url` 也套一层 `clientUrl`。** 否决：`pages.ts` 在加载期要求这些值以单个 `/` 开头，而各部署本来就在那里写完整的浏览器侧路径。再解析一次就是加两次前缀。auth-gate 的 `loginUrl` 同理，浏览器会把它原样赋给 `location.href`。两者都是自带前缀的部署数据；把它们与进程侧路由常量区分开的那句说明，现在写在它们的 JSDoc 与 README 里。

**把路由常量改成不带前缀的 segment（`api`、`plugins/events`、`auth-gate/settings`）。** 否决：node 半边是从同一批常量注册的，segment 拼法会让两半再也用不了同一个路径真相来源。在 `clientUrl` 内部剥掉前导斜杠，用一个常量就得到同样的解析结果。

## Consequences

有两处测试台改动必须先于产品改动落地，否则回归会照常全绿。`assembled-boot.ts` 新增了 `installDeploymentBase(basePath, search)`，复刻插件注入的那三样东西；新增的 `apps/web/tests/base-path-boot.snapshot.ts` 断言没有任何 boot URL——41 条 manifest 行加 2 条 preload——解析到前缀之外；对着根绝对的 manifest，43 条全在外面。`auth-gate.e2e.ts` 的加载计数器改成与具名的 `SHELL_PATH` 比较，不再写死 `'/'`。

`apps/web/tests/base-path.e2e.ts` 把整条链路跑在 `prefix-proxy.ts` 后面——一个四十行的部署 nginx 替身，剥前缀、透传 upgrade，并对任何不该由它剥的路径答 404。它观察到：44 个 bundle 响应落在 `/console/plugins/` 下、`<head>` 里恰有两条相对 preload 且一条根绝对的都没有、两条下行开在 `/console/api/events.{mux,host}`、导出控制器的 HEAD 打在 `/console/api/session.export`、镜像 cookie 的 `Path=/console/`，以及没有任何一个请求打到无前缀的 `/api`、`/plugins` 或 `/auth-gate`。它的最后一例是负向的：经一个恒等代理，同一个 harness 对文档答 404、对 RPC 上行答 405，并直接销毁 WebSocket 升级——这就是让「必须把前缀剥净」成为机械可观测事实、而不是部署手册里一句话的那条证据。

`apps/desktop` 的打包检查必须跟着 manifest 走：`verifyClientModules` 原先在被服务的 index 里扫 `/plugins/…client.js`，改动后一个都扫不到，会以「staged boot served an index naming no client modules」让打包失败。现在它两种拼法都接受，并统一归一到相对形式。

有两个此前对 `client-connection` 没有运行期依赖的浏览器 bundle 现在有了（`session-log-export` 与 `client-hmr`），本仓三个实验性包同理；每个都按 `verify-client-packages` 的要求补齐 `dsh.client.external` 加 peer 与 dev 依赖。`packages/client/hmr/tsconfig.json` 从 Host 基配置换到了 Client 基配置：它是由 client 聚合构建的 `packages/client/*` 包，而只有 Client 面的配置才可以引用 `connection` 的 client 叶子。

`connection/src/index.ts` 的特权方法围栏未改。它的路由以 `kind: 'prefix'` 注册在 `/api` 上，只匹配 `/api` 与 `/api/<任意>`，别的都不匹配，所以仍带部署前缀的路径根本到不了这个处理器；真正能到达它、又读不出方法名的路径只有裸 `/api`，而下游网关对它答的本来就是 404。收紧那处判断等于在没有任何行为变化的前提下动一处上游文件，与「上游改动保持最小且同形」相悖。

### Known limitations

- **按 origin 隔离的存储不按前缀隔离。** `localStorage`（`dsh.workspace.view.v5`、`dsh.conversation.chat`，以及闸门的 `accessToken`）与 CacheStorage 都按 origin 隔离，从不按路径。同一主机上的两个前缀共享全部这些：工作区视图、会话草稿、token 键。同主机多前缀部署需要一进程一子域名，或者给键加上前缀。
- **PWA 在前缀下不受支持。** `apps/pwa` 不在 server 线的组合里，本次一行未动：Service Worker 的作用域由脚本 URL 固定，而离线缓存名与它的 `'/'` 键是 origin 全局的，两个带前缀的部署会互相覆盖对方的离线外壳。`apps/web/public/manifest.webmanifest` 的 `id`、`start_url`、`scope` 出于同一个理由保持根绝对：把它们相对化会把「已安装应用」的身份挪到前缀之下，而 worker 与缓存并没有跟着挪——那半边正是这里够不着的部分。外壳自己的 `<link rel="manifest">` 是相对的，所以这份文件仍然是在前缀之下取的。
- **`<base>` 改变了裸片段链接的含义。** 文档里有基址之后，`href="#x"` 会按基址而不是按当前地址解析。今天的外壳里没有这种链接；日后新增一条，它会从任意路由跳到 `/console/#x`。
- **前缀只是浏览器侧的事实。** 进程内没有任何东西校验代理确实剥掉了 `basePath` 所声称的那一段。不匹配的表现是 404 与被拒的升级，负向 e2e 用例把它钉住了，但没有任何运行期检查会报告它。
- **离开页面的地址是配置，不是解析结果。** auth-gate 的 `loginUrl` 与 content-frame 的 `pages[].url` 必须把前缀写进值里；它们是被原样赋值或原样请求的。
