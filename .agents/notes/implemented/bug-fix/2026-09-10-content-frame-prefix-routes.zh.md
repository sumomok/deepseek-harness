# Agent Note: the read channel addresses the deployment prefix

Status: implemented

[English](2026-09-10-content-frame-prefix-routes.md) | 中文

## Problem

在把客户控制台发布在 `/console/` 下的那套部署上，每一次 `content_read` 都以同一句话收场：

```
No console tab is showing this session's content column (waited 3s).
```

而控制台就开在用户眼前，被问的那个页面也正摆在台面上。另外五个页面工具同样如此，会话日志显示宿主一侧全程正常：调用被折进 `contentAccess`、发布给每一个已连接的浏览器，并在整个认领窗口里一直挂着。

浏览器一侧压根没到。`packages/experimental/content-frame/src/client/access/executor.ts` 把三条读取路由按 node 半边的写法直接发了出去（行号为缺陷当时的位置）：

- `:344` 的 `post(CONTENT_CLAIM_ROUTE, …)`
- `:912`、`:918`、`:921` 的 `reportRead(CONTENT_REPORT_ROUTE | CONTENT_IMAGE_ROUTE, …)`

它们都汇到 `:277` 那一处 `fetch(route, …)`。以根开头的路径是相对 origin 解析的，而不是相对页面的 base，于是在前缀下座位请求的是 `https://host/content-frame/claim`——部署方的 nginx 根本不会把这个地址转给本进程。这次 post 以 `undelivered` 收场，竞领循环又把它一遍遍投进同一片虚空，直到调用离开待办列表，宿主的 `claimTimeoutMs` 于是拼出了上面那句拒绝。座位干得没错，它只是在跟错的主机说话。

同一个包里的 settings 路由本来就是对的（`src/client/index.ts:130`），所以这一栏本身画得出来，只有读取是坏的。

### 前缀那轮工作为什么没抓到

[base-path 决策](../architecture/2026-09-04-base-path-for-the-server-console.zh.md)清点过页面在运行时构造的东西——三份 `resolveBase()` 副本、两条 WebSocket 下行、HMR 的 `EventSource`、「本仓库自己四个插件 fetch 的 settings 路由」——而[合并前推那篇](../process/2026-09-06-console-merge-forward.zh.md)又把合并后的树审了一遍，点名了它决定留下的两处以根开头的地址（combo source map 的 `sources[]`，以及 PWA manifest）。

两次审查找的都是「路由常量站在请求点上」这个形状：`*_ROUTE` 挨着 `fetch(`、`new WebSocket(`、`new EventSource(`。而在这个文件里，常量和请求隔着七十行，中间还夹着一个本地的 `post()` 帮手——`post()` 把 `route` 当成一个不透明的字符串参数收下，所以 `fetch(` 那一处根本没提任何路由，三处调用点也根本没提 `fetch`。两次审查的搜索形状在这里都没有命中，于是各自都因为这个包唯一那处看得见的路由 fetch（settings 那条）是对的，而判定整个包已被覆盖。

## Decision

**地址由 `post()` 解析；路由常量不承载它。** 读取通道里那唯一一处 fetch 现在是 `fetch(clientUrl(route), …)`，四个调用点都被它们本来就汇入的这个帮手覆盖；`packages/experimental/content-frame/src/access/wire.ts` 里的 `CONTENT_CLAIM_ROUTE`、`CONTENT_REPORT_ROUTE`、`CONTENT_IMAGE_ROUTE` 仍然以根开头——它们同时也是 node 半边注册的路径，而那是代理剥掉前缀之后的样子。`post()` 的 JSDoc 写明了两个半边需要从同一个值得到不同的地址，这就是解析发生在请求处、而不是发生在常量里的原因。

本包为了 settings 那次 fetch，早已把 `@deepseek-ai/dsh-client-connection/client` 声明为 `dsh.client.external`，所以这次没有新增任何依赖。

