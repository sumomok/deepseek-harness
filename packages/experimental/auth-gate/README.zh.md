# @deepseek-ai/dsh-experimental-auth-gate

[English](README.md) | 中文

把部署方自己的单点登录接进 dsh 的浏览器会话。browser 半边把没有 access token 的访客送去部署方的登录页，并把访客带回来的那一枚镜像进 cookie；node 半边把这枚 token 放在内存里，并花在这个部署要转发的那些 MCP 服务器上。本包既不签发、不验签，也不续期——它只是把一枚已经存在的 token 送到 dsh 需要它的那两个地方。

它只为一种部署形态而存在：一台反向代理立在多个 dsh 进程前，一位登录用户一个进程，由代理自己验签访客的 token 来决定请求进入哪个进程。请求抵达时，谁在另一头这件事代理已经判完了——这正是进程内部不再验签的原因。

## 每次页面加载时，这道闸做什么

1. 从 `/auth-gate/settings` 读取本插件面向浏览器的那部分配置。browser 半边拿不到任何 cordis 配置——boot manifest 携带的是插件名，不是它们的 `config` 块——所以设置文档不可达或不可用时直接让这一行失败，而不是让闸门跑在一个谁也没选过的登录地址上。
2. 读 `localStorage.accessToken`，并把它开头的 `Bearer ` 去掉。这两半都是与部署方登录页的约定，而不是本插件做的选择：key 是那个页面写入的 key，值是那个页面自己的 HTTP 客户端原样放进 `Authorization` 头的东西，连 scheme 一起。这一点之下的一切——反向代理读的那枚镜像 cookie、token 路由、node 半边转发时花掉的凭据——携带的都是裸 JWT，而 token 路由本身也只接受裸 JWT。
3. **没有 token、读不出来的 token、没有 `exp` 的 token，或是已经过期的** —— 交出这枚 token 并前往 `<loginUrl>?redirect=<编码后的返回地址>`，而返回地址就是访客请求的那个页面、去掉登录页自己那些凭据参数之后的样子。下文的**交出 token**给出这三步以及它们的先后。没有 `exp` 的 token 会被拒绝而不是当作永不过期，因为闸门的整套排期都建立在这一项声明之上。
4. **可用的 token，但 cookie 里还不是它** —— 写 cookie，然后重新加载页面，这样接下来的那次请求就已经带上了它。
5. **可用的 token，且 cookie 里已经是它** —— 让页面跑起来，并 `POST /auth-gate/token`，好让 node 半边可以花它。

页面运行期间，`storage` 事件——另一个标签页登录、登出或续期——会以「重新读一次存储」而不是「相信事件里的值」来处理。同一个人换了更新的 token，就更新 cookie 并告知 node 半边，不重载。`sub` 变了则整页重载，因为屏幕上的一切都是以另一个人的身份取回来的。token 没了或过期了，则把访客送回登录页。

### 镜像永不成环

整套设计正是围着这个故障塑形的：决定要镜像的那次启动以一次 reload 收尾，而如果那次 reload 又决定要镜像，这个标签页就再也干不了别的事了。

守卫是结构性的，不是计数器。镜像会写 cookie、**读回来**，只有读回来确实是那枚 token 时才 reload。没写进去的情况——页面跑在明文 HTTP 上，或该源的 cookie 被禁用——会让这一行失败，诊断里点名那个 cookie，而且完全不发生 reload。真正发生的那次 reload 会发现 cookie 已经一致，于是走 `ready` 那条路，不再重载任何东西。那条诊断里不会出现 token，也不会出现它的任何片段。

### 镜像 cookie 为什么不是 `HttpOnly`

token 本来就住在 `localStorage` 里，是部署方的登录页放进去的，页面上任何脚本都读得到。一个页面自己的脚本读不到的 cookie 并不能收窄任何攻击面——被注入的脚本直接读原件即可——却会让镜像无法与之保持一致。`Secure` 与 `SameSite=Lax` 仍然生效：前者让它不走明文链路，后者让它不出现在跨站子请求里。

这枚 cookie 存在，是因为那些不带 `Authorization` 头的请求——导航、图片、iframe、下载——同样得向立在本进程之前的东西表明访客身份。

### 过期

在 token 的 `exp` 之前 `refreshMarginSeconds` 时，闸门动作。在本包里这意味着把访客送回登录页——这是每个部署都有的那一条续期路径。`src/client/run.ts` 里的 `handleTokenExpiring` 是这项决定唯一被做出的地方，也是那个余量唯一的读者：若某个部署的单点登录提供续期端点，就替换这个函数的函数体，闸门的其余部分都不依赖 token 是怎么续的。

### 交出 token

有三处决定会前往登录页：启动时没找到可用 token、另一个标签页删掉了 token 或让它过期、以及到达过期余量。三者跑的是同一套三步，顺序固定。

