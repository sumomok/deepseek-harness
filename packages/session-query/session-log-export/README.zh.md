---
description: "Web 会话日志 ZIP 导出：Host 流式传输、认证下载路由、Session Header 操作与 /export 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

[English](README.md) | 中文

## 概述

`dsh-session-log-export` 让 Web 界面可以下载会话的完整历史：Session Header 中的 `Session log` 按钮与 `/export` 斜杠命令都会把会话树——会话本身、其子会话与附件——作为 ZIP 交给浏览器下载。本包拥有 Host 归档流、经过认证的 Fetch 路由以及浏览器控制和反馈。页面自己读取归档并展示进度，因此无需浏览器下载管理器也能看到导出的推进以及传输中途的失败；归档最终落盘的位置仍由浏览器选择。设置与用法在前，随后说明实现细节。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 Web bundle 需要让用户导出会话日志时使用本包。它需要 Connection、命令注册表、Session 查询与持久化以及附件服务。挂载插件，然后点击 Session Header 中的 `Session log` 或输入 `/export`；浏览器会下载 `dsh-session-<id>.zip`。

### 何时选择

为需要带可见下载弹窗的用户级会话导出的 Web 部署选择它。需要程序化或 Host 侧导出时避免使用：本包产生的是浏览器下载，而非 Host 路径写入。日志从持久化读句柄序列化而来，因此任何已挂载后端都受支持。

### 组合

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

Web bundle 将本包与 Connection、`dsh-commands`、`dsh-client-ui-commands` 和 `dsh-client-ui-conversation` 一起挂载。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `compressionLevel` | `6` | 每个 ZIP 条目的 DEFLATE 级别，范围为 0 到 9。 |

### 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 记录一组用户命令生命周期；提交命令的浏览器下载 `GET /api/session.export?sessionId=<id>&includeDescendants=true` |
| `/export <path>` | 错误；浏览器下载通过浏览器的普通下载行为选择目标位置 |

### 路由响应字段

| 字段 | 含义 |
|---|---|
| `Content-Disposition` | `attachment`，附带归档文件名 `dsh-session-<id>.zip`。 |
| `X-Session-Export-Entries` | 归档包含的 ZIP 条目数：每个纳入的会话日志一条，每个被引用的媒体对象一条。 |
| `X-Session-Export-Bytes` | 这些条目未压缩大小的总和。 |
| `X-Session-Export-Estimated-Wire-Bytes` | 响应体大小的估算值，浏览器按它缩放进度条。 |

`GET` 与 `HEAD` 返回相同字段。这三个规模字段同进同出；当归档在流式传输前无法被测量时它们一并缺席，浏览器此时展示不确定进度条而非百分比。

当 `compressionLevel` 为 `0` 时，归档只存储不压缩，线上字节估算值恰好等于未压缩总量。大于 `0` 时，它对日志条目施加一个标定比例——0.14，取自真实会话日志导出，实测落在 0.13 到 0.15 之间——并对媒体按原值计，因为 PNG 与 JPEG 无法进一步压缩；每条目数十字节的 ZIP 框架开销忽略不计。因此进度条诚实但不精确：压得比标定更狠的归档会在流结束前到达 99% 并停在那里，压得更松的则会从约八成处直接完成。

### 预期行为

面板报告三个阶段：导出中、完成或失败。导出期间它展示一条进度条，下方是已接收的字节数。只要路由给出了归档规模，进度条就是确定的——包括没有子会话也没有附件的会话所导出的单条目归档；只有路由未给出规模时才是不确定进度。`取消` 放弃传输且不保存任何内容；关闭面板不会中断传输，归档仍会被保存，该操作随后完成时面板也不会重新打开。每个会话同时只允许一项下载，重复操作共用该任务。导出包含实时会话的最新事件：Host 端点在读取前会 flush 活动的根会话，因此斜杠命令触发的 ZIP 会包含启动下载的 `command/run` 与 `command/done` 事件对；冷持久化会话不需要 flush。每份逻辑日志在归档中使用当前 generation 的规范文件名（v0 为 `session.jsonl`，其他版本为 `session.vN.jsonl`），每个子会话目录下也遵循同一规则。图片使用 `media/<attachmentId>.<ext>`，通用文件使用 `files/<digest-prefix>/<digest>/<name>`。通用文件以有界分块读取并压缩，因此导出大文件时不会把它完整缓冲进内存。

### 失败

