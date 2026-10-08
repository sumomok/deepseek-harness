---
description: "控制台成员目录 ctx.consoleMembers：一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，每位成员已登记的根目录，以及按成员保存的非秘密数据；包括供替某一位成员办事的控制台线插件使用的类型声明，以及将要提供这个目录的插件行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

[English](README.md) | 中文

## 概述

让控制台线插件按 `ctx.consoleMembers` 写类型：问一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，列出这位成员已登记的根目录，并按成员保存非秘密数据。`/types` 入口导出目录的类型并声明这个 context 键。包根是将要提供这个目录的插件行；它在加载时核对配置、打开根目录登记表，目前还不提供服务，所以 `inject: ['consoleMembers']` 会一直挂起。

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

`principalOfRequest` 是 fork 的 webServer 路由取得请求背后成员的唯一方式：路由不自己读身份头，也不自己调 `connection.admit`。`principalOfSession` 沿子会话的父链追到最上层的会话，`attachCustomerCredentials` 同一时刻只持有一个客户 token 读取器，且没有方法交出它。[子系统页](../../../docs/subsystems/console-members.zh.md) 解释这三条规则；[`src/types.ts`](src/types.ts) 写明每个方法的契约。

`PrincipalKey`（主体键）是 `@deepseek-ai/dsh-brand` 的 `Branded<'PrincipalKey'>`，值是成员的 `login_uid`。消费方把它当作不透明的值，它不进模型请求、不进日志、不上传。

### 配置插件行

插件行是 `name: '@deepseek-ai/dsh-experimental-console-members'`，注入 `connection`。没有字段是 volatile；部署方把它们写在锁层。

| 字段 | 默认 | 含义 |
|---|---|---|
| `assertionHeader` | `'x-dsh-member'` | 携带签名成员断言的请求头；按小写比较 |
| `assertionPublicKey` | 必填 | SPKI PEM 形式的 Ed25519 公钥（`-----BEGIN PUBLIC KEY-----`） |
| `deploymentId` | 必填 | 断言的 `aud` 必须等于的值 |
| `admins` | `[]` | 每位管理员的 `login_uid` |
| `membersRoot` | 必填 | 存放每位成员根目录的绝对路径目录 |
| `sharedReadRoots` | `[]` | 所有成员都可读的绝对路径 |
| `rootSeeds` | `[]` | `{ path, principal }` 或 `{ path, owner: 'none' }`，并入根目录登记表 |
| `hostReadPaths`、`hostWritePaths` | `[]` | 没有当前成员时，读或写可以到达的绝对路径前缀 |
| `peerIdleMs` | `600000` | 空闲的成员 Peer 保持打开的毫秒数；正整数 |

加载在第一项没通过的核对处失败，此时插件行还没有注册任何东西：上表的字段（绝对路径、请求头名、非空的 `login_uid` 字符串、每个种子恰好是一种形式）；密钥，必须是 Ed25519 公钥，所以私钥被拒；Connection 的 `requireAdmitter`，必须是 `true`；以及种子并入根目录登记表。加载错误不引用任何 `login_uid`，也不引用密钥。

根目录登记表是 `$DSH_HOME/console-members` 下的 `roots.json`，把每个已登记的根目录对应到一位成员或「无人」。根目录按文件系统读它的方式比较：每个路径最长的已存在前段换成它的真实路径，在 macOS 与 Windows 上再忽略大小写与 Unicode 规范形式。任意两个根目录既不是同一目录、也不互相包含，种子不与 `membersRoot` 重叠，种子点名的目录已登记给别的所有者时加载失败。成员的根目录是 `<membersRoot>/<随机 UUID>`，以 0700 权限创建，并在这位成员的准入继续之前记下；按成员的数据存在 `$DSH_HOME/console-members/<目录 id>/<unit>.json`，所以没有路径带主体键。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`src/types.ts` 放类型声明和一处 `declare module '@deepseek-ai/cordis'` 合并，它给 `Context` 加上 `consoleMembers: ConsoleMemberDirectory`；包根再导出这些类型并导出插件。目前还没有准入器、目录服务或守卫调用登记表与默认工作区登记步骤。

| 文件 | 内容 |
|---|---|
| [`src/types.ts`](src/types.ts) | `PrincipalKey`、`ConsoleMemberDirectory`、`MemberStore`、`CustomerCredentialReader`，以及 `Context` 合并；即 `/types` 入口 |
| [`src/index.ts`](src/index.ts) | 包根：插件的 `name`、`inject`、`Config` 与 `apply`，以及类型再导出 |
| [`src/config.ts`](src/config.ts) | Config 模式、字段核对、密钥核对与 `requireAdmitter` 核对 |
| [`src/load.ts`](src/load.ts) | 按顺序执行的加载核对 |
| [`src/registry.ts`](src/registry.ts) | `roots.json`、种子合并、首次见到成员时的成员根目录、`memberRoot`、`rootsOf` 与 `memberStore` |
| [`src/paths.ts`](src/paths.ts) | 根目录路径的比较形式 |
| [`src/member-store.ts`](src/member-store.ts) | 按成员的 JSON 文件，经 rename 整份替换 |
| [`src/default-workspace.ts`](src/default-workspace.ts) | 每位成员在每个进程里一个默认工作区登记步骤，以及它是否已成功 |

登记表同步写 `roots.json`：先以独占创建、0600 权限写一个随机后缀的同目录文件，再 rename 过去，因为记下首次见到的准入器是同步的。成员的默认工作区 `<成员根目录>/workspace` 由准入之后的登记步骤登记：先建目录，再调 `workspace.create`，它对同一路径返回已登记的工作区。登记步骤失败时写一行不带主体键、不带失败文本的日志，下一次调用重新开始；在当前进程里有一次登记步骤成功之前，这位成员的默认工作区算作未就绪。

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

- **插件行还不提供目录。** 插件核对配置并打开根目录登记表，但不装成员准入器，也不提供 `ctx.consoleMembers`。注入它的插件永远不会启动，`ctx.get('consoleMembers')` 答 `undefined`。[`src/types.ts`](src/types.ts) 里的方法契约约束的是这个插件行将要提供的目录。
- **首次见到成员时写盘失败会留下空目录。** 成员根目录建好之后 `roots.json` 替换失败时，这位成员仍未登记，空的 `<membersRoot>/<UUID>` 留在原处；下一次首次见到时再建一个。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