1. **`POST /auth-gate/logout`**，让 node 半边不再花一枚访客已经没有的凭据。请求带 `keepalive`，否则第 3 步的跳转会把这个由文档持有的请求取消掉。
2. **清掉镜像 cookie**，用与写入镜像时逐字相同的 `Path`、`Secure`、`SameSite`——浏览器是按名字、路径和域来把一次删除对应到已有 cookie 的，任何一项不同都会写出第二枚空 cookie，而把 token 原样留在那里。一枚在这里活下来的死 token，会继续在登录页自己发出的每一个请求上呈给立在本进程前的反向代理。
3. **跳转到登录页**，并把返回地址里的 `token` 与 `token4a` 去掉——查询串里的和片段里的一并去掉。这两个正是部署方登录页读取凭据的参数；把其中之一交回去，等于把闸门刚刚拒绝掉的那枚 token 经由浏览器历史、以及登录页发出的每一个 referrer 又送了回去。片段也要剥，是因为那个页面读参数读的是整个地址而不是它的查询串——toy-core 的 `getUrlParam` 解析的是 `location.href` 里第一个 `?` 之后的全部内容——所以只去掉查询串里的那一枚，反而会把挡着片段那一枚的 `?` 一起拿走，把它露出来。片段自己的路由和其余参数都保留：这些页面是 hash 路由的，片段就是地址。

这个顺序成立与否，取决于浏览器在什么时刻附上 cookie。第 1 步的请求经由同一个反向代理抵达本进程，而代理正是靠第 2 步随即删掉的那枚镜像 cookie 来路由它的；这一序列之所以成立，是因为浏览器在 fetch 发起的时刻就附上 cookie，Chromium 便是如此。若某个浏览器改在发送时才读，它就会一枚都不带，代理会拒掉这次登出，唯一的痕迹是控制台里的一条 warn，而 node 半边会继续持有那枚 token 直到进程结束。

## 路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/auth-gate/settings` | GET、HEAD | browser 半边必须遵守的那三个配置值。`no-store`：浏览器每次启动读一次，值来自它启动时那一行。 |
| `/auth-gate/token` | POST | 接收浏览器找到的 token。以 204 且无正文作答。 |
| `/auth-gate/logout` | POST | 丢掉持有的 token。以 204 且无正文作答。 |
| `/auth-gate/mcp/<name>` | 任意 | 转发到 `<name>` 下配置的上游，并带上持有的 token。 |

token 路由只接同站点、只收 JSON：被浏览器标为 `sec-fetch-site: cross-site` 的请求以 403 拒绝，未声明 `application/json` 的以 415 拒绝，两者都发生在读取正文之前，于是跨源页面无法把一枚 token 作为免预检的简单请求发出来。正文不是一份 `token` 字段为三段式 JWT 的 JSON 文档时以 400 拒绝，而且两种拒绝都不会引用被投递的内容——一条点名了「差一点就对」的凭据的诊断，会把它送到任何读这份响应的地方。

登出路由带着这道栅栏的两层，并且完全不读正文：它不点名任何 token，只是丢掉当前持有的那一枚——而那正是本进程所服务的唯一一位访客的 token。一个能够到达它的跨源页面，就能把这位访客从他正在使用的部署里登出去，而只有同站这一层是拦不住的——完全不带 `sec-fetch-site` 头的请求就能通过那一项检查，所以真正把这条路由从「免预检的简单请求」集合里撤出来的是 `application/json` 这项要求。browser 半边会声明这个 content type，且不发送任何正文。

token 被放在插件内部的一个闭包里，且不写去任何地方：没有会话事件、没有设置文档、没有日志行、没有诊断。没有任何一条路由能把它读回来，而唯一会改动它的路由，要么把它换成更新的一枚，要么把它丢掉。

## 带着 token 转发 MCP 请求

`dsh-mcp-client` 在它那一行加载时把 headers 解析一次。它没有办法附上一个「稍后才到达、且随登录者而不同」的凭据——而 access token 恰恰就是这种东西。`mcpUpstreams` 里的每一条都以「认领一条本地路由」来补上这个缺口；MCP 客户端那一行随后把 `url` 指向这条路由，而不是指向服务器本身：

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    loginUrl: /toy-proxy/toy-login/#/
    cookieName: accessToken
    refreshMarginSeconds: 300
    mcpUpstreams:
      crm: https://mcp.internal/crm

- id: mcp-crm
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: crm
    transport: streamable-http
    url: http://127.0.0.1:3080/auth-gate/mcp/crm