面板会说明每一种失败，因为从第一个字节到最后一个字节，传输都握在页面手里：路由在流式传输开始前拒绝请求时是 HTTP 状态码加 Host 的报错信息，连接失败或子会话、附件读取在中途撕裂归档时则是浏览器的传输错误。Host 无法描述在它的响应已经开始之后才发生的失败——被撕裂的归档到达页面时只是 `network error`——因此面板报告的是「导出撕裂了」，而不是为什么。失败的导出不保存任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包如何接线导出控制，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计拆分

本包有两个半包。Host 半包（[`src/index.ts`](src/index.ts)）注册 `/export` 命令，并向 Connection 贡献精确的 `GET`/`HEAD /api/session.export` Fetch 路由；[`src/archive.ts`](src/archive.ts) 构建有界 ZIP 流。浏览器半包（[`src/client/index.ts`](src/client/index.ts)）提供共享下载控制器和 UI，并观察 `command/executed`，因此只有提交命令的浏览器会启动下载。

### 下载流程

两条入口都通过 `fetch` 请求 `GET /api/session.export?...`，并逐块读取响应体。[`src/client/progress.ts`](src/client/progress.ts) 把已接收字节数与其中的 ZIP 局部文件头签名换算成一个比例——取两个下界中较大者，并在流结束前始终保持小于 1。已接收字节按声明的线上估算值缩放，单条目归档正是由它带动；条目计数则在归档压得比标定更狠时把比例抬离下界，而一个条目只有在下一个条目的头到达之后才算完成，因为头总是先于它自己的数据。进度按动画帧而非按数据块送达面板。流结束后控制器把各块拼成一个 `Blob`，并点击指向其 object URL 的游离下载锚点。一个控制器按会话持有一项进行中的下载，把并发操作折叠进该任务，并在取消与插件释放时中止传输。面板状态存放在按会话键控的快照存储中，因此按钮与命令按会话共享一个面板。

在产出第一个归档字节之前，Host 会把这次导出遍历一遍，统计条目数并累加它们未压缩的大小——日志大小取自流将要推送的文本，媒体大小取自每条引用记录的字节长度——并把总数作为响应字段发出。测量会重新读取每个子会话日志，但绝不重新读取已存储的图片；测量失败只会让两个规模字段缺席，因为流式传输会遇到同一个失败并对结果负责。

Host 路由是业务拥有的精确 Fetch contribution。Connection 应用 Host/Origin 与浏览器会话检查并桥接流式 `Response`；本包拥有查询校验、活动会话 flush、基于句柄的日志读取与附件读取、ZIP 生成和 HTTP 状态语义。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 Web 控制逐步进入 Host 端点与周围的命令和会话表面。

- [dsh-client-connection](../../client/connection/README.zh.md)——Host 端点使用的认证 Fetch 路由载体。
- [命令子系统参考](../../../docs/subsystems/commands.zh.md)——`/export` 命令注册的用户命令注册表。
- [dsh-client-ui-commands](../../client/ui-commands/README.zh.md)——渲染并确认 `/export` 的浏览器命令表面。
- [会话查询包映射](../README.zh.md)——本包所属的检索能力家族。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/export` 控制

#### 模型看到什么

无。`/export` 留在用户命令平面，ZIP 下载不会进入模型历史。

#### Token 影响

为零。该命令不创建模型轮次。

#### KV Cache 影响

无。仅日志命令生命周期与浏览器下载不会改变派生请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **浏览器下载，而非 Host 路径写入**——目标位置由浏览器选择；不会返回 Host 路径或原生文件夹操作。
- **整个归档在保存前驻留内存**——页面把收到的每一块拼进一个 `Blob`，在数据块列表与 `Blob` 并存的瞬间会占用两倍归档大小，因此导出受标签页内存限制，而非受可用磁盘空间限制。实践中会话归档是兆字节量级；数 GB 的会话树无法处理。
- **中途失败没有 Host 给出的原因**——子会话或附件读取失败时，归档的状态码与响应头早已发出，页面只能报告浏览器的传输错误。真正的原因在 Host 日志里。
- **首字节要等测量走完**——路由在应答前会把整次导出遍历一遍，因此首字节时延随子会话数量增长。没有子会话的会话只多付一次谱系调用，不多读任何日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关页面为准。

#### 未来：浏览器之外的导出目标

下载刻意限定在浏览器范围；Host 路径或原生文件夹导出需要新的端点约定，并决定 ZIP 的落盘位置。

</details>

**运行时不变式：** 不发布伴生入口。Connection 与 command registry 持有两个注册，每次 export 直接读取权威 Session service。
