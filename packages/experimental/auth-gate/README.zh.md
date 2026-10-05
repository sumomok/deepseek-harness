---
description: "把部署方自己的单点登录接进 dsh 浏览器会话：浏览器半边把未认证访客送去登录页并把带回的访问令牌镜像进 cookie，node 半边持有它——整个进程一枚，或每位控制台成员一枚——并把它花在转发的 MCP 请求和数据后端读取上；面向在 dsh 之前验签 token 的部署方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-auth-gate

[English](README.md) | 中文

## 概述

把部署方自己的单点登录接进 dsh 的浏览器会话。browser 半边把没有 access token 的访客送去部署方的登录页，并把访客带回来的那一枚镜像进 cookie；node 半边把这枚 token 放在内存里——整个进程一枚，或每位控制台成员一枚——并花在这个部署要转发的那些 MCP 服务器和它的数据后端上。

## 目录

- [每次页面加载时，这道闸做什么](#what-the-gate-does-on-every-page-load)
- [路由](#routes)
- [带着 token 转发 MCP 请求](#forwarding-mcp-requests-with-the-token)
- [读这套部署自己的数据后端](#reading-the-deployments-data-backend)
- [按控制台成员持有 token](#holding-one-token-per-console-member)
- [组合](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-the-gate-does-on-every-page-load"></a>
## 每次页面加载时，这道闸做什么

本包既不签发也不验签——它只是把一枚已经存在的 token 送到 dsh 需要它的那两个地方；若部署方公布了续期端点，它还会把这枚 token 花在那个端点上，让访客不必再跑一趟登录页就保持登录。

它为两种部署形态而存在。默认的那种：一台反向代理立在多个 dsh 进程前，一位登录用户一个进程，由代理自己验签访客的 token 来决定请求进入哪个进程。另一种由 `perMember` 打开：一个进程同时服务多位控制台成员，由部署方的登录门验签 token 并注入一枚签名的成员身份断言，再由 `consoleMembers` 服务核验这枚断言。无论哪种，请求抵达时，谁在另一头这件事立在前面的那一层已经判完了——这正是进程内部不再验签 token 的原因。

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

token 本来就住在 `localStorage` 里，是部署方的登录页放进去的，页面上任何脚本都读得到。一个页面自己的脚本读不到的 cookie 并不能收窄任何攻击面——被注入的脚本直接读原件即可——却会让镜像无法与之保持一致。`Secure` 与 `SameSite=Lax` 仍然生效：前者让它不走明文链路，后者让它不出现在跨站子请求里。`Path` 取外壳被挂载的部署前缀——挂在源根上是 `/`，挂在带路径前缀的反向代理后面是 `/console/`——这个页面发出的每一次请求都带着它，而同一主机上挂在另一个前缀下的第二个 harness 拿不到它。

这枚 cookie 存在，是因为那些不带 `Authorization` 头的请求——导航、图片、iframe、下载——同样得向立在本进程之前的东西表明访客身份。

### 过期与续期

面对将至的过期，闸门做哪一件事，由 `renewalPath` 决定。不填时，在 token 的 `exp` 之前 `refreshMarginSeconds`，闸门把访客送回登录页——这是每个部署都有的那一条续期路径。填了，闸门改为向那个端点要一枚新 token，访客留在原地。

配置了续期，就有两条排期，都从一枚 token 被接受的那一刻起算，且每接受一枚就重排一次。那一刻之后 `renewalIntervalSeconds`，闸门去要一枚新 token，成败都不出声——部署方自己的客户端用的是同一条规则，手上的 token 比 `accessTokenRenewalTime` 分钟更老就续，这里只是把那条规则做成计时器而不是做成对下一个请求的检查。过期余量也会去要，而对被拒作出反应的正是它：余量上没能续到，就交出 token 并前往登录页，与没有续期端点的部署一贯的做法一模一样。周期性尝试失败是沉默的，因为手上那枚仍然可用，下一次滴答会再要一次。每一次余量只为它排上时的那一枚 token 作答，也只交出那一枚：一次交互要花时间，而在它进行中到来的 token——另一个标签页的、同源上被嵌入的部署页面的、这位访客又登录了一次的——会排上属于它自己的余量，因此旧的那一次失败，对页面此刻手上的凭据什么也说明不了。

同一时刻只有一次交互；余量遇上已经发出的周期性尝试时会等它的答复，而不是再发一次，也不是在第一次的答复还在路上时就离开。已经过了 `exp` 的 token 绝不送出——端点会拒掉一枚已死的，而那种情况在余量那里收场。在镜像 cookie 带上新 token 之前不写入存储，于是反向代理读到的那枚 cookie 与存储里的值从不互相矛盾。浏览器干脆拒掉的存储写入——压根不给配额的无痕窗口、已经满了的配额——算作一次什么也没产出的续期，与它没留住的镜像 cookie 一样。

一枚答复只有在它的 `exp` 比另外两枚都晚时才被采纳。要比发出该请求时所用的那一枚晚，因为端点把收到的那一枚原样答回来等于什么也没续，而余量会以零延迟重排并在同一次滴答里再问一遍，无休无止；这样的答复算作被拒，于是周期性滴答保持沉默，而余量前往登录页。也要比答复到达时存储里的那一枚晚，因为每个标签页各按自己的排期续期，慢到的答复不得盖掉另一个标签页已经存下的更新的一枚。被采纳、而自身已经落在余量之内的续期同样以登录页收场，理由相同：它自己的余量是以零延迟排上的，再从那里续一次就会在端点还肯答复的时间里一直重复。因此，`renewalIntervalSeconds` 在 `refreshMarginSeconds` 之前不留余地的部署，会把访客签出，而不是陷进续期的循环。

`GET <renewalPath>` 发往本页面自己的源，带着部署方自己的客户端为一个已认证请求所发的那些头：存储里那枚 token 原样（含 scheme）放在 `Authorization` 与 `CertificationToken` 两个头上；`localStorage.loginUserInfo` 里存着的那些头放在它们之下；再在最上面盖一枚新的 `TINY-REQUEST-ID`。答复的 `token` 字段按那个部署的 `setToken` 的存法存下——存在 `accessToken` 下，与答复携带的一模一样，并在旁边写上 `accessTokenTime`——于是既有的「存储 → cookie → node 半边」那条路把新 token 送到 node 半边，也送到同源上任何一个被嵌入的部署页面。那个时间戳写成 UTC 的 ISO 8601 时刻，而不是 `dayjs().format()` 给同一时刻的本地偏移写法：部署方唯一的读者 `isTokenRenewal` 取的是差值，而这种写法不会随浏览器所在时区而变。答复里没有 token，或者这个闸门跑不了的那一枚，什么也不改变。

真实部署答回来的是什么，已经测过，而那不是一次续期。2026-09-07 在验收控制台上，按 `renewalPath: /nrms-auth/api/renewal`、`renewalIntervalSeconds: 120` 配置：访客登录后的 36 分钟里，浏览器半边共发出 18 次续期尝试。那一次跑的是本次改动较早的一个构建——那时还没带上上面那条规则——那个构建把每一份答复都收下了，也都投给了 `/auth-gate/token`。读这次运行的量具有两件，都在页面之内。`jti` 与 `exp` 相等是第一件量具给出的：每次滴答之后在页面里解出存储中那枚 token 的 claims，那个值一步也没有离开页面，再逐次相互比对，两者都没有变——而在一个把每份答复都存下来的构建上，这就是端点答回了发给它的那一枚。第二件量具报出的是第 120、240、360、480 秒的那四次续期请求：每一次都答 200，而在那个构建上，每一次之后都跟着一次答 204 的 `POST /auth-gate/token`，两种状态都从页面自己的 `PerformanceResourceTiming.responseStatus` 读到。而按发布出去的这条规则，不把过期时间往后推的答复算作续期失败：在这个构建上，周期性排期什么也不存、什么也不投，余量则交出 token 并前往登录页，与根本没有公开端点的部署一模一样。这次测量落定的是「那个端点接受本包所发的那些头」。它在更靠近过期时答什么，也已用同样的办法、在同一天手工测过：在那枚 token 的 `exp` 之前 2.3 分钟，`GET /nrms-auth/api/renewal` 仍以 HTTP 200 答回同一枚 JWT——`jti` 相同，`exp` 相同——正文里只有两个键，`renewal` 的值是字符串 `"3600000"`，`token` 装的就是那枚 JWT。`exp` 之后 100 秒，同一个请求以 HTTP 401 和空正文作答，而拿同一枚 token 去读元数据（`GET /nrms-schema-manage/api/meta/resclass/SpaceLayer`）也是 401。两次都是从页面里、带着存储那枚 token 的那些头发出的 fetch，答复的 claims 在页面里解出，因此没有任何 token 值离开过页面。于是在这套部署上，JWT 的 `exp` 就是真正的过期时间，而这个端点在它之前与之后都不签发新的一枚。那两个续期字段因此在那里保持不配置，那个控制台保留它本来就有的「余量→登录页」那条路。本功能面向的，是端点会答一个更晚 `exp` 的部署。

### 交出 token

有三处决定会前往登录页：启动时没找到可用 token、另一个标签页删掉了 token 或让它过期、以及没能被续期接住的过期余量。三者跑的是同一套三步，顺序固定。

在这三步的第一步之前，正在运行的闸门先把自己释放掉：存储订阅、过期余量、周期性续期全部停下，仍在途中的续期被中止。没有这一步，决定作出时已经出队的周期性计时器会在跳转过程中接着续期，把 token 写回存储、写回镜像 cookie、也写回 node 半边——写给一个刚刚把它交出去的访客。

还有第四处决定会以同样的方式释放闸门，但并不前往登录页：`sub` 不同的一次 `storage` 变化会 reload 这个页面，而仍在途中的、属于上一个账号的续期，否则就会在浏览器拆掉这份文档期间落地，把那个账号的 token 写进同样那三处，让即将载入的文档以它启动。

1. **`POST /auth-gate/logout`**，让 node 半边不再花一枚访客已经没有的凭据。请求带 `keepalive`，否则第 3 步的跳转会把这个由文档持有的请求取消掉。
2. **清掉镜像 cookie**，用与写入镜像时逐字相同的 `Path`、`Secure`、`SameSite`——浏览器是按名字、路径和域来把一次删除对应到已有 cookie 的，任何一项不同都会写出第二枚空 cookie，而把 token 原样留在那里。一枚在这里活下来的死 token，会继续在登录页自己发出的每一个请求上呈给立在本进程前的反向代理。
3. **跳转到登录页**，并把返回地址里的 `token` 与 `token4a` 去掉——查询串里的和片段里的一并去掉。这两个正是部署方登录页读取凭据的参数；把其中之一交回去，等于把闸门刚刚拒绝掉的那枚 token 经由浏览器历史、以及登录页发出的每一个 referrer 又送了回去。片段也要剥，是因为那个页面读参数读的是整个地址而不是它的查询串——toy-core 的 `getUrlParam` 解析的是 `location.href` 里第一个 `?` 之后的全部内容——所以只去掉查询串里的那一枚，反而会把挡着片段那一枚的 `?` 一起拿走，把它露出来。片段自己的路由和其余参数都保留：这些页面是 hash 路由的，片段就是地址。

这个顺序成立与否，取决于浏览器在什么时刻附上 cookie。第 1 步的请求经由同一个反向代理抵达本进程，而代理正是靠第 2 步随即删掉的那枚镜像 cookie 来路由它的；这一序列之所以成立，是因为浏览器在 fetch 发起的时刻就附上 cookie，Chromium 便是如此。若某个浏览器改在发送时才读，它就会一枚都不带，代理会拒掉这次登出，唯一的痕迹是控制台里的一条 warn，而 node 半边会继续持有那枚 token 直到进程结束。

<a id="routes"></a>
## 路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/auth-gate/settings` | GET、HEAD | browser 半边必须遵守的那些配置值，配置了续期端点时也含它。`no-store`：浏览器每次启动读一次，值来自它启动时那一行。 |
| `/auth-gate/token` | POST | 接收浏览器找到的 token；开了 `perMember` 时，记在这个请求被放进来时的那位成员名下。以 204 且无正文作答。 |
| `/auth-gate/logout` | POST | 丢掉持有的 token；开了 `perMember` 时，只丢发送者自己的那一枚。以 204 且无正文作答。 |
| `/auth-gate/mcp/<name>` | 任意 | 转发到 `<name>` 下配置的上游，并带上持有的 token。开了 `perMember` 时不认领。 |

token 路由只接同站点、只收 JSON：被浏览器标为 `sec-fetch-site: cross-site` 的请求以 403 拒绝，未声明 `application/json` 的以 415 拒绝，两者都发生在读取正文之前，于是跨源页面无法把一枚 token 作为免预检的简单请求发出来。正文不是一份 `token` 字段为三段式 JWT 的 JSON 文档时以 400 拒绝，而且两种拒绝都不会引用被投递的内容——一条点名了「差一点就对」的凭据的诊断，会把它送到任何读这份响应的地方。开了 `perMember` 时，这条路由还会在读正文之前先认出发送者，并在读完之后比对 token 的声明；先后次序以及 503、401、409 这几种答复见[按控制台成员持有 token](#holding-one-token-per-console-member)，其中没有一种会引用 token、成员主体键或身份头的值。

登出路由带着这道栅栏的两层，并且完全不读正文：它不点名任何 token，只是丢掉替发送者持有的那一枚——在整个进程一枚 token 的模式下，那是本进程所服务的唯一一位访客的；开了 `perMember` 时，是这个请求被放进来时的那位成员的。一个能够到达它的跨源页面，就能把这位访客从他正在使用的部署里登出去，而只有同站这一层是拦不住的——完全不带 `sec-fetch-site` 头的请求就能通过那一项检查，所以真正把这条路由从「免预检的简单请求」集合里撤出来的是 `application/json` 这项要求。browser 半边会声明这个 content type，且不发送任何正文。

token 被放在插件内部的一个闭包里——一个槽，或每位成员一项——且不写去任何地方：没有会话事件、没有设置文档、没有日志行、没有诊断。没有任何一条路由能把它读回来，而会改动它的路由，要么把它换成更新的一枚，要么把它丢掉。本包之外唯一的读者，是部署方用 `shareWithMemberDirectory` 借给成员目录的那一个。

<a id="forwarding-mcp-requests-with-the-token"></a>
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

这个 `url` 里的端口必须是本进程自己监听的端口：这条路由是本进程的，而一个被照抄的字面量会把每位访客的 MCP 调用都指向占着那个端口的那个进程——也就是指向另一个人持有的 token。一位登录用户一个进程的部署要从环境里取它（`` url: !!js `http://127.0.0.1:${process.env.DSH_PORT}/auth-gate/mcp/crm` ``），而不是写死一个数字。

转发骑在 dsh webserver 自己的路由注册表上，而不是自管一个监听。它的 `WebRoute` handler 拥有完整的响应生命周期，而这正是一次 MCP streamable-HTTP 交换所需要的：一次 POST 以 JSON 文档或一条挂住的事件流作答，一次 GET 为服务器到客户端的流长期挂住。两个方向都按字节中继而不解码，因此事件流是增量抵达 MCP 客户端的。

这次转发改动了什么，以及仅此而已：

- **`Authorization` 换成持有的 token。** 调用方自带的凭据是被替换而非透传的，因此没有东西能把凭据夹带过闸。
- **`Cookie` 被丢弃。** 镜像携带的正是同一枚 token，而上游没有理由收到浏览器的 cookie jar。
- **逐跳头与 `Host` 双向丢弃**；传输层发出的其余一切原样存活。
- **路由前缀之后的路径与 query string 会被带上**，接到目标自己的路径之后。

在还没有任何浏览器投递过 token 之前，每条转发路由都以 503 作答并点名该上游——对于一枚进程尚未持有的凭据，这是诚实的答复。上游不可达是 502；答到一半掉线的，响应被截断，因为状态码已经发出去了。

开了 `perMember` 的行一条转发路由都不认领，并在加载时拒绝非空的 `mcpUpstreams`：转发请求来自本进程里的 MCP 客户端，它的请求头在它那一行加载时就定死了，所以它点不出是哪位成员，也就没有谁的 token 可带。

<a id="reading-the-deployments-data-backend"></a>
## 读这套部署自己的数据后端

签发 token 的那套部署，同时也在供自己的数据。`bizUpstream` 把这些请求所构建于的基址交给本进程，闸门在它之上构造出 [`dsh-experimental-biz-backend`](../biz-backend/README.zh.md) 的 `ctx.bizBackend`，用的是它已经持有的那枚 token。那个包拥有这些读取本身、它们放到线上的东西，以及每种答复如何被归类。

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    loginUrl: /toy-proxy/toy-login/#/
    cookieName: accessToken
    refreshMarginSeconds: 300
    mcpUpstreams: {}
    bizUpstream: https://<host>/ini-server/
```

`bizUpstream` 必须是绝对的 `http(s)` 地址，不带 query string、不带 fragment、不带它自己的凭据，路径以 `/` 结尾。这段路径就是这套部署的 API 前缀，也就是前端自己的 `VUE_APP_BASE_URL`：标准安装编译出的是 `/ini-server/`，而不带前缀编译的安装则发布在源站根上。没有默认值。留空即表示这套部署不提供数据后端，于是 `bizBackend` 根本不构造，消费它的那一行会明确挂起并被点名缺哪个服务——而不是安装一个每次读都失败的服务。

`bizOperationRules` 是那个服务判定当前登录者可以对每个数据模型做什么的依据，每个操作一条规则——`read`、`metadata_read`、`create`、`update`、`delete`、`import`、`export`——要么是 `row`，意思是权限表里有这个模型的一行即可，要么是权限表自己的标志名列表，那一行必须至少授予其中一个。每个字段缺省都是这套部署后端今天实际校验的规则，所以部署只写自己要改的那几条，例如后端开始校验导出之后写 `export: [exp]`。两种写法都不是的规则、以及不对应任何操作的键，都会让这一行在加载时失败。规则表本身以及每条缺省的含义归 [`dsh-experimental-biz-backend`](../biz-backend/README.zh.md) 所有。

token 抵达这些读取的方式与抵达转发的方式相同：按引用，就是本包持有它的那个闭包。交给服务的是架在这个闭包上的解析器。整个进程一枚 token 时，不论一次读取点名哪个主体——工具调用所在的会话，或者路由收到的请求被放进来时的那个人——都解析到这一枚 token，路由问到的每个请求也都点名本进程服务的那一个人；开了 `perMember` 时，每个主体解析到它自己那位成员的槽，见[按控制台成员持有 token](#holding-one-token-per-console-member)。这些读取把 token 花在 `Authorization` 与 `CertificationToken` 两个头上，并在后端拒绝它时通过同一个槽交出它——那正是本包自己的登出终态，也是下面那些限制所记录的东西。

<a id="holding-one-token-per-console-member"></a>
## 按控制台成员持有 token

默认情况下，node 半边为整个进程持有一枚 token：任何浏览器投递过的最新一枚。`perMember` 面向另一种部署形态：一个 dsh 进程同时服务多位控制台成员。这时 node 半边按成员各持一枚，只放在内存里，每一枚只替它自己的那位成员花。

一个请求属于哪位成员，不由本包判定。部署方的登录门核验每位访客的 token，删掉客户端自带的成员头，再往它放行的每个请求里注入一枚现签的成员身份断言；`consoleMembers` 服务（`@deepseek-ai/dsh-experimental-console-members`）先跑连接自己的准入，再核验这枚断言，然后回答 `principalOfRequest(req)`。本包只问这一个问题，此外什么也不做：它不读任何身份头，也不自己调 `connection.admit`。一个会话属于哪位成员，同样由这个服务的 `principalOfSession(sessionId)` 回答：子会话、孙会话归它的最上层会话所属的那位成员，链上有任何一层认不出的，就归不到任何人。

一次 token 投递按这个顺序走：方法、同站、JSON 三道栅栏；没有 `consoleMembers` 服务在跑，或者那个服务拒收下文所说的读取器时，答 503；服务认不出这个请求是谁的时，答 401——发生在读正文之前，所以认不出是谁的请求，它的 token 根本不会被解析；正文里没有 JWT 时答 400，与默认模式相同；token 的 `principalClaim` 声明缺失，或者点名的成员不是这个请求被放进来时的那位，答 409。只有走到这里，token 才会记在那位成员名下，路由答 204。409 什么也不改变：它防的是账号切换时还在途中的那次投递把一位成员的 token 存到另一位名下。这枚声明不经验签就读出，规则与部署方签名代理读同一枚声明时所用的相同：字符串照原样，JSON 数字按它的源码数字串，于是 19 位的 `login_uid` 不会被舍入成另一位成员的，空字符串视为没有声明。登出走同样的栅栏，没有服务时答 503，认不出是谁时答 401，只丢发送者自己的那一枚。

每一次数据后端读取都经同一个服务解析：主体是成员的，解析到那位成员的槽；主体是会话的，解析到 `principalOfSession` 点名的那位成员的槽。服务归不到任何人的主体，以及没有服务在跑时的每一个主体，都解析不到任何槽，于是这次读取答 `unauthenticated`，什么也不发出去；不会拿别的成员的 token，也不会拿替整个进程持有的 token 顶替。后端拒绝时，丢掉的是这次读取解析到的那个槽，也就是那一位成员的。组合加载完毕后若仍没有 `consoleMembers` 服务在跑，这一行写一条 error 日志，点名缺的是哪个服务。

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    loginUrl: /toy-proxy/toy-login/#/
    cookieName: accessToken
    refreshMarginSeconds: 300
    mcpUpstreams: {}
    bizUpstream: https://<host>/ini-server/
    perMember: true
    principalClaim: login_uid
    shareWithMemberDirectory: true
```

`perMember` 打开时 `principalClaim` 必填——toy-core 部署写 `login_uid`——而 `mcpUpstreams` 必须为空，因为转发的 MCP 请求来自本进程里的 MCP 客户端，点不出是哪位成员。`shareWithMemberDirectory` 把按成员持有的 token 的读取器借给 `consoleMembers` 服务，没有 `perMember` 时在加载时被拒。两个布尔字段缺省都是 false。三个字段都没有声明为 volatile，所以任何设置写入都碰不到它们：设置服务只改 volatile 字段，对一个都没声明的行直接拒绝。

### 打开 `shareWithMemberDirectory` 之后谁读得到 token

不打开时，本包之外没有任何东西读得到持有的 token：数据后端经本包交给它的解析器拿到槽，而没有任何路由会把 token 读回去。打开之后，每当一个 `consoleMembers` 服务启动，本包就经这个服务的 `attachCustomerCredentials` 借给它一个读取器。读取器一次读一位成员的 token，并在某位成员的 token 被设置或丢弃时通知；它没有办法列出替哪些成员持有 token。这个服务，以及它把 token 交给的每个组件——在加入了组织的控制台里，就是把客户 token 换成组织 token 的那个凭据来源——都读得到任何一位成员的 token。读取器不注册到任何上下文上，因为上下文上的服务，进程里每个插件都读得到。

只有持有的内容真的变了才通知：投递一位成员已经持有的那一枚，不通知；丢掉一位并未持有 token 的成员，也不通知。抛错的订阅者会以一行固定文字记入日志，既挡不住这次变化，也挡不住排在它后面的订阅者。服务停下，或者这一行被释放时，读取器被收回并作废：此后它什么也读不到，它的订阅全部结束，下一个服务拿到的是一个新的读取器。拒收读取器的服务——它只收一个，第二次就抛错——会以一行 error 日志记下，token 路由一直答 503，直到一个肯收的服务启动。

-----

<a id="composition"></a>
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

每一个配置值都在加载时校验，且除 `bizUpstream`、`bizOperationRules`、`renewalPath`、`renewalIntervalSeconds` 与三个按成员持有的字段之外都是必填：空的 `loginUrl`、已经带了 query string 的 `loginUrl`、不是纯 cookie 名的 `cookieName`、不是纯路由段的上游名、不是「无 query 无 fragment 的绝对 HTTP(S) URL」的目标，以及不可用的 `bizUpstream`，都会让这一行失败，而不是变成「跳去一个不存在的地方」「首次调用才失败的工具」或「把凭据发去错误的地址」。被拒的地址在回显时会去掉写在里面的用户名与口令，而 URL 解析器根本读不动的值则一个字都不回显——这样的值可能带着这里任何检查都认不出的口令，而加载失败会被这一行输出所到之处读到。按成员持有的那三个字段在[按控制台成员持有 token](#holding-one-token-per-console-member)列出的那几种组合下被拒，拒绝只点字段名。

续期那两个字段只填一半会被拒，路径不是本部署自己源上的路径也会被拒：只有间隔没有路径，是一个自以为在续期、实则没有的部署；只有路径没有间隔，则按不存在的排期续期；而指向别的源的路径——包括看不出在指向别的源的协议相对写法 `//host/path`——会把这位访客的凭据发出本部署之外。间隔为零同样会被拒，超过 2147483 秒的间隔也一样——那正好是单个浏览器计时器拿得住的长度：闸门躲不开的更长的等待会被拆成这么长的几段睡过去（过期余量的延时就是 token 的 `exp`），但那么长的间隔是没有哪个部署会真心写下的数字，它说的是一条 24 天后才第一次触发的排期，而这个闸门接受的 token 没有一枚活得到那时候。browser 半边对收到的那份文档会把这三件事再查一遍，因为那份文档跨过了一个进程。

`loginUrl` 是浏览器侧地址，按写就发出：挂在路径前缀下的部署要把前缀写进这个值（`/console/toy-proxy/toy-login/#/`），因为没有任何一处会拿部署基址再解析它一次。登录页留在外壳前缀之外（就像上面的样例）同样成立，只是拿不到镜像 cookie —— 那枚 cookie 的作用域就是这段前缀。

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or result: it carries a credential between the browser, the process, and the MCP servers the process forwards to, all of which happens outside any model request, and the tools those servers publish are `dsh-mcp-client`'s model-facing contribution rather than this package's.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated; whether an MCP server's tool list moves between requests is that server's behavior under `dsh-mcp-client`'s contract.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **这道闸不会先于外壳其余部分运行。** 浏览器侧的行是一起创建的，各自等自己的服务，因此未登录的访客可能在跳转发生前先看到外壳画出来。`dsh.client.immediately` 让这一行的 bundle 字节在第一梯队被取回，缩短了这个窗口，但并不排序激活；只有 client runtime 里的一道启动阶段缝才能关掉它。
- **没有配置 `renewalPath` 的部署，仍会在余量上把访客登出。** 续期按部署逐个选择开启，因为端点在哪里是各部署自己的事，没有可猜的余地；没有它，即便背后的单点登录本可以静默签发一枚新的，token 用完仍要付一次完整跑登录页的代价。
- **每个打开的标签页各续各的。** 闸门没有选主，也没有锁，于是同一个控制台的两个标签页各自每 `renewalIntervalSeconds` 向端点要一次，各自写下要到的那枚。它们最终会一致——没去要的那个标签页会把另一个的写入当成同一个人的 `storage` 变化，走既有的那条路取走更新的一枚——但部署方看到的是每个标签页一次交互而不是每个人一次，而两份答复交错时以最后一次写入为准。要关掉它，就得让闸门去取一把锁（Web Locks API 是最直白的那一把），并由一个标签页代其余标签页续期。
- **周期性续期失败什么也不说。** 屏幕上没有，控制台里没有，node 半边也没有：一个续期端点已经拒了几个钟头的部署，看上去与没拒过的一模一样，直到过期余量到来、访客被送去登录页。另一种做法——把下一次滴答很可能就能挽回的一次尝试报出来——会在每一次瞬时失败上都变成噪声。
- **本包所面向的那套部署不签发新 token，续期在那里因此是空转。** 它给出的每一份答复带回来的都是发出去的那一枚，包括在 `exp` 之前 2.3 分钟要的那一次；而 `exp` 之后 100 秒，那个端点与一次元数据读取都答 401：它的 JWT `exp` 就是真正的过期时间。那两个字段在那个控制台上保持不配置，于是它保留本来就有的「余量→登录页」那条路，本包给它的东西不比旧行为多。这里每一个测试的答复都来自假端点；要看到续期端到端地跑起来，需要的是一个端点会答更晚 `exp` 的部署。
- **设了 `isAuth` 的部署根本进不了这道闸。** `getLocalConfig().isAuth` 为真时，`toy-core` 会把所有 token 键换成 `accessTokenAuth` 与 `accessTokenTimeAuth`，而本包两个半边都只认默认的那两个键名。在这样的部署下，闸门读的是那个部署的登录页从不写入的键，于是访客被送去登录页、登录、再被送去一次；键名无从配置，这处不匹配也没有任何东西会报出来。
- **转发只走 HTTP。** 没有 upgrade 路由，因此以 WebSocket 抵达的 MCP 服务器无法经它转发；这条路由服务的是 streamable-HTTP 及其事件流。
- **默认整个进程只有一枚 token。** 不设 `perMember` 时，node 半边持有任何浏览器投递过的最新一枚。这与一位登录用户一个进程的部署形态相符，而对于多人共用一个进程的场景则是错的：那时最后加载页面的那个浏览器会决定每一次读取和 MCP 调用花谁的凭据；`perMember` 就是那种部署该用的模式。
- **按成员持有时没有 MCP 转发。** `perMember` 在加载时拒绝 `mcpUpstreams`，因为 `dsh-mcp-client` 在它那一行加载时就把请求头定死了，它发出的请求点不出是哪位成员。按成员持有的控制台经 `dsh-experimental-console-mcp` 连它的 MCP 服务器，用的是那一行配置的服务凭据，所以 MCP 工具做的写入——iot 写入也在其中——记在那个服务账号名下，而不是提出请求的那位成员名下。
- **`Context.consoleMembers` 暂时在这里声明。** `src/member-directory.ts` 声明了这个服务，以及本包调用的它的三个成员，签名照抄 `@deepseek-ai/dsh-experimental-console-members`，而那个包还没进这条线。它进来之后，这段声明删掉，类型改从那个包导入；在那之前，成员目录的签名一改，本包的构建发现不了。
- **缺成员目录的那条 error 要等 Loader。** Cordis 没有宿主就绪事件，所以那一行 error 在加载这一行的 Loader 树安定下来时才写。没有 Loader、手工应用的行一行也不写；成员目录事后停掉，只表现为路由答 503。
- **只有闸门自己那三处登录决定会登出。** `POST /auth-gate/logout` 会丢掉持有的 token，而调用它的只有 browser 半边的启动、storage 变化与过期这三条路径——没有登出控件，也不会打断此刻正在跑的 agent loop。访客若是直接关掉标签页，进程就会继续持有那枚 token，直到进程结束，或另一个浏览器投递了更新的一枚。
- **不带 token 的访客也会登出一次。** 启动决定无论存过东西与否都走这个出口——这是有意的，因为 node 半边可能仍持着上一位加载过页面的访客的 token——而在反向代理后面，这次请求不带镜像 cookie、被答以 401，只在控制台留下一条无害的 warn。
- **一次撤销不会被撤回。** browser 半边只在一个地方把 token 交给 node 半边——那次让页面跑起来的启动决定或 storage 变化决定——因此一次在页面仍在运行时抵达的登出，会让这个页面的 MCP 转发一直答 503 直到它重新加载，而屏幕上没有任何提示。有两种情况会走到那里：一次晚到的登出请求丢掉了它之后才被投递的那一枚 token，以及一个越过了这条路由栅栏的跨源页面。要关掉它，要么在请求里点名要丢的那一枚 token，让晚到的那次撞不到更新的凭据，要么在页面重新可见时把当前这一枚再投递一次。
- **一枚被拒的 token 不构成离开的理由。** browser 半边只按形状与过期判断——让它离开的，是「存着的值不是一枚 `exp` 仍在未来的 JWT」——所以一枚仍未过期、却被外层闸拒绝的 token（被吊销、密钥已轮换、账号已停用），在这里读起来是可用的。外壳照画，它背后每一个被拦的调用都失败，而没有任何东西把访客送去别处；本包自己的出口只有那张过期时间表，而它是在 `exp` 之前的那个边界上触发，不是在拒绝开始时。把本包自己的调用被答 401 也当成第四条离开的理由，是缺掉的那一半，它该放在 `src/client/run.ts` 里已有的那三处决定旁边。
- **退出的次序假定镜像 cookie 仍能打开代理。** 第 1 步那次 POST 只有在反向代理还接受它所带的那枚 cookie 时才到得了本进程；而一个会校验这枚 cookie、而不只是拿它路由的代理——比如 `dsh-experimental-server-base` 的 nginx 样例里那道向部署方认证服务发问的站点闸——恰恰会在「交还的正是它不接受的那枚 token」的路径上拒绝这次 POST：一枚已过 `exp`，一枚未过期却被上游拒绝。node 半边于是攥着这枚死 token，直到进程结束或有更新的一枚被投递进来。第 2、3 步无论如何都会执行，所以访客本人照样走得掉；留下的残余在进程侧。
- **一次被后端拒掉的读，会连带停掉 MCP 转发。** 数据后端答 HTTP 401 或 403 时，进程交出这次读取花的那枚 token，那正是登出路由的终态。整个进程一枚 token 时，此后每条转发路由都答 503、每次读都答 `unauthenticated`——直到某个浏览器投递一枚新的——因此一次读的失败是进程范围的，而不是只属于那一次读。开了 `perMember` 时，它只属于那一位成员。
- **进程于是知道了页面不知道的事。** node 半边是这个进程里第一个知道「手上这枚 token 被拒了」的地方，而它没有任何通道告诉浏览器：那个页面照旧跑到自己的过期计划触发为止。要闭掉它，就得在 `src/client/run.ts` 已有的三条离场判据旁边加第四条——最便宜的形态是：凭据刚以「被后端拒」丢掉之后，token 路由答 409。
- **凭据是因为什么被丢掉的，今天没有读者。** `HeldCredential.drop` 收 `'sign-out'` 或 `'refused-by-backend'`，两个调用点都传了真实的那个，而两者抵达同一个终态；闭包一个都不读。这个形参是为上面那条离场判据留的——它的 409 答复必须分得清这两者——在那条落地之前它没有读者。
- **`Bearer ` 是我们加回去的。** 闸门持有的是裸 JWT，两个数据后端请求头的 scheme 都由我们重新加上，前提是这套部署的登录页存的是 `"Bearer <jwt>"`——`src/client/browser.ts` 写明的那条契约。存裸 JWT 的部署，收到的头会比它自己的页面多一个 scheme。
- **设置路由假定存在 HTTP 载体。** browser 半边 fetch `/auth-gate/settings`——node 半边注册的那条根绝对路由，按页面的部署基址解析而来——因此一个「提供外壳但不经 HTTP 暴露 harness」的传输会让这一行失败。
- **不被任何组装快照覆盖** —— 浏览器侧的证据是 `apps/web/tests/auth-gate.e2e.ts` 里那个针对真实组合的 Playwright 场景，续期也在其中；快照通道回放的是已发布组合，而它不组合实验性行。也没有哪个已发布 profile 设 `perMember`；按成员持有由 `tests/per-member.client.spec.ts` 里经 Loader 的组合测试覆盖，用的是一个测试专用的成员目录行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
