# Agent Note: 由部署来声明它的页面拥有这台宿主

Status: implemented

[English](2026-09-10-server-base-owns-host.md) | 中文

## Problem

控制台服务在 `https://lhr.ink/console/` 上，而那个 authority 不是回环。`packages/client/connection/src/client/index.ts` 用三样东西拼出 `ConnectionHandle.isLoopback`：页面全局载体上的 `ownsHost`、根本不存在 `location`、以及回环主机名。公网 authority 一样都不满足，于是客户端把这个页面读成别人的宿主，把留给操作者自己机器的那片界面收了起来。

看得见的那一半是设置。`packages/client/ui-settings/src/client/index.ts` 取 `persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`，而 memory 镜像从一开始就是 `unavailable` 且一直是（`settings-mirror.ts`），于是每一个设置分区——MCP 服务器插件也在内——都告诉访客自己读不到设置。`ui-settings-general` 在非回环上不构造设置文档控制器，`ui-deliverables` 也不再提供把产物文件的路径在宿主上打开。

被服务出去的东西里没有任何一样能说出相反的话。唯一能盖过 authority 的那个页面全局量 `__DSH_TRANSPORT__.ownsHost`，只有一种外壳写过它：`packages/experimental/webworker-runtime`，它的宿主跑在页面自己派生的 worker 里。一个经 HTTP 服务出去的页面，无从说出它那套部署本来就知道的那件事——除了这台宿主的操作者，没有别人够得着它。

## Decision

**这项声明是一件部署事实，所以它落在本线已经承载部署事实的那个包里。** `packages/experimental/server-base` 增加一个校验过的布尔字段 `ownsHost`，部署不写它就是 `false`。它与 `basePath` 并排，因为二者是同一类事实：关于本进程如何被发布、而被服务出去的页面自己推不出来的事情。

**设上它时，插件在前缀那两行之后再贡献一行 head 行**，一行带类型的 `script` 行，由 web 服务器逐字渲染为 `<script>globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };</script>`。它装上的载体并不是传输：`fetch` 就是 `(input, init) => globalThis.fetch(input, init)`，与 `createWebConnectionRpc` 在没有载体时所用的调用方分毫不差；它既不声明 `openStream` 也不声明 `loadBundle`，于是 RPC 照旧走 HTTP 请求与 Gateway WebSocket，客户端模块系统也照旧经 HTTP 加载 bundle。`ownsHost` 是这一行存在的唯一理由。赋值用 `??=`，于是自己组装了真正载体的外壳仍然留着它自己的。

**不设它时，被服务出去的 index 一如从前。** 那一行不存在，没有任何全局量被定义，前缀那两行的渲染与之前完全相同。

### 谁可以设它的约束

`ownsHost` 声明的是：够得着这个被服务出去的页面的人，就是这台宿主的操作者。它是关于页面前面那道闸的声明，从来不是关于访客本人的：凡被那道闸放行的访客都会拿到操作者界面，而他们共用背后这一台宿主。这套部署的闸是 dsh 浏览器会话 cookie 加上代理那道 `auth_request` 登录闸，二者都写在 `packages/experimental/server-base/README.md` 里。

它不挪动任何服务端检查。`/api` 浏览器信任栅栏（`packages/client/connection/src/api-request-trust.ts`）照旧拒绝任何既非回环、又不是 `trustedHosts` 里已声明 authority 的 Host，而那道栅栏自己写明了它的范围：它不是一层认证。客户端现在要调用的那些设置 RPC 同样不按页面 authority 设闸——`packages/api/settings-controller/src/index.ts` 把 `update`、`replace`、`mutate` 声明为普通的 `@Remote` 方法——所以在这一行存在之前，它就会回答任何被这套部署放行的调用方。这一行改变的是客户端提供哪片界面，而不是宿主会为一个已经抵达的请求做什么。

## Alternatives considered

**教 `client/connection` 把被服务出去的页面自己的部署读成回环**——比如把已声明的 `trustedHosts` authority、或者浏览器会话 cookie 的存在当作归属。否决：那是上游核心包，而在组合层能承载同一件事实时，本线不改上游核心。何况那样会替每一个组合了这条脊梁的部署做出关于浏览器 authority 的判断，包括那些「不是回环就该收起界面」本来完全正确的部署。那里真正改动的只有文字：`ClientTransportHooks` 是「谁可以设 `ownsHost`」这项事实的唯一归属，于是它的 JSDoc 点明被服务出去的页面是可以设它的第二方。

**在 `client-connection` 上加一个说同一件事的 `Config` 字段。** 出于同样的改核心理由否决；而且它要喂的那个页面全局量本来就存在，含义也本来就是这个。

**像 worker 预览那样组装一个完整载体**——`fetch`、`openStream` 与 `loadBundle` 齐备。否决：那会把 Gateway 流从 WebSocket 上挪走、把插件 bundle 从 HTTP 上挪走，最后得到与页面自身默认行为完全相同的结果，只为一个布尔量。

**由 `apps/web` 外壳自己的代码去设这个全局量。** 否决：外壳只构建一次、被每一套部署服务出去，而这件事实逐个部署不同；index 本来就是逐部署事实注入的地方。

**改为在宿主上按访客授权那片特权界面。** 否决——那是另一项改动，而不是更小的一项：dsh 不认证任何人，设置 RPC 没有闸，按访客授权需要一个宿主并不拥有的身份。那项工作记在这套部署的单点登录那一侧，不在这里。

**索性让设置读不到，改为到服务器主机上编辑设置文件。** 否决：控制台操作者要挂的 MCP 服务器正是从那片界面配置的，于是控制台会带着它自己的插件出厂，而那个插件对每一位访客说自己读不到设置。

## Consequences

**买到的。** 一台立在登录闸后面的控制台，提供它本来就带着的那片操作者界面：设置分区读写宿主的设置文档，设置文档的那些动作出现，产物文件的小标签也提供在宿主上打开它的路径。

**付出的。** 现在由一个布尔量决定一位被放行的访客是否够得着那片界面，而让这个决定站得住脚的是部署、不是进程。这项声明分不出差别：凡被放行的访客都写同一份设置文档，后写的一次盖过先写的一次，而且两边都不会被告知。这条限制记在包的 README 里。被放行的访客够得着的东西里有一处伸出了浏览器：设置文档的那个动作会让宿主把自己的设置文件落到磁盘、再用一个本地文本编辑器打开它，放在一台无头的控制台上，那个按钮就是在服务器上拉起一个编辑器进程。

**证据。**

| 主张 | 证据 |
|---|---|
| 什么都不声明的部署根本不服务任何载体 | `packages/experimental/server-base/tests/server-base.spec.ts`，读的是真实组合服务出去的那份 index |
| 声明了宿主归属的部署逐字服务出那个载体，位置在 `<base>` 元素之后、外壳入口模块之前 | 同一份文件，它把渲染出的标记钉住 |
| 这项声明默认不设，且不是布尔量的值会让这一行失败 | 同一份文件的 `Config` 用例 |
| 前缀那两行、它们的顺序，以及不含本行的组合所服务的 index，都没有变 | 同一份文件里原有的那些用例，未经改动即通过 |

`pnpm exec vitest run packages/experimental/server-base`：14 个用例。`pnpm run typecheck`、`pnpm run lint`、`pnpm run test:docs`、`pnpm run verify-config-catalog` 与 `pnpm run verify-export-jsdoc` 均为绿。
