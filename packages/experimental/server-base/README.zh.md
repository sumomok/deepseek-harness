---
description: "在部署声明宿主归属时往外壳首页注入一个声明 `ownsHost` 的 `__DSH_TRANSPORT__` 载体，告诉浏览器够得着这个被服务出去的 dsh 页面是否意味着拥有它背后的宿主；同时携带把控制台发布在路径前缀下、挂在登录闸后面的 nginx 样例，以及为 dsh 收到的成员身份断言签名的登录闸代理与核验器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-server-base

[English](README.md) | 中文

## 概述

告诉浏览器：够得着这个被服务出去的页面，是否意味着拥有它背后的宿主。客户端只凭页面的 authority 判断这件事，而任何不是回环的 authority 都被读成别人的宿主——那恰恰是本包为之存在的那种部署：一个发布在公网域名上、由前面的代理决定谁够得着它的控制台。

## 目录

- [它注入什么](#what-it-injects)
- [配置](#configuration)
- [声明宿主归属](#claiming-the-host)
- [组合方式](#composition)
- [代理那一半](#the-proxy-half)
- [部署代理与核验器](#deploy-proxy)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-injects"></a>
## 它注入什么

它为一种拿不到独立域名的部署而存在：一个域名后面并列着若干产品，dsh 是其中之一，彼此靠路径区分。前缀本身不需要本包做任何事——被服务出去的 index 带着 `<base href="./">`，于是在剥离前缀的代理后面加载的页面，会把自己构造的每一个 URL 都留在那个挂载点之下——[代理那一半](#the-proxy-half)是配套的 nginx 样例。

在 `webserver/index-inject` 上注入一行，且仅当 `ownsHost` 被设上时才有：`<script>globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };</script>`。`__DSH_TRANSPORT__` 是 `client-connection` 在自己插件启动时只读一次的那个载体，被服务出去的页面通常不设它；真会设它的是那种自带物理传输的外壳——worker 预览，它的宿主就跑在它自己派生的 worker 里——所以这一行用 `??=` 赋值，而不是盖过去。这一行放进去的载体根本不是传输：它的 `fetch` 就是页面自己的 `fetch`，与那个插件在全局量缺席时所用的调用方完全相同；它既不声明 `openStream` 也不声明 `loadBundle`，于是 RPC 照旧走 HTTP 请求与 Gateway WebSocket，插件 bundle 也照旧走 HTTP 加载。`ownsHost` 是它携带的唯一一项事实。

监听器以 `prepend` 注册，所以这一行渲染在每一个文档脚本之前，也在更早注册的监听器所贡献的行之前。

<a id="configuration"></a>
## 配置

`ownsHost` 是一个布尔量，部署不写它就是 `false`；写成别的类型会让这一行失败，而不是按真假值去读。不写它，这一行什么都不贡献，被服务出去的 index 就是静态产物服务器自己的那份。

<a id="claiming-the-host"></a>
## 声明宿主归属

客户端把自己的一部分界面留给操作者自己的机器，而它判断谁是操作者只看页面的 authority：`ctx.connection.isLoopback`。不在回环上时，设置跑在一个进程内的镜像上，而这个镜像对每一次读都答 `unavailable`——于是每一个设置分区（MCP 服务器那一节也在内）都说自己读不到设置——设置文档的那些动作不出现，产物文件的小标签也不再提供“在宿主上打开这个路径”。

`ownsHost` 说的是：对这套部署而言那个判断是错的，够得着这个被服务出去的页面的人就是这台宿主的操作者。这项事实没有别处可取，因为 authority 本来就是公网的一个，而页面分辨不出面前是一道闸还是一扇敞着的门。

**它声明的是页面前面那道闸，而不是访客本人。** 只有当页面前面确实有东西在决定谁够得着它时才设它——这套部署把 dsh 浏览器会话 cookie 与代理那道 `auth_request` 登录闸配在一起，见[代理那一半](#the-proxy-half)——因为凡是被它们放行的访客都会拿到那片界面，而他们共用背后这一台宿主。这片界面里有一处伸到了浏览器之外：设置文档的那个动作会让宿主把自己的设置文件落到磁盘、再用一个本地文本编辑器打开它，放在一台无头的控制台上，那就是在服务器上拉起一个编辑器进程。

**它不挪动任何服务端检查。** `/api` 浏览器信任栅栏照旧拒绝任何既非回环、又未在 `client-connection` 的 `trustedHosts` 里声明的 Host；而客户端现在要调用的那些设置 RPC，本来就会回答任何被这套部署放行的调用方：它从不按页面 authority 设闸。变的是客户端提供哪片界面，而不是宿主会为一个已经抵达的请求做什么。

<a id="composition"></a>
## 组合方式

本包不在任何发布 bundle 里。部署把这一行插到任意界面之上：

```yaml
- insert:
    - id: server-base
      name: '@deepseek-ai/dsh-experimental-server-base'
      config:
        ownsHost: true
```

在普通界面之上，用 `dsh --profile web --patch <path>` 应用。客户控制台不同：它由 [`@deepseek-ai/dsh-experimental-console-profile`](../console-profile/README.zh.md) bundle 加上部署自己的一个部署 bundle 组成，这一行放进那个部署 bundle。用 `--patch` 组装的控制台存不下侧栏菜单，因为 settings 服务把菜单写进 profile 补丁，而对由该补丁之上的层组合的行，config-editor 会拒绝写入。每个包都必须能从 profile 目录解析到，对仓外插件而言这意味着 `dsh plugin --profile web add <path>` 或等价的链接——发布 bundle 不得声明实验性包。只在[声明宿主归属](#claiming-the-host)所述条件下设 `ownsHost`。

<a id="the-proxy-half"></a>
## 代理那一半

`deploy/nginx.console.conf` 是配套的反向代理样例：`location /console/` 与 `proxy_pass http://127.0.0.1:3080/`，两处的尾斜杠正是执行剥离的部分；`Host` 原样透传；两条事件套接字所需的 WebSocket 升级头；以及为流式回答关掉的缓冲。它是为一台不含 `ngx_http_rewrite_module`、但编进了 `ngx_http_auth_request_module` 的 nginx 写的，因此不用 `rewrite`、`return`、`if`、`set`，并且只发布带尾斜杠的那种前缀写法：那里没有任何手段能把 `/console` 重定向到 `/console/`，而在不带尾斜杠的地址上服务出去的文档落在 `Path=/console/` 之外——页面正是用这个 path 写镜像 cookie 的，浏览器于是一个 cookie 都不会带回来。所有对外发布的链接都带尾斜杠。

dsh 不认证任何人，所以那份样例同时承担了这套部署唯一的认证：一道 `auth_request` 闸只在 `/console/` location 上声明一次，再在它下面逐个地址取消。于是它默认拒绝——`/console/api` 连同两条事件套接字、任何被组合进来的插件所注册的路由、以及内容应用，全都无需被点名就已被拦住；而只把闸挂在入口上，会把 RPC 上行敞着。样例真正放开的是启动引导，而且非放不可：一次导航所能携带的凭据，就是 auth-gate 把 token 镜像进去的那枚 cookie，而写出这枚 cookie 的只有控制台自己的页面。若把文档也一并拦住，这道闸与它唯一的凭据就互为前提：一个 cookie 罐为空的访客——第一次访问、换了浏览器、清了站点数据，或者刚被退出按钮清掉这枚 cookie——会恰好在那张本可以写出它的页面上被拒之门外，此后再无回路。因此，外壳文档、它引用的那几个文件、客户端插件 bundle、闸自己的 `/auth-gate/settings` 文档，以及 component-kit 的 `/component-kit/settings` 文档，对任何人都照常服务。这样公开出去的是构建产物，外加关于这套部署的三项事实——外壳文档携带的已组合插件清单与已存的主题偏好、auth-gate 设置文档里的三个配置值，以及 component-kit 设置文档里数据页的请求前缀（它的浏览器半边在外壳启动时读一次）——不含任何对话、会话或工作区内容。页内那道闸（它要去的登录页本身也必须留在这道闸之外可达）只按形状与过期判断：存着的值只要不是一枚 `exp` 仍在未来的 JWT，就把访客送去登录页，此外再没有别的会触发它。证明这一半成立的检查，在这份清单变动时重跑：cookie 罐为空时，`GET /console/` 答 200 与外壳文档，而 `GET /console/api/anything` 答 401 与那张固定页。

nginx 与它的核验器都不在本地校验 token。nginx 把每个被拦请求的凭据放进一次鉴权子请求，交给核验器——以核验模式运行的 `deploy/proxy.mjs`，见[部署代理与核验器](#deploy-proxy)——核验器去问部署方自己的认证服务，放行答 200，拒绝答 401，认证服务答不上来时答 503，于是过期、轮换、吊销都留在签发 token 的那一方。凭据在外围产品的页面发来 `Authorization` 头时取自该头，否则取自那枚镜像 cookie——每一个资源、每个 iframe、两次 WebSocket 握手都带不了头，正是靠它覆盖。样例里的 cookie 名必须与那条 auth-gate 行的 `cookieName` 写法一致；写成别的就读到空 cookie，把控制台对所有人关上。nginx 不缓存任何回答：核验器把判定在内存里记 `AUTH_CACHE_SECONDS` 秒，这也是一枚被吊销的 token 最长还能用多久，并且每个 200 都现签，于是没有成员断言被重放，也没有 token 被写进缓存文件。`/console/` 块转发核验器返回的 `X-Dsh-Member` 值，这个名字下不转发别的任何东西；豁免 location 以空值继承这一行，因此不转发这个头。被拒时服务的是部署方提供的一张固定页，而不是跳转：那里没有任何手段能跳转，而 `/api` 与 WebSocket 请求要的本来就是一个状态码，不是一份登录文档。从核验器到认证服务的那一跳承载着整套部署唯一的认证判定，所以 https 的 `AUTH_ORIGIN` 会按 Node 自带的 CA 列表或 `AUTH_CA_FILE` 信任库校验证书；另一种受支持的形态是认证服务在私网上以明文 http 提供。核验器的 503，与任何既不是 200、也不是 401 或 403 的回答以及压根连不上的核验器一样，都会变成 500，由第二张固定页作答：说的是「服务暂时不可用」，而不是「请重新登录」。

这份样例只是部署的一半。`Host` 原样透传，正是为了让 `/api` 浏览器信任栅栏及其背后的 Origin 比对有东西可读；而该栅栏会拒绝任何既非回环、又未被声明的 Host——所以进程侧还必须在 `client-connection` 的 `trustedHosts` 里带上对外域名，声明在部署自己那一层 overlay 里。少了它，**进程**会对每一个 `/api` 请求答 403，而页面本身照常加载，且这次拒绝与 nginx 无关。

前缀没有剥干净同样不会表现为一个干净的 404：未剥净的路径会走出静态产物根目录，被路径穿越检查以 403 拒绝——那是与栅栏不同的另一种拒绝，同样不是权限问题。

不需要 `sub_filter`。被服务出去的 index 带着 `dsh-host-frontend-static` 写入的 `<base href="./">`，页面于是把自己构造的每一个 URL 都按它被加载时所在的目录解析，没有任何地方写出前缀留给 nginx 去改写；何况字节过滤器根本够不着真正要紧的那些 URL，因为运行时代码是用一些从不完整出现在响应里的字符串拼出它们的。

<a id="deploy-proxy"></a>
## 部署代理与核验器

`deploy/proxy.mjs` 是登录闸：前置代理跑不了 `auth_request` 的部署直接用它；跑得了的部署，`deploy/nginx.console.conf` 把它当核验器来问。它没有依赖，在 Node 22.19 及以上以 `node proxy.mjs` 运行，被 import 时什么都不启动。`PROXY_MODE=proxy` 是默认值，即同源反向代理：dsh 控制台自己的路径转给 `127.0.0.1` 上 `DSH_WEB_PORT` 端口的 dsh 进程，其余路径都转给 `REMOTE_HOST`、`REMOTE_PORT` 处的远端应用——控制台嵌入的客户系统；远端应用的路径从不设闸，因为它自己管登录。`PROXY_MODE=verify` 不转发任何请求，只回答 nginx 的每一次鉴权子请求：放行答 200，拒绝答 401，认证服务答不上来时答 503。

一次登录有效，要求认证服务接受了这一整枚 token，并且 token 指明了一位成员。代理模式下凭据取自镜像 cookie，核验模式下取自样例填好的 `Authorization` 头。闸门解出 token 的载荷但不校验签名——客户系统用对称密钥签名，闸门没有这把密钥——载荷里没有 `login_uid`、或者没通过已配置的 claims 核对的 token，不问认证服务就直接拒绝。随后它向 `AUTH_ORIGIN` 的 `AUTH_CHECK_PATH` 发 `GET`，凭据同时放在 `Authorization` 与 `CertificationToken` 两个头上。401 与 403 是拒绝；其他状态码、超时、超过 64 KiB 的答复体都算认证服务不可用。2xx 是放行；`AUTH_CHECK_REPLY=renewal` 时还要求答复的 `token` 字段与提交的那枚 token 有相同的 `login_uid` 和 `jti`，因为续期端点对一枚有效 token 的回答就是这同一枚 token。2xx 说明客户系统接受了这一整枚 token，所以它载荷里的 `login_uid` 就是这位成员。数字形式的 `login_uid` 保留每一位：闸门按源文本读 JSON 数字，这需要 Node 21 起提供的 `JSON.parse` 源文本访问，运行时不支持时闸门拒绝启动。放行连同成员一起在内存里缓存 `AUTH_CACHE_SECONDS` 秒，拒绝缓存 10 秒；同一凭据的并发核验共用一次请求；在途核验超过 64 个时，新的核验直接按不可用作答，而不是排队。

代理转发的每个请求和每次 WebSocket 升级，都会去掉客户端自带的 `x-dsh-member` 头，大小写不论，用下划线代替连字符的写法也算，dsh 路径、豁免路径、远端应用路径一视同仁。配置了签名私钥时，闸门核验过并转给 dsh 的每个请求还会带上一枚现签的成员断言，核验器则在每个 200 的 `X-Dsh-Member` 响应头里返回一枚；豁免路径、远端应用路径以及关掉的闸门都不带。值的格式是 `v1.<载荷>.<签名>`。`<载荷>` 是 JSON `{"p": "<login_uid>", "aud": "<MEMBER_ASSERTION_DEPLOYMENT_ID>", "exp": <Unix 秒>}` 的 base64url，其中 `p` 总是字符串，`exp` 是签发后 120 秒；`<签名>` 是对 ASCII 字符串 `v1.<载荷>` 的 Ed25519 签名，取 base64url。核验方只在签名能用部署的公钥验过、`aud` 等于它自己的部署 id、`exp` 尚未到来时才接受一枚断言。没有签名私钥时闸门只删头，单人部署照旧可用。dsh 本身忽略这个头；要分清成员，需要一个在宿主侧核验它的组件，这个组件还不在本仓库里。任何日志行都不带成员 id、断言或 token：拒绝只记原因类别和不含查询串的请求路径。

代理转发的每个请求体都由它自己分帧，于是一个请求体到达上游时只是它那一个请求的请求体，绝不会自成一个请求——那样的请求不过闸门核验，还带着它自己写的任何 `x-dsh-member`。客户端的 `Content-Length` 原样转发，分块的请求体重新按分块编码，两者都没有的请求不带请求体。同时带 `Content-Length` 和 `Transfer-Encoding`、或者 `Transfer-Encoding` 不是 `chunked` 的请求答 400 并关闭连接，发生在登录核验之前，也不联系任何上游；Node 解析器拒绝的报文在两种模式下都答 400。请求体还没发完就断开的客户端，它的上游请求会被丢弃。声明了请求体的 WebSocket 握手同样答 400。随后握手单独发往上游：只有答 101 才打开客户端到上游的方向，并把客户端在握手之后发来的字节转过去；其他答复原样转给客户端，不再向上游发任何东西；上游不答就关闭时报 502。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PROXY_MODE` | `proxy` | `proxy` 或 `verify`。 |
| `PROXY_HOST` | `127.0.0.1` | 监听地址。 |
| `PROXY_PORT` | `8082` | 监听端口。 |
| `DSH_WEB_PORT` | 代理模式下必填 | `127.0.0.1` 上 dsh 进程的端口。 |
| `REMOTE_HOST`、`REMOTE_PORT` | 代理模式下必填 | 远端应用的地址；IPv6 地址不加方括号。 |
| `LOGIN_GATE` | `on` | `off` 时不做登录核验，转发全部路径。 |
| `AUTH_ORIGIN` | `http://<REMOTE_HOST>:<REMOTE_PORT>`，IPv6 的 `REMOTE_HOST` 加方括号；核验模式下必填 | 认证服务的 origin，`http:` 或 `https:`，不带用户信息和路径。 |
| `AUTH_CA_FILE` | 不设，即信任 Node 自带的 CA 列表 | https 那一跳的证书必须链到的 CA 的 PEM 文件。 |
| `AUTH_CHECK_PATH` | `/nrms-auth/api/renewal` | 核验每枚凭据所用的路径。 |
| `AUTH_CHECK_REPLY` | `renewal` | `renewal` 还核对答复 token 的 `login_uid` 与 `jti`；`status` 只看状态码，用于不回传 token 的路径。 |
| `AUTH_COOKIE` | `accessToken` | 代理模式下读取的镜像 cookie，写法与 auth-gate 行的 `cookieName` 一致。 |
| `AUTH_CACHE_SECONDS` | `30` | 一次放行记多久，也就是一枚被吊销的 token 最长还能用多久。 |
| `EXPECTED_ISS` | 不设 | 设了时，token 的 `iss` 必须等于它。 |
| `ALLOWED_TENANTS` | 不设 | 逗号分隔；设了时，token 的 `tenants`（数组，或一个逗号分隔的字符串）必须列出其中之一。 |
| `ALLOWED_APP_IDS` | 不设 | 逗号分隔；设了时，token 的 `login_app_id` 必须是其中之一。 |
| `MEMBER_ASSERTION_KEY_FILE` | 不设 | PEM 格式 Ed25519 私钥的路径；设了时闸门为成员断言签名。 |
| `MEMBER_ASSERTION_DEPLOYMENT_ID` | 配了私钥时必填 | 断言的 `aud`。 |
| `DSH_LAUNCH_TOKEN_FILE` | 不设 | 存放 dsh 启动 token 的文件；代理模式下设了时，在 `/` 被 dsh 拒绝的访客会被送去走 dsh 自己的 token 交换。 |

任何一个值无效，或者出现下面这些组合时，启动就以 1 退出，并在消息里写出变量名：有私钥而没有部署 id、有部署 id 而没有私钥、有私钥而 `LOGIN_GATE=off`（只有核验过的登录才指明成员）、`PROXY_MODE=verify` 而 `LOGIN_GATE=off`、私钥不是 Ed25519、`AUTH_CA_FILE` 配的是 http origin、允许名单里一项都没有。拼不成 http origin 的 `REMOTE_HOST` 按 `REMOTE_HOST` 报错，`AUTH_ORIGIN` 由它推出时也一样。监听失败同样以 1 退出：端口被占用或无权使用时写出 `PROXY_PORT`，地址不是本机地址或解析不了时写出 `PROXY_HOST`。

断言用非对称签名，是为了让 dsh 宿主只持有公钥：以宿主的 OS 用户运行的代码——agent 的文件工具，或者能读出宿主可读的任意路径（`/proc/<pid>/environ` 也在内）的 `/api/file`——读到公钥也伪造不了任何东西。这只在私钥文件对 dsh 宿主的 OS 用户不可读时成立，也就是这道闸以单独的 OS 用户或在单独的容器里运行；环境变量里只放私钥的路径，从不放私钥本身。闸门与 dsh 以同一个 OS 用户跑在同一个容器里的部署——托管的控制台眼下就是这样——不满足这个前提：能在宿主上执行代码的人读得到私钥文件，也读得到这个进程的环境。两者分开之前，那里的防伪造只靠网络：dsh 在容器内只监听 `127.0.0.1`，只有这个容器里的进程连得到它；这道闸会替换掉客户端发来的任何同名头；控制台预设也不组合任何 shell 工具。

部署会不会转发客户端自带的这个头，可以从外面用 curl 加一个替身来查；替身只报告这个头有没有到，从不打印它的值。先停掉 dsh，在 dsh 的端口上运行 `node -e "require('http').createServer((q, s) => { const v = q.headers['x-dsh-member']; console.log(q.url, v === undefined ? 'absent' : v === 'forged' ? 'FORGED VALUE PASSED' : 'signed value'); s.end() }).listen(3080, '127.0.0.1')"`，再发 `curl -s -o /dev/null -H 'X-Dsh-Member: forged' https://console.example.com/console/assets/probe`：豁免 location 必须打印 `absent`。同样的请求发往一个带有效镜像 cookie（`-b 'accessToken=<token>'`）的被拦路径时，核验器签名的部署打印 `signed value`，不签名的打印 `absent`；任何路径上出现 `FORGED VALUE PASSED`，都说明这份配置会转发客户端的头。把同一个替身放在 `DSH_WEB_PORT` 上，就能查代理模式。

## Model Experience

None, as this package registers no tool, prompt section, or result: it contributes one index-injection row to the HTML a browser is served, which is decided and rendered outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **按 origin 隔离的浏览器存储会在多个前缀之间共享。** `localStorage` 与 `CacheStorage` 按 origin 隔离，从不按路径隔离，所以同一主机名下 `/a/` 与 `/b/` 两个部署会共享外壳的工作区视图、会话草稿以及页面镜像的任何 token，并互相覆盖。本包无从分开它们；需要分开的部署需要的是一个部署一个主机名。
- **前缀下不支持 PWA。** service worker 的作用域由脚本 URL 决定，web 应用清单的身份也是相对 origin 而非相对前缀解析的。server 线的 profile 不得组合任何 PWA 层；在前缀下组合它会装上一个声称管辖范围超出本部署所有权的 worker。
- **前缀只存在于浏览器侧。** 没有任何东西教给进程它自己的前缀：路由保持根绝对，代理必须剥离。剥不掉前缀的部署——代理必须原样转发前缀——需要让路由表、RPC 端点解析、api-proxy 的路径匹配器与特权方法栅栏一起认识前缀，那是另一项改动。
- **闸并不覆盖外壳自身。** 外壳文档、它引用的那几个文件、客户端插件 bundle 以及 `/auth-gate/settings`，对任何人的请求都照常服务：一次导航所能携带的唯一凭据，正是页内那道闸写出来的，把它们也拦住，就等于让一个 cookie 罐为空的访客无路可进。这样公开出去的是构建产物加三个配置值，而控制台会在访客身份确定之前就先画出来——那段窗口记在 auth-gate 自己的「已知限制」里。若某个部署不能把外壳交给匿名请求，它需要的是一道能自己签发凭据的闸，那是另一套登录方案。
- **一枚被拒但尚未过期的 token 会把访客困住。** 页内那道闸只按形状与过期判断——把访客送去登录页的，是「存着的值不是一枚 `exp` 仍在未来的 JWT」——所以一枚仍未过期、却被认证服务拒绝的 token（被吊销、密钥已轮换、账号已停用），在它看来是可用的，在站点闸那里却是拒绝。这样的访客照样拿到启动引导，控制台照样画出来，而它背后每一个被拦的请求都失败：导航到开放清单之外的地址会落到那张固定页，页面自己的调用则会一直失败，直到那枚 token 自己过期，或者访客按下退出。让页面在自己的调用被答 401 时去登录页，是缺掉的那一半，记在 [auth-gate](../auth-gate/README.zh.md) 的「已知限制」里。
- **退出不一定够得着进程。** auth-gate 的顺序是先 POST `/auth-gate/logout`，好让 node 半边不再花一枚访客已经没有的凭据，而这个请求带的正是这道闸如今要校验、而不只是拿来路由的那枚镜像 cookie。在交还的那枚 token 恰好被这道闸拒绝的路径上，nginx 会对这个 POST 答 401，进程于是继续攥着那枚死 token，直到进程结束或有更新的一枚被投递进来。访客本人照样能走掉，因为后面几步无论前一步结果如何都会执行。
- **这项归属声明分不出访客之间的差别。** `ownsHost` 是关于部署的一项事实，于是凡被闸放行的访客都够得着同一片操作者界面、写同一份宿主设置文档；本包无从分辨其中任何两人，后写的一次盖过先写的一次，而且两边都不会被告知。需要一人一份设置文档的部署，需要的是一人一个进程。
- **成员断言已经签发，但还没有人核验。** dsh 忽略 `X-Dsh-Member`，所以每一位被放行的访客仍是同一个操作者；要把他们分开，需要一个在宿主侧核验断言的组件。闸门与 dsh 共用一个 OS 用户的部署（托管的控制台就是这样）上，私钥在宿主上读得到，防伪造只靠 dsh 只监听回环（[部署代理与核验器](#deploy-proxy)）。
- **离开页面的 URL 不在覆盖范围内。** 文档 base 管辖的是页面自己解析的 URL；交给别处的东西——由浏览器下载管理器抓取的下载、被复制到另一个标签页的地址——必须本来就是绝对的。那些调用点自己构造绝对 URL，本包不检查它们。
- **没有装配级快照覆盖**——证据是本包针对已服务 index 的真实组合测试；快照泳道回放的是发布组合，而发布组合不包含实验性行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