本包里仍有一个浏览器地址不走这条解析，而且就该不走：页面配置里的 `url`，frame 按原样请求它。带前缀的部署自己把前缀写进那个值里，因为它是部署数据，不是本进程注册的路由——`src/types.ts:229` 持有这条约定，README 的 [agent 可展示的页面](../../../../packages/experimental/content-frame/README.zh.md#pages-the-agent-may-show)一节陈述它。

## The sweep

`packages/experimental/` 下每一个浏览器半边都按同一类缺陷清点过一遍——`fetch`、`EventSource`、`WebSocket`、`XMLHttpRequest`、`sendBeacon`、`axios`、动态 `import()`，以及从 `src/client` 树能够到的每一个 `*_ROUTE`/`*_PATH` 常量。十三个包带浏览器半边。缺陷只有这一处。

- **已经走 `clientUrl`：** `auth-gate`（settings、token、logout）、`server-sidebar`（identity、导航目录、workflow 菜单、gate 的 settings 与 logout）、`vue2-echarts-tool-poc`（settings、report），以及 `content-frame` 自己的 settings 路由。
- **刻意不解析，且是对的：** `auth-gate` 的 `browser.ts:203` 续期探测有意相对 `location.href` 解析，好让凭据无论文档带着什么 `<base>` 都只发往本 origin，而且它的路径是部署方自己的上游端点，不是 Host 路由。`content-frame` 的 iframe `src` 就是上面那个配置里的页面 `url`。`inspector` 的 bridge WebSocket 从 bootstrap 拿到的是完整限定的端点；`webworker-runtime` 本来就相对 `document.baseURI` 解析，其余的 fetch 走 worker 隧道。
- **浏览器侧完全没有网络地址：** `component-surface`、`content-column`、`server-layout`、`component-kit`、`client-ui-agent-team`、`vue-ui-poc`、`vue2-echarts-poc`。`component-surface` 的 `/component-surface/views` 路由是 node 侧注册并提供的；它唯一的浏览器读取方是 server-sidebar 的导航目录，那里是解析过的。
- **没有浏览器半边：** `content-surface`、`biz-backend`、`library-skills`。`biz-backend` 的 `fetch` 在 node 侧，打的是配置里的绝对后端 URL。

## Alternatives considered

**在三个调用点各自解析，而不是在 `post()` 里。** 否决。调用点挑的是路由，请求点挑的是地址，而请求点只有一个。摊开来只会让日后新加的第四个调用点去记一条没人强制的规矩——而那正是这个缺陷的形状。

**把前缀铸进路由常量里。** 否决。`wire.ts` 是两个半边共用的，node 半边把这些同样的值注册成路径，而那是在代理已经剥掉前缀的进程上。一个值当不了两个地址；该把前缀加回去的是浏览器这一半。

**把常量写成相对路径，交给 `<base href>` 去解析。** 出于同样的理由否决，还多一条更糟的：相对路径是相对文档的 base 解析的，而那个 base 是 server-base 行和 dist server 两边写的，于是读取通道的地址会取决于一个本包两个半边都不设置的值。`clientUrl` 读的是同一个 base，但只取它的路径、并且始终把它落在页面 origin 上——这正是「一个指向别的 origin 的 `<base>` 改不了认领去向」的原因。

**让进程知道自己的前缀，把路由注册在前缀下。** 全仓库早已否决；[base-path 决策](../architecture/2026-09-04-base-path-for-the-server-console.zh.md)持有理由（四处各自独立匹配路径的地方，改不全就会产生症状指向路由而非指向前缀的 404）。

## Consequences

- 读取通道在路径前缀下能跑了，而发布在站点根上的部署没有任何变化：没有任何东西声明前缀时，`clientUrl` 解析到的就是 origin 根，也就是这次改动之前座位发出的那个地址。
- 为这个座位打桩 `fetch` 的四个 jsdom 台架，现在站在浏览器站的位置上——它们按文档的方式去解析座位交给 `fetch` 的东西，并按路径后缀而不是常量相等来路由。这才使得地址成为可断言的东西；这也意味着日后的前缀回归会在地址上失败，而不是在一份缺失的文档上失败。
- **浏览器泳道没有覆盖前缀下的读取，而且把本包塞进那个看上去最接近的场景，同样覆盖不到。** `apps/web/tests/base-path.e2e.ts` 在剥前缀的代理后面启动出厂外壳加 `server-base` 与 `auth-gate`，它那条「落在前缀之外」的断言测的是 `ROOT_ROUTES = /^\/(api|plugins|auth-gate)(\/|$)/`（`:61`，在 `:257` 处过滤）。那是一份只列了三条的白名单——载体、模块加载器、gate，也就是该场景讲的三条 URL 构造路径——而 `/content-frame/claim` 一条都不匹配，所以哪怕读取通道整个是死的，那个场景照样是绿的。把内容栏四行塞进去还会用 `server-layout` 顶替 `ui-layout`，而那正是它现有断言所针对的外壳。更省的回归路径是给 `apps/web/tests/content-read-hidden.e2e.ts` 加一个兄弟场景：它本来就拥有 overlay、拼进去的 `content/shown` 加未决调用，以及用同一个 call id、零模型调用的 `ctx.tools.execute` 驱动；前面再摆上 `apps/web/tests/prefix-proxy.ts` 的 `startPrefixProxy`，断言的是这次工具调用在前缀下最终落定成的那个值。大约 200 到 260 行，作为后续项而不是本次改动的一部分。

## Testing

`packages/experimental/content-frame/tests/content-read-executor.client.spec.tsx` 里 `the addresses the seat posts to` 之下的两个用例。两个都通过真实座位驱动一次文本读取和一次图片读取，再把 `fetch` 实际被请求的地址读回来：`__DSH_BASE__` 设为 `/console/` 时，认领、回报、图片三条路由必须是页面 origin 上的 `/console/content-frame/{claim,report,image}`；没有任何东西声明前缀时，同样这三条落在站点根上。

带前缀那个用例在改动前的代码上失败，差异里就是线上那个地址：

```
- "http://localhost:3000/console/content-frame/claim"
+ "http://localhost:3000/content-frame/claim"
```

而不带前缀那个用例两边都通过——这才使得前一个用例是关于前缀的，而不是关于台架的。本包其余 849 个用例没有变化；对它们唯一的改动是那四处 `fetch` 打桩，它们必须学会座位现在交给 `fetch` 的是一个已解析的 URL。
