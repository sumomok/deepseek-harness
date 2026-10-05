---
description: "ctx.consoleMembers（控制台成员目录）的 TypeScript 声明：一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，每位成员已登记的根目录，以及按成员保存的非秘密数据；供替某一位成员办事的控制台线插件使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

[English](README.md) | 中文

## 概述

让控制台线插件按 `ctx.consoleMembers` 写类型：问一个浏览器请求、一个 Remote 调用方或一个会话属于哪位已登录成员，列出这位成员已登记的根目录，并按成员保存非秘密数据。本包导出目录的类型并声明这个 context 键。它不注册插件，所以 `inject: ['consoleMembers']` 会一直挂起，直到加载了提供这个目录的插件。

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

从包根导入任何一个类型都会加载 `Context` 声明，于是 `ctx.consoleMembers` 和 `ctx.get('consoleMembers')` 都能通过类型检查：

```ts
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members'

declare const ctx: Context
declare const req: IncomingMessage

const member: PrincipalKey | undefined = ctx.consoleMembers.principalOfRequest(req)
```

`principalOfRequest` 是 fork 的 webServer 路由取得请求背后成员的唯一方式：路由不自己读身份头，也不自己调 `connection.admit`。`principalOfSession` 沿子会话的父链追到最上层的会话，`attachCustomerCredentials` 同一时刻只持有一个客户 token 读取器，且没有方法交出它。[子系统页](../../../docs/subsystems/console-members.zh.md) 解释这三条规则；[`src/index.ts`](src/index.ts) 写明每个方法的契约。

`PrincipalKey`（主体键）是 `@deepseek-ai/dsh-brand` 的 `Branded<'PrincipalKey'>`，值是成员的 `login_uid`。消费方把它当作不透明的值，它不进模型请求、不进日志、不上传。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

包根只有类型声明和一处 `declare module '@deepseek-ai/cordis'` 合并，它给 `Context` 加上 `consoleMembers: ConsoleMemberDirectory`。编译出的 `lib/index.js` 什么也不导出，任何 `cordis.yml` 行都不能点名这个包。

| 文件 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PrincipalKey`、`ConsoleMemberDirectory`、`MemberStore`、`CustomerCredentialReader`，以及 `Context` 合并 |
| [`tests/types.spec.ts`](tests/types.spec.ts) | 针对 `Context` 键和主体键品牌的类型断言 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [控制台成员目录](../../../docs/subsystems/console-members.zh.md)——请求、父链和客户 token 三条规则。
- [`dsh-experimental-biz-backend`](../biz-backend/README.zh.md#whom-a-read-is-for)——经 `principalOfRequest` 点名请求背后成员的凭据解析器。
- [Client connection](../../client/connection/README.zh.md)——`principalOfRequest` 所跑的 Peer 准入。

<a id="model-experience"></a>
## 模型体验

无，因为本包只导出类型，不注册插件、工具、提示词段落或会话事件。

#### KV Cache 影响

类型声明不增加模型输入，因此不影响提供方的缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **本仓库里没有提供方。** 没有任何包提供 `ctx.consoleMembers`。注入它的插件永远不会启动，`ctx.get('consoleMembers')` 答 `undefined`。[`src/index.ts`](src/index.ts) 里的方法契约约束的是提供这个目录的那个插件；没有测试检验它们，因为本包的 spec 只检查声明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
