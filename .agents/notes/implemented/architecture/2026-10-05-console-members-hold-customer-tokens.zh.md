# Agent Note: 控制台成员以签名断言进入 Host，单点登录闸按成员各持一枚客户 token

Status: implemented

[English](2026-10-05-console-members-hold-customer-tokens.md) | 中文

## Problem

控制台线用一个 dsh 进程服务一套部署的全部访客。`@deepseek-ai/dsh-experimental-auth-gate` 是照着「一位登录用户一个进程」写的（[浏览器单点登录 Note](2026-08-28-browser-single-sign-on-and-mcp-token-injection.zh.md)）：它的 node 半边只持有一枚客户 token，即任何浏览器投递过的最新一枚，每一次数据后端读取和 MCP 转发都花它。多人共用一个进程时，最后加载页面的那位访客决定每个会话的读取花谁的凭据；2026-09-10 在控制台部署上的一次检查显示，每位访客的会话花的都是最后加载页面那位的 token。这个包还承诺进程里没有别的东西读得到这枚 token，而加入组织的控制台守不住这一条：组织凭据来源必须读出一位成员的客户 token，才能把它换成组织 token。

缺的是两样东西。进程对「这个请求是哪位成员发的」没有可信的答案：dsh 浏览器 cookie 是对固定载荷做的 HMAC，不点名任何人，而一套部署的每位访客手里都有一枚有效的。另外，token 存放只有一个槽。

## Decision

**成员 id 以签名断言进入 Host，只有成员目录读它。** 部署方的登录门用部署方的认证服务核验每位访客的 token，删掉客户端自带的成员头，再往它转给 dsh 的每个请求里注入一枚现签的成员身份断言，载荷是核验出的 `login_uid`。`@deepseek-ai/dsh-experimental-console-members` 的 `consoleMembers` 服务在连接准入时用部署方的公钥核验这枚断言，为 webServer 路由回答 `principalOfRequest(req)`，为会话回答 `principalOfSession(sessionId)`，其中子会话归它的最上层会话所属的那位成员。本 fork 的路由只问 `principalOfRequest`，此外什么也不做：不读任何身份头，也不调 `connection.admit`。

**单点登录闸按成员各持一枚客户 token。** 开了 `perMember` 后，auth-gate 的 node 半边在内存里保存一个 `Map<PrincipalKey, string>`。token 路由在读正文之前经 `consoleMembers` 认出发送者——没有成员目录在跑时答 503，认不出是谁时答 401——并且只有当投递的 token 的 `principalClaim` 声明（toy-core 写 `login_uid`）点名的正是这位成员时才持有它，否则答 409。声明按签名代理的规则读出，于是 19 位的数字 id 按数字串比对。登出路由丢掉发送者自己的那一枚。`ctx.bizBackend` 经同一个成员目录解析每次读取的主体，成员目录归不到任何人的主体解析不到任何槽，绝不会解析到别的成员的槽，也不会解析到替整个进程持有的那一个。`perMember` 下 MCP 转发在加载时被拒，因为转发请求来自进程内的 MCP 客户端，点不出是哪位成员。缺省的 `perMember: false` 仍为整个进程持有一枚 token。

**成员目录可以读这些 token，由一项显式 Config 决定。** `shareWithMemberDirectory` 经 `consoleMembers` 服务的 `attachCustomerCredentials` 把一个读取器借给它，这个服务每启动一次借一次。读取器读一位成员的 token，报告 `set` 与 `dropped` 两种变化，不列出任何人。这个服务只收一个读取器，第二次就抛错；拒收会让 token 路由以 503 关闭。服务停下或这一行被释放时，读取器被作废；它不注册到任何上下文上，因为上下文上的服务，进程里每个插件都读得到。

在按成员持有的进程里，这推翻了[浏览器单点登录 Note](2026-08-28-browser-single-sign-on-and-mcp-token-injection.zh.md) 的两条规则：一个进程服务一位登录用户，以及进程里没有别的东西读得到 token。成员目录，以及它把 token 交给的任何东西——拿它去交换的组织凭据来源——读得到每一位成员的 token。