```

转发骑在 dsh webserver 自己的路由注册表上，而不是自管一个监听。它的 `WebRoute` handler 拥有完整的响应生命周期，而这正是一次 MCP streamable-HTTP 交换所需要的：一次 POST 以 JSON 文档或一条挂住的事件流作答，一次 GET 为服务器到客户端的流长期挂住。两个方向都按字节中继而不解码，因此事件流是增量抵达 MCP 客户端的。

这次转发改动了什么，以及仅此而已：

- **`Authorization` 换成持有的 token。** 调用方自带的凭据是被替换而非透传的，因此没有东西能把凭据夹带过闸。
- **`Cookie` 被丢弃。** 镜像携带的正是同一枚 token，而上游没有理由收到浏览器的 cookie jar。
- **逐跳头与 `Host` 双向丢弃**；传输层发出的其余一切原样存活。
- **路由前缀之后的路径与 query string 会被带上**，接到目标自己的路径之后。

在还没有任何浏览器投递过 token 之前，每条转发路由都以 503 作答并点名该上游——对于一枚进程尚未持有的凭据，这是诚实的答复。上游不可达是 502；答到一半掉线的，响应被截断，因为状态码已经发出去了。

## 组合

本包不在任何已发布 bundle 中。`overlay/auth-gate.patch.yml` 把这一行插到任意 surface 之上：

```yaml
- insert:
    - id: auth-gate
      name: '@deepseek-ai/dsh-experimental-auth-gate'
      config:
        loginUrl: /toy-proxy/toy-login/#/
        cookieName: accessToken
        refreshMarginSeconds: 300
        mcpUpstreams: {}
```

用 `dsh --profile web --patch <path>` 应用它。每个包都必须能从 profile 目录解析到，对于树外插件这意味着 `dsh plugin --profile web add <path>` 或等价的链接——发布 bundle 不得声明实验性包。

每一个配置值都是必填并在加载时校验的：空的 `loginUrl`、已经带了 query string 的 `loginUrl`、不是纯 cookie 名的 `cookieName`、不是纯路由段的上游名，以及不是「无 query 无 fragment 的绝对 HTTP(S) URL」的目标，都会让这一行失败，而不是变成「跳去一个不存在的地方」或「首次调用才失败的工具」。

## Model Experience

None, as this package registers no tool, prompt section, or result: it carries a credential between the browser, the process, and the MCP servers the process forwards to, all of which happens outside any model request, and the tools those servers publish are `dsh-mcp-client`'s model-facing contribution rather than this package's.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated; whether an MCP server's tool list moves between requests is that server's behavior under `dsh-mcp-client`'s contract.

## Known Limitations and Deferred Work

- **这道闸不会先于外壳其余部分运行。** 浏览器侧的行是一起创建的，各自等自己的服务，因此未登录的访客可能在跳转发生前先看到外壳画出来。`dsh.client.immediately` 让这一行的 bundle 字节在第一梯队被取回，缩短了这个窗口，但并不排序激活；只有 client runtime 里的一道启动阶段缝才能关掉它。
- **过期时把访客送回登录页。** 没有续期调用，因此即便部署方的单点登录本可以静默签发一枚新的，token 用完仍要付一次完整导航的代价。为此留的位置只有 `handleTokenExpiring`，别无其他。
- **转发只走 HTTP。** 没有 upgrade 路由，因此以 WebSocket 抵达的 MCP 服务器无法经它转发；这条路由服务的是 streamable-HTTP 及其事件流。
- **整个进程只有一枚 token。** node 半边持有任何浏览器投递过的最新一枚。这与本包面向的部署形态相符——一位登录用户一个进程——而对于多人共用一个进程的场景则是错的：那时最后加载页面的那个浏览器会决定每一次 MCP 调用花谁的凭据。
- **只有闸门自己那三处登录决定会登出。** `POST /auth-gate/logout` 会丢掉持有的 token，而调用它的只有 browser 半边的启动、storage 变化与过期这三条路径——没有登出控件，也不会打断此刻正在跑的 agent loop。访客若是直接关掉标签页，进程就会继续持有那枚 token，直到进程结束，或另一个浏览器投递了更新的一枚。
- **不带 token 的访客也会登出一次。** 启动决定无论存过东西与否都走这个出口——这是有意的，因为 node 半边可能仍持着上一位加载过页面的访客的 token——而在反向代理后面，这次请求不带镜像 cookie、被答以 401，只在控制台留下一条无害的 warn。
- **一次撤销不会被撤回。** browser 半边只在一个地方把 token 交给 node 半边——那次让页面跑起来的启动决定或 storage 变化决定——因此一次在页面仍在运行时抵达的登出，会让这个页面的 MCP 转发一直答 503 直到它重新加载，而屏幕上没有任何提示。有两种情况会走到那里：一次晚到的登出请求丢掉了它之后才被投递的那一枚 token，以及一个越过了这条路由栅栏的跨源页面。要关掉它，要么在请求里点名要丢的那一枚 token，让晚到的那次撞不到更新的凭据，要么在页面重新可见时把当前这一枚再投递一次。
- **设置路由假定存在 HTTP 载体。** browser 半边按页面源相对地址 fetch `/auth-gate/settings`，因此一个「提供外壳但不经 HTTP 暴露 harness」的传输会让这一行失败。
- **不被任何组装快照覆盖** —— 浏览器侧的证据是 `apps/web/tests/auth-gate.e2e.ts` 里那个针对真实组合的 Playwright 场景；快照通道回放的是已发布组合，而它不组合实验性行。
