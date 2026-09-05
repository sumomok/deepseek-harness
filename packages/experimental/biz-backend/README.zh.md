---
description: "对本部署自己的数据后端的两次带凭据读取——一个资源模型的一页行，以及一个模型的属性名——用的是正在使用这个部署的那个人的令牌；面向把 harness 接到业务控制台 API 上的组合方与这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-biz-backend

[English](README.md) | 中文

## 概述

`ctx.bizBackend`：对本部署自己的数据后端的两次读取，用的是正在使用这个部署的那个人的访问令牌。发放令牌的部署通常也提供自己的数据——一个人在它的 Web 控制台里打开一份资源清单时，会发出一次取该模型属性名的请求和一次取一页行的请求，两者都带着这个人的令牌——本包就是在 harness 进程里发出同样这两条请求。

只在 Host 侧，且自己不持有任何凭据。安装这个服务的一方按引用把令牌传进来，于是令牌留在那个包的闭包里，从不在上下文上具名。

## 目录

- [怎么安装这个服务](#installing-the-service)
- [这两次读取](#the-two-reads)
- [这枚凭据怎么花](#how-the-credential-is-spent)
- [什么都不抛](#nothing-throws)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="installing-the-service"></a>
## 怎么安装这个服务

这个服务是被构造出来的，不是被组合进来的：没有插件行，因为只有握着访客令牌的那一行才可以创建它。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { BizBackendService, type HeldCredential } from '@deepseek-ai/dsh-experimental-biz-backend'

declare const ctx: Context
declare const upstream: string
declare const credential: HeldCredential

new BizBackendService(ctx, upstream, credential)
```

在本 fork 里，那个调用方是 [`dsh-experimental-auth-gate`](../auth-gate/README.zh.md)：它的 `bizUpstream` 配置就是这个基址，它持有的令牌就是这枚凭据；没有配置基址的部署什么都不构造——于是消费方的 `ctx.inject(['bizBackend'])` 会明确挂起并点出缺失的服务名，而不是通过一个次次调用都失败的服务去读。

`upstream` 必须是绝对的 `http(s)` 地址，不带查询串、片段或它自己的凭据，且路径以 `/` 结尾。那段路径就是本部署的 API 前缀，也就是前端自己的 `VUE_APP_BASE_URL`：标准安装编译出 `/ini-server/`，而编译时没有前缀的安装把 API 发布在源站根上。每次读取都是把基址整段保留、再把服务路径接在后面拼出来的，绝不是拿一个地址去解析另一个——一旦被接的那半以 `/` 开头，解析就会把 API 前缀整段丢掉，请求于是落到服务器根上。基址由调用方在加载期检查，因为在这里被拒的地址会变成每读一次被拒一次，而不是每组合一次被拒一次。

<a id="the-two-reads"></a>
## 这两次读取

| 方法 | 读到什么 |
|---|---|
| `search(request, signal)` | 一个资源模型的一页行，同一批行给两遍——`rawValue` 是存储值，`displayValue` 是本部署展示给人看的值——外加跨所有页的总数。 |
| `describe(meta, signal)` | 一个资源模型的属性，同时给出行所用的键名和展示给人看的名字。 |

还有第三个方法什么都不读：`holdsCredential()` 回答手上到底有没有令牌。它是为「读之前先问人」的调用方准备的，好让一次本进程做不到的读取不必先去问谁答不答应。它对下一次调用不作任何承诺——后端可能在这中间就把令牌拒了，而每次调用本来就会自己答 `unauthenticated`。

是两个方法而不是一条 `fetch(path, init)` 管道，因为同一个前缀下还挂着 `PUT /api/resources/{model}/{id}`、`DELETE /api/resources/{model}/{id}` 和 `POST /api/batchresources/delete/{model}`。一条通用管道等于把访客的凭据连同这些端点一起交给同进程的每一个插件。这里什么都不写，也没有调用方能自己挑路径：不是单个裸名字的模型名在任何请求发出之前就被拒，所以一个含 `/` 或 `..` 的名字没法把带凭据的请求引到邻近的端点上。

补默认值只发生在一处显式步骤里，位于调用方陈述的请求和真正上线的文档之间——`matchMode` 变成 `AND`，未陈述的分页变成第一页 200 行，`asc` 与 `desc` 变成 null，`conditions` 变成空——于是一个未陈述的字段会变成什么，只在一个地方读得到。陈述了 `source` 的调用方拿到的是那些属性外加后端自己的行标识：本部署的客户端会往每一份发出的 `source` 前面插一个 `int_id`，后端也就不管调用方问没问都把它答回来。不能展示自己没点名的列的消费方，得自己把这个多出来的键去掉。

这两次读取就是本部署自己的那两次，只去掉它的网页为自己加的三样：不带防缓存的查询参数，不把浏览器存的用户资料摊成请求头，事后也不补一条操作记录——补一条等于往本部署的审计轨迹里写一次它的用户从没做过的操作。

<a id="how-the-credential-is-spent"></a>
## 这枚凭据怎么花

`Authorization` 与 `CertificationToken` 两个头都写 `Bearer <token>`：与本部署自己的网页发出的字节相同——那个页面存的是 `"Bearer <jwt>"`，并把存储原值逐字塞进这两个头，而调用方持有的是裸 JWT。`CertificationToken` 只是这个后端读取令牌的方式，不是第二枚凭据。别的能标识浏览器的东西一概不发——不带 cookie，也没有任何由令牌之外的东西派生出来的请求头。

<a id="nothing-throws"></a>
## 什么都不抛

每次调用要么给出结果，要么给出一个闭合失败联合里的成员：`unauthenticated`（没有持有令牌，请求根本没发）、`refused`（后端拒的是这枚凭据本身）、`rejected`（后端答了，答的是不行）、`unreachable`（这条缝读不到答复——请求没发出去、没到达，或回来的是别的东西）。消费方按标签 `switch` 并以 `assertNever` 收口，于是日后新增的成员会让它的构建失败，而不是从缺口漏过去。

拿主意的是答复里的结果码，不是单看状态：这个后端会用 HTTP 200 加一个非零码来拒绝一次请求，所以只信状态的消费方会把一次拒绝读成数据。另有两种答复会让调用方交出令牌，走的是凭据传进来时自带的那个 `drop`：HTTP 401，以及任何带结果码 2 或 3 的失败状态。后一种沿用本部署自己的客户端：它只在错误路径上因这两个码交出存储的令牌——它的成功路径在 HTTP 200 上报告非零码并保留令牌——所以同一个码在 200 上意味着一次请求被拒，在失败状态上意味着这枚凭据被拒。HTTP 403 不在其中：那个客户端把它读成这次请求被拒绝访问，并保留存储的令牌，所以 403 和别的失败状态一样按信封分类，只有在带着码 2 或 3 时才交出凭据。

没有任何一个失败带上凭据、完整请求 URL 或后端的排障标识——失败会被报告给模型并写进会话日志，这三样哪一处都不该去。后端说的话在转述给调用方之前，会先按名字把出示过的凭据抠掉，再截到 120 个字符；只截长度守不住这个承诺，因为一个在前一百个字符里就把令牌说回来的后端能照样通过。

## Model Experience

None, as this package registers no tool, prompt section, or result: it performs two HTTP reads for whichever row consumes the service, and every model-visible effect of those rows belongs to them.

#### KV Cache effect

无关：本包不发起模型请求，也不往请求里加任何东西，所以没有请求前缀发生变化，也没有已可复用的前缀被作废。

## Known Limitations and Deferred Work

- **按行裁剪只能指望后端，而这一条未经证实。** 本部署前端有一层行列权限，但它在找不到已登录用户资料时是放开而不是收紧，所以它根本不是这边可以依赖的边界。后端若不按出示的令牌收窄行，一次读取就可能把这个人不该看到的行画上他的屏幕、写进他的会话日志——而登出并不清洗已经写下的日志。
- **HTTP 200 上的 `code 3` 在这里算业务拒绝，不算凭据被拒。** 带这个码的失败状态确实会交出令牌，但一个把令牌过期报成 HTTP 200 加 `code 3` 的后端，会继续被出示那枚令牌，每次读取都答 `rejected`。200 这条路是有意不动的：本部署自己的成功拦截器在那里同样保留令牌，猜反了就会在一次普通业务拒绝上丢掉一枚还活着的凭据。
- **不复刻控制台的按模型地址覆盖。** 本部署前端有一份运行期注册表，能把某个模型的查询指到它自己的地址上，而这一侧没有注册方。这样配置过的模型会在默认地址上被读取，那里未必是控制台读的那份。触发器是第一次读出来的行与页面对不上。
- **组合里的每一行都能用这个服务。** `ctx.bizBackend` 在上下文上具名，所以与构造它的那一行一同加载的任何插件，都能以这位已登录访客的身份读本部署的数据。这两个方法之窄就是这条边界的全部；谁可以调用它们是组合的决定，而第三方插件默认不声明任何审批闸。令牌本身仍够不着——它握在调用方的闭包里，没有作为任何服务发布。
- **这条缝只有读。** 没有新增、修改、删除，加一个也不是再写一个方法的事：一次写入是把一个人的凭据花在改动他自己的系统上，那需要它自己的同意问句和它自己的记录，两样这里都没有。
- **未被组装快照覆盖** ——本服务由本包自己的用例覆盖，端到端则由 `apps/web/tests/component-surface-datasource.e2e.ts` 里针对真实组合的 Playwright 场景覆盖；快照泳道回放的是出厂组合，那里不组合实验性行。

**运行时不变式：** 不发布伴生入口。本包不追加任何会话事件，不拥有任何持久数据，自己也不保有可变状态：它花的令牌属于构造这个服务的那一方，只经那个闭包可达；而每次调用会变成什么，由 `tests/biz-backend.spec.ts` 陈述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