这三个字段都不是 volatile，所以设置写入碰不到它们；部署方在自己那一层设定它们。

## Alternatives considered

**一位成员一个进程。** 每位登录用户各有自己的进程、home 目录和 overlay，由代理按 token 选——单 token 闸正是照这种形态写的。它不需要任何规则就保住了「别的东西读不到 token」，但每位成员都要付一整个 Host 的代价，端口和进程生命周期都搬进部署方，成员之间也没有任何共享状态。控制台线选的是一个进程服务多位成员。

**每条路由自己从头里读身份。** 每条 fork 路由要么自己核验断言，要么相信一个普通头。普通头谁能连到 dsh 端口谁就能伪造，而逐条路由核验会把公钥和过期规则在每个包里重写一遍。成员目录在连接准入时核验一次。

**把 dsh 浏览器 cookie 当作身份。** 它是对固定载荷做的 HMAC，部署方的代理用同一枚启动 token 替每位访客换 cookie，于是每位访客的 cookie 都有效，却没有一枚点名任何人。

**把读取器注册成 Cordis 服务。** 那样进程里每个插件都读得到每位成员的 token，而本 fork 的审计发现第三方插件默认不声明审批闸。只借给接收它的那一个服务，读者就限于那个服务以及它再把 token 交给的东西。

**能列出持有哪些成员的读取器。** 能列举，就把「读这位成员的 token」变成了「一次读出所有人的」，而没有哪个消费方需要它：组织凭据来源问的是这个请求所代表的那位成员。

**成员目录缺失时退回整个进程一枚 token。** 配错的按成员进程就会替所有人花同一位访客的 token，而这正是本决定要堵上的故障，所以成员目录缺失时答 503，每次读取答 `unauthenticated`。

**按成员保留 MCP 转发。** `dsh-mcp-client` 在它那一行加载时就把请求头定死了，所以一次转发分不出是哪位成员的会话发的。按请求带上成员，需要改那个包的请求头机制；按成员持有的控制台改用服务凭据连 MCP 服务器。

## Consequences

同一个控制台的两位成员同时持有各自的客户 token：A 的会话（子会话在内）以 A 的身份读数据后端，B 的以 B 的身份；后端拒绝只丢那一位成员的 token；B 登出不影响 A。账号切换时还有投递在途的浏览器拿到 409，而不是把一位成员的 token 存到另一位名下。

信任前提移到了部署方。它的登录门核验 token 并签发断言，签名私钥必须让 dsh 进程的 OS 用户读不到；在这层隔离部署好之前，防止断言被伪造的只有 dsh 前面的网络拓扑。打开 `shareWithMemberDirectory` 后，成员目录以及它把 token 交给的凭据来源读得到每一位成员的 token，单 token 闸「进程里没有别的东西读得到 token」的承诺只在这个字段关闭时成立。

按成员持有的控制台没有 MCP 转发，所以 MCP 工具做的写入——iot 写入也在其中——记在 console-mcp 的服务账号名下，而不是提出请求的那位成员名下。没有成员目录在跑的按成员进程，在 token 路由和登出路由上答 503；报告它的那条 error 日志在 Loader 树安定下来时才写，因为 Cordis 没有宿主就绪事件。

在 `@deepseek-ai/dsh-experimental-console-members` 进入这条线之前，auth-gate 在 `packages/experimental/auth-gate/src/member-directory.ts` 里声明 `Context.consoleMembers` 以及 auth-gate 调用的那几个成员；那个包进来之后，这段声明删掉，类型改从那个包导入。

没有哪个已发布 profile 设 `perMember`，所以没有录制会话快照覆盖它。`packages/experimental/auth-gate/tests/per-member.client.spec.ts` 经 Loader 启动这道闸，配一个测试专用的成员目录行，覆盖两位成员的 token、子会话、401/409/503 三种拒绝、读取器的借出及其被拒，以及释放。
