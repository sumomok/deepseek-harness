# Agent Note: auth-gate——把登录页的 `Bearer` scheme 只在一处剥掉，以及一条能同时清掉镜像 cookie 与持有 token 的登出

Status: implemented

[English](2026-09-04-auth-gate-bearer-scheme-and-sign-out-route.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-auth-gate`（[`2026-08-28-browser-single-sign-on-and-mcp-token-injection.md`](2026-08-28-browser-single-sign-on-and-mcp-token-injection.zh.md)）是照着一条假定的、与部署方登录页之间的约定写的：`localStorage.accessToken` 里放的是一枚裸的三段式 JWT。而这个部署实际用的登录页是 toy-core 页面，它存进去的是 `"Bearer <jwt>"`——正是它自己的 HTTP 客户端原样放进 `Authorization` 头的那个值。面对这个页面，闸门连第一步决定都过不去：`usableToken` 调用 `isJwtShaped`，后者只认三段 base64url，于是一位刚登录完的访客被读成未登录、被送回登录页、再登录一次、又撞回同一次拒绝。这个标签页永远不会渲染别的东西。

随之浮出水面的还有三处缺口，都在闸门交出一枚 token 时走的那条路上。

- 镜像 cookie 在每一次「决定离开」中都活了下来。闸门写它，是为了让不带 `Authorization` 头的请求也能向立在进程前的反向代理表明访客身份；而当它背后那枚 token 已经没了或过期了，这枚 cookie 就会继续呈上一枚死凭据——在跳往登录页的那次导航上，以及在登录页自己发出的每一个请求上。
- node 半边继续持有那枚 token。它的转发路由花的是最后被投递进来的那一枚，于是一位登出了、或者 token 过期了的访客，会让这个进程继续能以他的身份抵达部署方的 MCP 服务器，直到进程结束。
- 返回地址会把登录页自己的凭据参数又带回给它。toy-core 除了从存储里读凭据，也从 `token` 与 `token4a` 里读（`core/token.js:32,81`），而且读的是整个地址而不是它的查询串——`getUrlParam` 解析的是 `location.href` 里第一个 `?` 之后的全部内容（`utils/commonUtils.js:60`）。于是一个以 `…?token=<jwt>`、或以 `…#/board?token=<jwt>` 抵达的页面产生出的 `redirect`，恰好把闸门刚刚拒绝掉的那枚 token 交回给登录页，还把它留在了浏览器历史里，以及那个页面发出的每一个 referrer 里。

## Decision

**scheme 只在「一个被存的值进入闸门」的那一个点上剥掉，别处一概不剥。** `src/client/browser.ts` 里的 `storedToken(raw)` 去掉开头的空白、其后那个大小写不敏感的 `Bearer`，以及紧随其后的那串空白；`windowGateBrowser().readToken()` 是它唯一的调用者。它是幂等的——裸 JWT 与 `null` 原样返回——因此某个登录页日后改存裸 token，也不需要第二条约定。`src/route.ts` 里的 `isJwtShaped` 与 `parseTokenPost` 原封不动：它们守的是 token 跨进程时经过的那道 wire 边界，而 `readToken` 之下的一切——代理读的镜像 cookie、token 路由、`proxy.ts` 自己加上 `Bearer ` 拼出的 `Authorization` 头——携带的都是裸 JWT。把 wire 检查放宽到两种形态都收，等于把「哪一种形态走到哪里」这个选择摊给每一个下游消费者，而不是收进一个函数里。

**每一处「前往登录页」的决定都先交出 token，且顺序固定。** `src/client/run.ts` 里的 `leaveForLogin` 是唯一出口，由启动决定、storage 变化决定和 `handleTokenExpiring` 三处进入：先 `revoke()`，再 `browser.clearCookie(settings.cookieName)`，最后跳转。node 半边先停止花这枚凭据，镜像随后停止呈上它，页面最后才离开，于是没有哪一步依赖一个可能已经不在了的页面。`clearCookieLine(name)` 就放在 `mirrorCookieLine(name, value)` 旁边，并逐字重复它的 `Path`、`Secure`、`SameSite`——浏览器是按名字、路径和域把一次删除对应到已有 cookie 的，任何一项不同都会写出第二枚空 cookie，而把被镜像的 token 原样留在那里。

**`POST /auth-gate/logout` 是一条 browser 半边调用的路由，不是给人操作的控件。** 它把插件闭包里的 `held` 置回 `undefined` 并以 204 作答，背后是 token 路由同款的整道 `rejectMethod`／`rejectCrossSite`／`rejectNonJson` 栅栏，而且完全不读正文：它不点名任何 token，只是丢掉当前持有的那一枚——而那正是本进程所服务的唯一一位访客的 token。这道栅栏的两层都承重，理由只有一个：`rejectCrossSite` 读的是 `sec-fetch-site`，因此带着这个头的请求才是被浏览器标注过的请求，而完全不带的请求会通过。真正把一条会改变状态的路由从「跨源页面免预检就能投递」的集合里撤出来的是 content type——这正是登出路由明明不读正文却仍要求 `application/json`、而 browser 半边也要声明它的原因。browser 半边在 `leaveForLogin` 的 `revoke` 回调里带 `keepalive: true` 发出它，否则两步之后的跳转会把这个由文档持有的请求取消掉。把这次调用坐在闸门那三处登录决定上，正是这项保证不需要产品界面也能成立的原因：让「持有的 token 是错的」这件事成立的那些状态——没有 token、被删掉的 token、过期的 token——恰好就是闸门已经在检测的状态。

**返回地址在被编码之前先去掉 `token` 与 `token4a`，片段里的和查询串里的一并去掉。** `src/client/gate.ts` 里的 `returnAddress` 以文本方式拼接剩下的参数，而不是重新序列化它们，于是页面被请求时携带的每一个参数都以原样的编码回来。片段之所以受同样处理，是因为另一头那个读者并不认这条分界：toy-core 的 `getUrlParam` 解析的是 `location.href` 里第一个 `?` 之后的全部内容（`utils/commonUtils.js:60`），而 `getToken` 把从那里读到的 `token` 直接写进 `localStorage.accessToken`（`core/token.js:75`）。因此「只剥查询串」比「两处都不剥」更糟——它恰好拿走了那个把片段里的副本挡在该解析器视野之外的 `?`。留下来的是片段自己的路由和其余参数，而这正是一个 hash 路由的返回地址该有的样子。

## Alternatives considered

**在 wire 边界上两种形态都收——让 `isJwtShaped` 与 `parseTokenPost` 接受带 `Bearer` 前缀的值。** 否决：token 路由是浏览器与进程之间的那道边界，而一道接受同一枚凭据两种写法的边界，会让下游每一个读者都得负责判断自己拿到的是哪一种。`proxy.ts` 自己会拼 `Bearer ${token}`，于是一个带前缀的值走到那里就会产出 `Bearer Bearer <jwt>`——一个被上游拒绝、且没有任何诊断指回这里的头。在值进入的地方剥掉 scheme，包内就只剩一种表示。

**改在 `usableToken` 或 `decideGate` 里剥。** 否决：那两处是决策表，定义在「token 这个值」之上，而 `run.ts` 把 `decision.accepted.token` 直接带进镜像 cookie 和投递给 node 半边的推送。放在那里剥，还得为 cookie 的回读比对再剥一次；而第二个剥离点就是第二条需要保持同步的约定。

**顺带把 `localStorage` 里的 token 也清掉。** 本片否决：`GateBrowser` 里没有写存储的操作，登录页在访客回来的路上会覆盖这个 key，而一道会清存储的闸门会与同源下另一个正在登录中的标签页抢。本片实现的产品决定是「没有 token 或接口 401 就跳登录页」；一个会清存储并打断当前回合的登出控件是另一块界面，已作为 Known Limitation 记在包的 README 里。

**让 node 半边自己按 `exp` 声明把持有的 token 过期掉。** 否决：node 半边刻意不从 token 里读任何东西——它持有的是一枚不透明的凭据，从不解码它，这正是本包得以声明「它不认证任何人」的原因。在那里加一个声明读取器，去回答一个 browser 半边已经按排期在回答的问题，等于在进程里放进第二套、且更弱的过期策略。

**用 `URLSearchParams` 重新序列化返回地址。** 否决：它会改写自己保留下来的那些参数（字面空格变成 `+`，保留字符被重新编码），于是返回地址会与访客当初请求的那个有细微出入。文本拼接则让每一个保留下来的参数逐字节不变。

**只剥查询串里的凭据参数，片段不动。** 否决：片段确实不离开浏览器，可 `localStorage` 也不离开，而登录页两处都读。由于那个页面的解析器是从整个地址的第一个 `?` 开始的，查询串里的那一枚会挡住片段里的那一枚；只剥查询串这一种改法，恰好把一枚该页面本来够不着的凭据变成了它会拿走的凭据。要么两处都剥，要么两处都不剥——而两处都不剥正是这道闸门存在的意义所在。

**在登出请求里点名要丢的那一枚 token，只在与 `held` 相等时才清空。** 本片延后，并已作为 Known Limitation 明写进包的 README，而不是留成潜规则。它确实能关掉一个真实的时序隐患——一次 `keepalive` 登出如果晚到、晚过下一次页面加载投递新 token，就会把那枚新的丢掉——但它与「必须先成立的那条决定」不合：启动时没找到可用 token 的那次决定根本没有 token 可点名，于是这条路由无论如何都还要保留「丢掉当前持有的那一枚」这层语义，而一条有两种模式的路由，它的栅栏就得被推敲两遍。同一处缺口的另一半——页面重新可见时把当前那一枚再投递一次——是它可以采取的另一种形态。

## Consequences

登录页存裸 JWT 的部署不受影响：`storedToken` 对这样的值原样返回；而 `apps/web/tests/auth-gate.e2e.ts` 里的 e2e 场景现在存的是带 `Bearer` 前缀的形态，同时仍然断言镜像 cookie 与转发出去的 `Authorization` 头里是裸 token——这才让这次剥离成为端到端可观察的事实，而不是一条单测事实。那个场景还多了一段登出：由同一个 context 里的第二个标签页删掉被存的 token——这也是 `storage` 事件唯一会被投递出来的方式——然后从浏览器上读出那三处效果：context 里的镜像 cookie 消失、标签页停在登录页、转发路由回到 503。

`storedToken` 接受 scheme 前后的任意空白，而不是只认登录页写出的那一个空格，因为另一头的失败恰恰是本文档要消除的那一个：一个它拒绝剥离的值会通不过 `isJwtShaped`，把一位已登录的访客又送回登录页。除此之外什么都不剥——重复的 scheme 会活下来，并以同样的方式被拒绝——因为 JWT 里不含空白，所以这份容差扩大的是「闸门能正确读出的值」的集合，而不是「它会接受的值」的集合。

node 半边对 token 的记忆不再是「存活到进程结束」：`held` 现在会被一条路由清掉，因此包 README 里那条关于吊销的 Known Limitation 被换成了这条路由的契约，以及仍然没有登出的那两处——直接关掉标签页的访客，和本片并不打断的 agent loop。

`runGate` 多了第四个参数。它是 browser 半边的签名，只有两个调用者：client 插件体和它自己的 spec，因此代价被限制在本包内；另一条路——把它做成 `GateBrowser` 的一个方法——会把一次路由调用放进那个「唯一职责就是充当闸门与浏览器全局对象唯一接触面」的接口里。
