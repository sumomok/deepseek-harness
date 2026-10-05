---
description: "对本部署自己的数据后端的六次带凭据读取——一个资源模型的一页行、一个模型的属性、它自己的资源清单打开这个模型时用的那几列、这个模型存下的默认表单、本部署的整份模型目录，以及当前登录者自己的权限——用的是正在使用这个部署的那个人的令牌；面向把 harness 接到业务控制台 API 上的组合方与这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-biz-backend

[English](README.md) | 中文

## 概述

`ctx.bizBackend`：对本部署自己的数据后端的六次读取，用的是正在使用这个部署的那个人的访问令牌。一个人在部署的 Web 控制台里打开一份资源清单时，会发出一次取该模型属性的请求、一次取这份清单默认打开哪些列的请求，和一次取一页行的请求，都带着这个人的令牌。本包在 harness 进程里发出同样这三条请求，另外再发三条它的页面同样会发的：整份模型目录、一个模型存下的表单，以及这个人被允许做什么。

## 目录

- [怎么安装这个服务](#installing-the-service)
- [一次读取替谁读](#whom-a-read-is-for)
- [这六次读取](#the-six-reads)
- [这枚凭据怎么花](#how-the-credential-is-spent)
- [什么都不抛](#nothing-throws)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="installing-the-service"></a>
## 怎么安装这个服务

只在 Host 侧，且自己不持有任何凭据。安装这个服务的一方按引用传进来一个 `CredentialResolver`（凭据解析器）：对每次读取点名的主体，它交回握着那个人令牌的那个槽——一个 `HeldCredential`——于是每枚令牌都留在那个包的闭包里，没有一枚在上下文上具名。

这个服务是被构造出来的，不是被组合进来的：没有插件行，因为只有握着访客令牌的那一行才可以创建它。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { BizBackendService, BizOperationRules, type CredentialResolver } from '@deepseek-ai/dsh-experimental-biz-backend'

declare const ctx: Context
declare const upstream: string
declare const credentials: CredentialResolver

new BizBackendService(ctx, upstream, credentials, BizOperationRules({}))
```

在本 fork 里，那个调用方是 [`dsh-experimental-auth-gate`](../auth-gate/README.zh.md)：它的 `bizUpstream` 配置就是这个基址，架在它持有的令牌之上的解析器就是凭据来源，它的 `bizOperationRules` 配置就是规则表；没有配置基址的部署什么都不构造——于是消费方的 `ctx.inject(['bizBackend'])` 会明确挂起并点出缺失的服务名，而不是通过一个次次调用都失败的服务去读。

`upstream` 必须是绝对的 `http(s)` 地址，不带查询串、片段或它自己的凭据，且路径以 `/` 结尾。那段路径就是本部署的 API 前缀，也就是前端自己的 `VUE_APP_BASE_URL`：标准安装编译出 `/ini-server/`，而编译时没有前缀的安装把 API 发布在源站根上。每次读取都是把基址整段保留、再把服务路径接在后面拼出来的，绝不是拿一个地址去解析另一个——一旦被接的那半以 `/` 开头，解析就会把 API 前缀整段丢掉，请求于是落到服务器根上。基址由调用方在加载期检查，因为在这里被拒的地址会变成每读一次被拒一次，而不是每组合一次被拒一次。

<a id="whom-a-read-is-for"></a>
## 一次读取替谁读

每个读取方法和 `holdsCredential` 都有一个必填的第一个参数 `subject: BizSubject`（主体），点名这次读取花的是谁的令牌。工具调用点名 `{ kind: 'session', sessionId }`，取它所在的 `exec.agent.id`；没有 `exec.agent` 的调用没有主体，什么都不读，各个消费方用各自的话拒掉它。webServer 路由点名 `{ kind: 'principal', principal }`，取自 `subjectOfRequest(req)`；它答 `undefined` 时，这个请求没有点名解析器认得的任何人，路由什么都不读，答 401。

```ts
import type { IncomingMessage } from 'node:http'
import type { BizBackendService, BizSubject } from '@deepseek-ai/dsh-experimental-biz-backend'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare const backend: BizBackendService
declare const sessionId: SessionId
declare const req: IncomingMessage

const forToolCall: BizSubject = { kind: 'session', sessionId }
const forRequest: BizSubject | undefined = backend.subjectOfRequest(req)
```

`PrincipalKey`（主体键）是 `@deepseek-ai/dsh-brand` 的 `Branded<'PrincipalKey'>`：一个不透明的键，不进模型、不进日志、不上传。它归控制台成员目录 `@deepseek-ai/dsh-experimental-console-members` 所有，那边把它声明成这个品牌，值是这个人的 `login_uid`（那个包还没进这条线）；这里导出的是同一个类型，因为 `dsh-brand` 给每个键打品牌都用同一个符号，于是成员目录发出的键这个服务直接收，不必转换。

一个主体花哪个槽，只由解析器回答。`resolve(subject)` 答这个主体自己的槽，或者 `undefined`；`undefined` 和一个没有令牌的槽都答 `unauthenticated`，请求根本不发，也不会拿别的槽的令牌顶上。每次读取只解析一次主体，后端拒绝时丢掉的就是它解析到的那个槽，而且只在那个槽里仍是被拒的那次读取出示的令牌时才丢；别的槽一个都不碰。`principalOfRequest(req)` 是解析器对「这个浏览器请求是以谁的身份被放进来的」的回答，`subjectOfRequest` 把它包成一个 principal 主体。auth-gate 的解析器每个进程只握一个槽，所以每个主体都解析到它，每个请求都点名这个进程服务的那一个人。按控制台成员各握一个槽的解析器，必须把 `principalOfRequest` 委托给 `consoleMembers.principalOfRequest(req)` 来答，这样「一个请求点名的是谁」就只有成员目录这一个来源：路由不自己读身份头，也不自己调 `connection.admit`，只经由 `subjectOfRequest` 拿到成员。

<a id="the-six-reads"></a>
## 这六次读取

| 方法 | 读到什么 |
|---|---|
| `search(subject, request, signal)` | 一个资源模型的一页行，同一批行给两遍——`rawValue` 是存储值，`displayValue` 是本部署展示给人看的值——外加跨所有页的总数。 |
| `describe(subject, meta, signal)` | 一个资源模型的属性，同时给出行所用的键名和展示给人看的名字，外加存储类型、长度、一行能不能留空、是不是行的标识、缺省值、表单分组，以及本部署对它记了什么。 |
| `describeScheme(subject, meta, signal)` | 一个资源模型的默认查询方案：本部署自己的资源清单打开这个模型时用的那几列，每列给出属性名，外加方案里带的表头、是否展示、是否可排序。 |
| `describeSchemes(subject, meta, signal)` | 同一个模型存下的全部默认方案：每个方案的类别、它的表单画到的每个属性——带标签、必填位、可编辑位、是否展示位、它提供的固定取值、以及它取哪个模型的行——和它的表格列出的那些列。 |
| `listModels(subject, signal)` | 本部署的整份资源模型目录：每个模型的英文名、给人看的名字、归在哪个专业下、行存在哪张表、它继承哪个模型，以及本部署对它记了什么。 |
| `userRights(subject, signal)` | 这个主体对应的登录者可以做什么：每个模型一行，点名授予的操作和编辑被收窄到哪些属性，外加权限表陈述的每一条取值收窄。 |

`describeScheme` 把 schema 服务收窄到一个方案——资源清单那一类里标了默认的那个——再从这个方案的表格里读出列。它的两个是否位取决于方案是怎么保存的，可能是字符 `'0'`/`'1'`，也可能是 JSON 布尔，两种读法都接受；用别的写法写的位一律按未陈述发布，于是调用方能把「方案把这列藏了」和「方案对这列什么都没说」分开。没有点名属性的列被剔掉；答复里没有方案——或者方案里每一列都没点名属性——就是失败 `unreachable`，detail 为 `the model has no default query scheme`。

`listModels` 是一次请求一个答案：那个端点列的是整份目录而不是其中一页，于是没有哪个调用方会只拿到一部分却以为拿到了全部。每个条目上都挂着那个模型的完整描述，而一样都不留——调用方收到的就是上面那八个字段，别的没有，这正是一份上千模型的目录不必按它抵达时的那几兆字节被带来带去的原因。目录里一个模型都没有算答案不算失败：对于这个部署不存行的那几类资源，这个端点本来就这么答。

`describeSchemes` 永远点名模型。同一个端点在不点名时会把本部署存下的每一个方案都答回来，那是几十兆字节，也不是任何调用方的问题。一个模型缺某一类方案是本部署的常态——它自己的前端会据此把按钮关掉——所以空方案列表同样是答案。

`userRights` 只够到权限子树，别的都不碰。同一个答案里带着当前登录者的个人资料——账号、工号、手机号、邮箱——而这个读从不把其中任何一项拷进发布值，于是下游没有任何一方拿得到它去摆在模型面前、写进会话日志、或者在失败里复述。权限行是逐键读的而不是照一张固定操作表读，因为这个部署是靠加键来扩这张表的，固定表会把以后新增的操作悄悄丢掉；操作按码位序答回。

还有第七个方法什么都不读：`holdsCredential(subject)` 回答这个主体解析到的槽里有没有令牌。它是为「读之前先问人」的调用方准备的，好让一次本进程做不到的读取不必先去问谁答不答应。它对下一次调用不作任何承诺——后端可能在这中间就把令牌拒了，而每次调用本来就会自己答 `unauthenticated`。

第八个方法同样什么都不读：`judge(rights)` 把一次 `userRights` 调用的答复变成 `may(model, operation)`，操作共七个——`read`、`metadata_read`、`create`、`update`、`delete`、`import`、`export`，即本部署后端计划据以校验的操作码。它按构造服务时给的规则表来判，每个操作一条规则：要么是 `row`，意思是权限表里有这个模型的一行即可；要么是权限表自己的标志名列表，那一行必须至少授予其中一个。缺省表以 `BizOperationRules` 这个 schema 导出，就是这个后端今天实际校验的规则：它对每个账号——管理员也一样——把 `search`、`imp`、`exp`、`gridexp` 都写成 `null`，只校验 `add`、`update`、`delete`，所以 `read`、`metadata_read`、`export` 是 `row`，三种写分别是 `[add]`、`[update]`、`[delete]`，`import` 是 `[add, update]`。哪天后端开始校验某个标志，部署只改那一条规则——`export: [exp]`——别的都不动。它失败即关闭：读取失败（包括一个任何授权都没有的账号收到的 HTTP 400 code 1）和一张一个模型都没点名的权限表什么也不允许，权限表里没有那一行的模型同样什么也不允许。凡是代登录者隐藏或拒绝什么的消费方都只用这一个方法来判，于是谁都不另存一份规则。

是具名方法而不是一条 `fetch(path, init)` 管道，因为同一个前缀下还挂着 `PUT /api/resources/{model}/{id}`、`DELETE /api/resources/{model}/{id}` 和 `POST /api/batchresources/delete/{model}`。一条通用管道等于把访客的凭据连同这些端点一起交给同进程的每一个插件。这里什么都不写，也没有调用方能自己挑路径：不是单个裸名字的模型名在任何请求发出之前就被拒，所以一个含 `/` 或 `..` 的名字没法把带凭据的请求引到邻近的端点上。

补默认值只发生在一处显式步骤里，位于调用方陈述的请求和真正上线的文档之间——`matchMode` 变成 `AND`，未陈述的分页变成第一页 200 行，`asc` 与 `desc` 变成 null，`conditions` 变成空——于是一个未陈述的字段会变成什么，只在一个地方读得到。陈述了 `source` 的调用方拿到的是那些属性外加后端自己的行标识：本部署的客户端会往每一份发出的 `source` 前面插一个 `int_id`，后端也就不管调用方问没问都把它答回来。不能展示自己没点名的列的消费方，得自己把这个多出来的键去掉。

条件没匹配上任何行的读取算零行，不算读不懂的答复。实测这个后端报告这种情况用的是两份行列表都显式为 null、旁边总数也为 null，而不是两份空列表，所以 `search` 只对这一种信封答 `{ rawValue: [], displayValue: [], total: 0 }`。载荷不是对象、行列表在场却不是由行对象组成的列表、以及两份行列表一个都不带，三种都答 `unreachable`：这条缝从没实测收到过的信封，不是拿来报行数的信封。

这三次读取就是本部署自己的那三次，只去掉它的网页为自己加的三样：不带防缓存的查询参数，不把浏览器存的用户资料摊成请求头，事后也不补一条操作记录——补一条等于往本部署的审计轨迹里写一次它的用户从没做过的操作。

<a id="how-the-credential-is-spent"></a>
## 这枚凭据怎么花

`Authorization` 与 `CertificationToken` 两个头都写 `Bearer <token>`：与本部署自己的网页发出的字节相同——那个页面存的是 `"Bearer <jwt>"`，并把存储原值逐字塞进这两个头，而调用方持有的是裸 JWT。`CertificationToken` 只是这个后端读取令牌的方式，不是第二枚凭据。别的能标识浏览器的东西一概不发——不带 cookie，也没有任何由令牌之外的东西派生出来的请求头。

<a id="nothing-throws"></a>
## 什么都不抛

每次调用要么给出结果，要么给出一个闭合失败联合里的成员：`unauthenticated`（没有替这次调用的主体持有令牌，请求根本没发）、`refused`（后端拒的是这枚凭据本身）、`rejected`（后端答了，答的是不行）、`unreachable`（这条缝读不到答复——请求没发出去、没到达，或回来的是别的东西）。消费方按标签 `switch` 并以 `assertNever` 收口，于是日后新增的成员会让它的构建失败，而不是从缺口漏过去。

拿主意的是答复里的结果码，不是单看状态：这个后端会用 HTTP 200 加一个非零码来拒绝一次请求，所以只信状态的消费方会把一次拒绝读成数据。另有两种答复会让调用方交出令牌，走的是这次调用的主体解析到的那个槽的 `drop`：HTTP 401，以及任何带结果码 2 或 3 的失败状态。后一种沿用本部署自己的客户端：它只在错误路径上因这两个码交出存储的令牌——它的成功路径在 HTTP 200 上报告非零码并保留令牌——所以同一个码在 200 上意味着一次请求被拒，在失败状态上意味着这枚凭据被拒。HTTP 403 不在其中：那个客户端把它读成这次请求被拒绝访问，并保留存储的令牌，所以 403 和别的失败状态一样按信封分类，只有在带着码 2 或 3 时才交出凭据。槽里已经不是被拒的那次调用出示的令牌时，这两种答复都不丢它：调用在途时浏览器已经续期换上了新令牌，新令牌没有出示过。

没有任何一个失败带上凭据、完整请求 URL 或后端的排障标识——失败会被报告给模型并写进会话日志，这三样哪一处都不该去。后端说的话在转述给调用方之前，会先按名字把出示过的凭据抠掉，再截到 120 个字符；只截长度守不住这个承诺，因为一个在前一百个字符里就把令牌说回来的后端能照样通过。

## Model Experience

None, as this package registers no tool, prompt section, or result: it performs six HTTP reads and one judgement for whichever row consumes the service, and every model-visible effect of those rows belongs to them.

#### KV Cache effect

无关：本包不发起模型请求，也不往请求里加任何东西，所以没有请求前缀发生变化，也没有已可复用的前缀被作废。

## Known Limitations and Deferred Work

- **按行裁剪只能指望后端，而这一条未经证实。** 本部署前端有一层行列权限，但它在找不到已登录用户资料时是放开而不是收紧，所以它根本不是这边可以依赖的边界。后端若不按出示的令牌收窄行，一次读取就可能把这个人不该看到的行画上他的屏幕、写进他的会话日志——而登出并不清洗已经写下的日志。
- **HTTP 200 上的 `code 3` 在这里算业务拒绝，不算凭据被拒。** 带这个码的失败状态确实会交出令牌，但一个把令牌过期报成 HTTP 200 加 `code 3` 的后端，会继续被出示那枚令牌，每次读取都答 `rejected`。200 这条路是有意不动的：本部署自己的成功拦截器在那里同样保留令牌，猜反了就会在一次普通业务拒绝上丢掉一枚还活着的凭据。
- **不复刻控制台的按模型地址覆盖。** 本部署前端有一份运行期注册表，能把某个模型的查询指到它自己的地址上，而这一侧没有注册方。这样配置过的模型会在默认地址上被读取，那里未必是控制台读的那份。触发器是第一次读出来的行与页面对不上。
- **组合里的每一行都能用这个服务。** `ctx.bizBackend` 在上下文上具名，所以与构造它的那一行一同加载的任何插件，都能以这位已登录访客的身份读本部署的数据。这些具名方法之窄就是这条边界的全部；谁可以调用它们是组合的决定，而第三方插件默认不声明任何审批闸。主体由调用方自己点名，这里不核对调用方是不是在替它点名的那个主体办事：一个拿到别的会话 id 或别人主体键的插件，只要解析器替那个人握着槽，就能以那个人的身份读。令牌本身仍够不着——它握在调用方的闭包里，没有作为任何服务发布。
- **这条缝只有读。** 没有新增、修改、删除，加一个也不是再写一个方法的事：一次写入是把一个人的凭据花在改动他自己的系统上，那需要它自己的同意问句和它自己的记录，两样这里都没有。
- **组装快照只握一个槽。** [`snapshots/console`](../../../snapshots/console/README.zh.md) 泳道组合了 auth-gate，并把 `bizUpstream` 指向套件自己起的假数据后端，所以它的数据源场景和 `system_map` 场景都端到端经过本服务读取，每个主体都解析到 auth-gate 唯一的那个槽；没有快照组合每人各握一个槽的解析器。快照之外，本服务由本包自己的用例覆盖，并由 `apps/web/tests/component-surface-datasource.e2e.ts` 里针对真实组合的 Playwright 场景覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
