---
description: "控制台成员目录 ctx.consoleMembers：一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，每位成员已登记的根目录，以及按成员保存的非秘密数据；包括供替某一位成员办事的控制台线插件使用的类型声明，以及提供这个目录、并把每个请求准入为其签名断言所点名成员的插件行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

[English](README.md) | 中文

## 概述

让控制台线插件按 `ctx.consoleMembers` 写类型：问一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，列出这位成员已登记的根目录，并按成员保存非秘密数据。`/types` 入口导出目录的类型并声明这个 context 键。包根是插件行：加载时核对配置、打开根目录登记表，然后提供 `ctx.consoleMembers` 并安装 Connection 的 Peer 准入器，把每个请求准入为其签名断言所点名的成员。`/credential-access` 入口读取成员的客户 token 与已登记成员。这一版里 `principalOfSession` 会抛错。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 什么时候用

替某一位控制台成员办事的宿主插件导入这些类型：为请求背后的成员作答的 webServer 路由、为调用方作答的 Remote 方法，或花用某个会话所有者数据的工具。你发布出去的声明里点名了它的类型时，把它声明为对等依赖（peer dependency）；只有你自己的源码用到时，声明为开发依赖。

### 入口

从 `@deepseek-ai/dsh-experimental-console-members/types` 导入这些类型。从这个入口导入任何东西（包括 `import type {}`）都会加载 `Context` 声明，于是 `ctx.consoleMembers` 和 `ctx.get('consoleMembers')` 都能通过类型检查：

```ts
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members/types'

declare const ctx: Context
declare const req: IncomingMessage

const member: PrincipalKey | undefined = ctx.consoleMembers.principalOfRequest(req)
```

`/types` 入口不导入任何宿主入口，所以宿主插件和客户端程序都从它导入。包根再导出同样的类型，但包根是插件、会导入宿主入口；客户端程序从不导入包根。

`principalOfRequest` 是 fork 的 webServer 路由取得请求背后成员的唯一方式：路由不自己读身份头，也不自己调 `connection.admit`。`principalOfSession` 沿子会话的父链追到最上层的会话，`attachCustomerCredentials` 同一时刻只持有一个客户 token 读取器，`ctx.consoleMembers` 没有方法交出它。[子系统页](../../../docs/subsystems/console-members.zh.md) 解释这三条规则；[`src/types.ts`](src/types.ts) 写明每个方法的契约。

`PrincipalKey`（主体键）是 `@deepseek-ai/dsh-brand` 的 `Branded<'PrincipalKey'>`，值是成员的 `login_uid`。消费方把它当作不透明的值，它不进模型请求、不进日志、不上传。

### 客户 token 与已登记成员

token 持有方（开了 `shareWithMemberDirectory` 的 auth-gate）在自己的 `ctx.effect` 里调 `ctx.consoleMembers.attachCustomerCredentials(reader)`，并在这个 effect 的清理里执行返回的 disposer。插件行同一时刻只持有一个读取器：已挂着时再挂抛错，disposer 执行之后可以挂另一个。执行 disposer 等于每位成员的 token 都已丢弃，读取器不为此报 `dropped`。disposer 只生效一次：先停止读取和转发这个读取器，再同步调用每个 `onDetached` 监听者，然后才腾出位置，所以在 `onDetached` 监听者里挂读取器会被拒。同一个 disposer 重复调用或迟到调用都不再通知任何人，也不动在那之后挂上的读取器。读取器在 `onChange` 订阅过程中报告的变化不转发，因为 `onChange` 返回之后读取器才算挂上。

控制台线的凭据来源经 `@deepseek-ai/dsh-experimental-console-members/credential-access` 读取 token。它的源码导入 Host 模块，所以只有 Host 插件导入它；Client 程序导入 `/types`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { customerCredentialAccess, memberRegistryAccess } from '@deepseek-ai/dsh-experimental-console-members/credential-access'

declare const ctx: Context

const tokens = customerCredentialAccess(ctx.consoleMembers)
const registry = memberRegistryAccess(ctx.consoleMembers)
ctx.effect(() => tokens.onDetached(() => { /* discard what was derived from every token */ }), 'credential source: reader detached')
ctx.effect(() => registry.onAdded((member) => { void member }), 'credential source: member added')
const everyMember = registry.principals()
```

`read(principal)` 答已挂读取器里的 token；没有读取器挂着，或它的 disposer 已经开始时答 `undefined`。`onChange` 转发已挂读取器的 `set` 与 `dropped`，跨越撤下与重挂一直有效；某个读取器的 disposer 一开始，就没有监听者再收到这个读取器的变化，正在转发的那一次也一样。`onDetached` 监听者不得读取 token：持有方可能在执行 disposer 之前已经吊销了读取器，而且 `read` 此时已经答 `undefined`。`principals()` 列出至少准入过一次的每位成员，包括当前没有打开 Peer 的成员；只被某条 `rootSeeds` 点名的主体在首次准入时加入。`onAdded` 报告这次首次准入，同步发生在这位成员的 Peer 打开之前，之后不再为这位成员报告；登记表没有移除。每个 `onChange`、`onDetached` 与 `onAdded` 都返回普通的 disposer，所以调用方在自己的 `ctx.effect` 里注册；已经在进行的一次通知仍会调用在通知过程中被移除的监听者。抛错的监听者被记入日志，但不记它的错误或成员，其余监听者照常调用。

访问对象绑定在创建它的那个插件行实例上，所以在注入 `consoleMembers` 的那个作用域里创建它；插件行重新加载之后要重新创建访问对象。插件行卸载时，这个作用域与持有方的作用域按它们的加载方式决定释放先后，所以在这个作用域里注册的 `onDetached` 监听者可能始终不被调用；这个作用域自己的清理也算每位成员的 token 都已丢弃。`/credential-access` 是读取 token 的带类型途径，不是保密边界：目录把插件行的状态（包括读取器）挂在一个 symbol 下，`ctx.consoleMembers` 会把它原样透过，所以握有目录的任何插件都能拿到 token，也能替换这份状态。同一进程里的插件是受信任的；只挂一个读取器的规则决定由哪个读取器提供 token，不决定谁能经它读取。

### 配置插件行

插件行是 `name: '@deepseek-ai/dsh-experimental-console-members'`，注入 `connection` 与 `workspaceRegistry`。没有字段是 volatile；部署方把它们写在锁层。

| 字段 | 默认 | 含义 |
|---|---|---|
| `assertionHeader` | `'x-dsh-member'` | 携带签名成员断言的请求头；按小写比较。必须是部署代理从客户端请求中剥掉并签上的那个头名；server-base 的代理用的是 `x-dsh-member` |
| `assertionPublicKey` | 必填 | SPKI PEM 形式的 Ed25519 公钥（`-----BEGIN PUBLIC KEY-----`） |
| `deploymentId` | 必填 | 断言的 `aud` 必须等于的值 |
| `admins` | `[]` | 每位管理员的 `login_uid` |
| `membersRoot` | 必填 | 存放每位成员根目录的绝对路径目录 |
| `sharedReadRoots` | `[]` | 所有成员都可读的绝对路径 |
| `rootSeeds` | `[]` | `{ path, principal }` 或 `{ path, owner: 'none' }`，并入根目录登记表 |
| `hostReadPaths`、`hostWritePaths` | `[]` | 没有当前成员时，读或写可以到达的绝对路径前缀 |
| `peerIdleMs` | `600000` | 没有 Remote 流 socket 的成员 Peer 在最后一次请求或最后一条 socket 关闭之后保持打开的毫秒数；1 到 2147483647 之间的整数，上限是 `setTimeout` 能接受的最长延迟 |

加载在第一项没通过的核对处失败，此时插件行还没有注册任何东西：上表的字段（绝对路径、请求头名、`admins` 与 `rootSeeds` 写成列表、非空的 `login_uid` 字符串、每个种子恰好是一种形式）；密钥，必须恰好是一个 Ed25519 公钥块，所以私钥被拒，无论单独写还是跟在公钥之后；Connection 的 `requireAdmitter`，必须是 `true`；以及种子并入根目录登记表。加载错误不引用任何 `login_uid`，也不引用密钥。

根目录登记表是 `$DSH_HOME/console-members` 下的 `roots.json`，把每个已登记的根目录对应到一位成员或「无人」。根目录按文件系统读它的方式比较：每个路径最长的已存在前段换成它的真实路径，在 macOS 与 Windows 上再忽略大小写与 Unicode 规范形式。任意两个根目录既不是同一目录、也不互相包含，种子不与 `membersRoot` 重叠，`membersRoot` 与任何根目录都不与存放 `roots.json` 和按成员数据的 `$DSH_HOME/console-members` 重叠，种子点名的目录已登记给别的所有者时加载失败。成员的根目录是 `<membersRoot>/<随机 UUID>`，以 0700 权限创建，并在这位成员的准入继续之前记下；按成员的数据存在 `$DSH_HOME/console-members/<目录 id>/<unit>.json`，所以没有路径带主体键。

### 成员准入

部署代理在它转发的每个 HTTP 请求和 WebSocket upgrade 上，以 `assertionHeader` 为名签一份成员断言。值是 `v1.<载荷>.<签名>`：`<载荷>` 是 UTF-8 JSON 对象 `{"p","aud","exp"}` 的无填充 base64url 形式，其中 `p` 是成员的 `login_uid`，`aud` 是部署 id，`exp` 是断言失效的 Unix 秒；`<签名>` 是对 ASCII 文本 `v1.<载荷>` 的 Ed25519 签名的无填充 base64url 形式。插件行只在以下条件全部成立时准入一个请求：这个头只出现一次；值匹配 `^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`（Node 用逗号合并的重复头不匹配）；签名能用 `assertionPublicKey` 验过；载荷是恰好含 `p`、`aud`、`exp` 三个键的 JSON 对象，`p` 是非空字符串，`exp` 是整数；`aud` 等于 `deploymentId`；当前 Unix 秒早于 `exp`。不留时钟误差，也不限制 `exp` 的上限。其余请求一律答 401，带着有效 dsh 浏览器 cookie 的请求也一样；准入在插件行内部失败的请求（例如首次见到的成员根目录登记不了）同样答 401。

一位成员在 Peer 活着时只有这一个 Peer，所以这位成员的每个请求、同一请求的每次重复准入，都经同一个 Peer。成员的 Peer 自最后一次请求或最后一条 socket 关闭起 `peerIdleMs` 内没有绑定 Remote 流 socket，插件行就释放它，这段时间按单调时钟计，所以把系统时钟往回或往前调都不会推迟或提前释放；这位成员的下一个请求开一个新 Peer。卸载插件行时撤下准入器，释放它开过的全部 Peer（这些 Peer 的 socket 以 1001 关闭），并等所有进行中的默认工作区登记落定之后才完成；`requireAdmitter: true` 下，Connection 在插件行再次加载之前答 401。

`principalOfCaller` 对 operator、不是本插件行开出的 Peer、已释放的成员 Peer 都答 `undefined`；是否已释放按 `ctx.connection.peers.get(peer.id) === peer` 判定。插件只能用 `peer === ctx.connection.operator` 认出 operator；成员为 `undefined` 从不表示 operator。插件行的日志与错误文本不带主体键、断言或头值：准入失败的日志至多带一个系统错误码，抛错的 `onChange` 监听者既不记它的错误，也不记成员。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`src/types.ts` 放类型声明和一处 `declare module '@deepseek-ai/cordis'` 合并，它给 `Context` 加上 `consoleMembers: ConsoleMemberDirectory`；包根再导出这些类型并导出插件。`src/install.ts` 在一次同步调用里依次注册目录服务、跟踪成员 Peer 及其 socket 的监听器、卸载时释放本插件行 Peer 的处理，最后是准入器；Cordis 按注册的逆序启动各个 disposer，所以卸载时最先撤下准入器。目录的状态挂在 `src/internal-state.ts` 的一个 symbol 下，因为 `ctx.consoleMembers` 是可追踪代理，它的方法以代理为 `this` 运行。`./credential-access` 经同一个 symbol 读取状态，所以 `tsdown.config.ts` 在一次构建里打包包根和这个入口，把 `src/internal-state.ts` 放进两者共同导入的一个 chunk；任一入口单独构建都会生成第二个 symbol，`tests/built-entries.e2e.ts` 在构建产物上检查这一点。

| 文件 | 内容 |
|---|---|
| [`src/types.ts`](src/types.ts) | `PrincipalKey`、`ConsoleMemberDirectory`、`MemberStore`、`CustomerCredentialReader`，以及 `Context` 合并；即 `/types` 入口 |
| [`src/index.ts`](src/index.ts) | 包根：插件的 `name`、`inject`、`Config` 与 `apply`，以及类型再导出 |
| [`src/config.ts`](src/config.ts) | Config 模式、字段核对、密钥核对与 `requireAdmitter` 核对 |
| [`src/load.ts`](src/load.ts) | 按顺序执行的加载核对 |
| [`src/install.ts`](src/install.ts) | 加载后的插件行按顺序注册的内容 |
| [`src/assertion.ts`](src/assertion.ts) | 成员断言的验签 |
| [`src/peers.ts`](src/peers.ts) | 成员 Peer 表、准入器、socket 跟踪与空闲关闭 |
| [`src/directory.ts`](src/directory.ts) | `ctx.consoleMembers` 服务 |
| [`src/internal-state.ts`](src/internal-state.ts) | 目录状态所挂的 symbol，以及从目录或其代理读出这份状态 |
| [`src/credentials.ts`](src/credentials.ts) | 客户 token 读取器的位置：挂上、撤下、读取与转发变化 |
| [`src/credential-access.ts`](src/credential-access.ts) | `/credential-access` 入口：`customerCredentialAccess` 与 `memberRegistryAccess` |
| [`src/listeners.ts`](src/listeners.ts) | 监听者集合，抛错的监听者记日志时不带它的参数 |
| [`src/registry.ts`](src/registry.ts) | `roots.json`、种子合并、首次见到成员时的成员根目录及其监听者、已登记成员、`memberRoot`、`rootsOf` 与 `memberStore` |
| [`src/paths.ts`](src/paths.ts) | 根目录路径的比较形式 |
| [`src/member-store.ts`](src/member-store.ts) | 按成员的 JSON 文件，经 rename 整份替换 |
| [`src/default-workspace.ts`](src/default-workspace.ts) | 每位成员在每个进程里一个默认工作区登记步骤，以及它是否已成功 |

登记表同步写 `roots.json`：先以独占创建、0600 权限写一个随机后缀的同目录文件，再 rename 过去，因为记下首次见到的准入器是同步的。成员的默认工作区 `<成员根目录>/workspace` 由准入之后的登记步骤登记：先建目录，它的真实路径是别的目录（那里是一个符号链接）时拒绝，再调 `workspace.create`，它对同一路径返回已登记的工作区；登记到别的路径的工作区同样让这一步失败。登记步骤失败时写一行不带主体键、不带失败文本的日志，下一次调用重新开始；在当前进程里有一次登记步骤成功之前，这位成员的默认工作区算作未就绪。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [控制台成员目录](../../../docs/subsystems/console-members.zh.md)——请求、父链和客户 token 三条规则。
- [`dsh-experimental-biz-backend`](../biz-backend/README.zh.md#whom-a-read-is-for)——经 `principalOfRequest` 点名请求背后成员的凭据解析器。
- [Client connection](../../client/connection/README.zh.md)——`principalOfRequest` 所跑的 Peer 准入，以及 `requireAdmitter`。

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册工具、提示词段落或会话事件，它的插件行也不往模型请求里加任何东西。

#### KV Cache 影响

插件行不增加模型输入，因此不影响提供方的缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **`principalOfSession` 未实现。** 这一版里它会抛错，所以查询会话所属成员的插件会失败，而不是当作没有成员继续办事。[`src/types.ts`](src/types.ts) 里的方法契约约束它的实现。
- **撤销成员没有入口。** 这一版里没有任何办法终止一位成员的访问。客户系统撤销账号之后，这位成员的 HTTP 请求要等最后一份已签断言过期才被拒，因为部署代理给每个请求签的断言有效期是 `ASSERTION_LIFETIME_SECONDS`（`server-base` 里是 120 秒）。已经绑定在这位成员 Peer 上的 Remote 流 WebSocket 不会关闭，在它关闭之前继续以这位成员的身份办事；Peer 在它最后一次准入与最后一条 socket 关闭两者中较晚的那个时刻之后再过 `peerIdleMs` 才被释放；撤销之前签出的断言在过期之前仍能准入请求。
- **`admins`、`sharedReadRoots`、`hostReadPaths` 与 `hostWritePaths` 现在不约束任何东西。** 加载时会核对它们（绝对路径、非空的 `login_uid` 字符串），这一版里别处都不读它们：没有成员因此获得管理员权限，`sharedReadRoots` 不授予任何读取，宿主的读写也不受 `hostReadPaths` 或 `hostWritePaths` 限制。
- **还没有按成员裁决 Remote 调用、路由或事件。** 插件行没有注册 `remote/invoke` 或 `connection/fetch` 监听器，也没有 `$events` 过滤器。准入器装上之后，Connection 对精确路由与专用通道答 503，Gateway 对每个 Remote 调用答 `gateway/service-unavailable`，`$events` 不投递任何事件。
- **首次见到成员时写盘失败会留下空目录。** 成员根目录建好之后 `roots.json` 替换失败时，这位成员仍未登记，空的 `<membersRoot>/<UUID>` 留在原处；下一次首次见到时再建一个。
- **替换 `roots.json` 时进程被杀会留下临时文件。** 写完 `roots.json.<随机十六进制>.tmp`、rename 之前进程被杀，这个 0600 权限的文件留在 `$DSH_HOME/console-members` 里；它与 `roots.json` 一样含路径和主体键，没有谁删除它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
