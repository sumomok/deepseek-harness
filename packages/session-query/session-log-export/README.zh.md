---
description: "Web 会话日志 ZIP 导出与 Markdown 复制：Host 流式传输、认证路由、Session Header 操作与 /export 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

[English](README.md) | 中文

## 概述

`dsh-session-log-export` 让 Web 界面导出会话的完整历史。Session Header 的更多操作菜单提供 `复制会话为 Markdown` 与 `下载 Session 日志`；`/export` 斜杠命令也会启动 ZIP 下载。ZIP 包含会话本身、其子会话与附件。本包拥有两条经过认证的 Host 路由、Markdown 记录格式化器以及浏览器控件和反馈。下载目标位置由浏览器选择，剪贴板由浏览器持有。设置与用法在前，随后说明实现细节。

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

当 Web bundle 需要让用户导出会话日志时使用本包。它需要 Connection、命令注册表、Session 查询与持久化以及附件服务。挂载插件，然后在 Session Header 的更多操作菜单中选择 `复制会话为 Markdown` 或 `下载 Session 日志`，或输入 `/export`；浏览器会复制记录或下载 `dsh-session-<id>.zip`。

### 复制会话为 Markdown

`复制会话为 Markdown` 会把选中的完整 Session 复制为可移植 Markdown，包括客户端尚未加载的历史。记录以最新的日志标题开头。人类用户消息按时间顺序作为引用块，最终的 assistant 回复保持普通 Markdown，每轮中较早的 assistant 说明与工具活动折叠到该轮最终回复之前的 `<details>` 区段。若一轮中最后一条已提交 assistant 消息带有工具调用，该轮没有最终回复，全部活动保持折叠。未完成的一轮渲染其已提交的消息。仅导出 append 消息事件。未完成的 assistant 代码围栏会在消息边界闭合，四空格或制表符缩进的代码保留缩进。

格式化器读取已提交的原始日志，因此压缩产生的表层替换不会移除较早消息，fork 继承的历史只出现一次。标题与正文来自同一个 `readSession` 快照。持久化元数据报告选中的已物化产物时，记录会在标题后添加一个 `Session file:` 围栏文本块，包含该精确路径；没有时省略该块。只复制选中的 Session 及其继承前缀；子会话日志仍只由 ZIP 导出。推理块、system 与 developer 消息、source kind 不是 `user` 的注入用户角色上下文、请求头与上下文以及运行时记录都会被省略。图片与文件变成可读标签；附件字节与认证链接不会进入记录。`Assistant`、`Tool` 和附件占位符等结构性标签有意使用英文；原始消息文本保持不变。文本以恰好一个换行结尾。

剪贴板是浏览器范围的唯一目标，因此本插件实例一次只运行一项复制。在支持 `ClipboardItem` 与 `navigator.clipboard.write` 的宿主上，控制器会在点击时请求延迟的 `ClipboardItem` 写入，同时加载文档相对的 `api/session.markdown?sessionId=<id>` 路由；其他宿主在准备完成后回退到共享剪贴板助手。复制进行中到达的请求会加入该操作，并保留第一次点击的 Session。所有 Session Header 通过 `aria-busy` 反映复制状态，并在操作结束前禁用各自的复制行。成功、准备失败或剪贴板失败通过根 overlay 浮层反馈。释放会中止读取，并阻止后续文本进入由 Promise 提供的 Blob；操作系统已经接受的剪贴板写入无法回滚。

挂载 `ui-message-feedback` 时，同一菜单还提供“反馈”，打开已有的 Session 反馈弹窗。打开或关闭该弹窗不会导出 Session 或提交反馈。反馈入口随反馈插件的可用状态显示；两个导出操作保持独立可用。

### 何时选择

为需要面向用户的会话导出——复制可读的 Markdown 记录与下载 ZIP 归档——的 Web 部署选择它，也适用于已经持有完整已提交逻辑事件快照并需要相同 Markdown 转换的后端调用方。仅需 Host 路径写入时避免使用：浏览器操作把结果留在浏览器中，转换工具不执行 IO。日志从持久化读句柄序列化而来，因此任何已挂载后端都受支持。

### 后端转换

包入口还导出 `formatSessionMarkdown(events, sourcePath?)`：面向已经持有完整已提交逻辑事件快照（按 seq 排序，包含任何继承前缀）的调用方的纯后端工具。它读取最新的 `session/title` 事件，返回以恰好一个换行结尾的 Markdown，不执行 IO、不启动插件或 Session，也不修改事件。可选的、由后端解析的 `sourcePath` 会原样写入标题后的动态围栏 `Session file:` 文本块；省略或空路径不添加该块。缺失或空白标题生成 `Untitled Session`。它只转换传入的事件；不读取子会话日志。

```ts
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatSessionMarkdown } from '@deepseek-ai/dsh-session-log-export'

export function convertTranscript(events: readonly SessionEvent[], sourcePath?: string): string {
  return formatSessionMarkdown(events, sourcePath)
}
```

### 组合

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

Web bundle 将本包与 Connection、`dsh-commands`、`dsh-client-ui-commands`、`dsh-client-ui-conversation` 和 `dsh-client-ui-layout` 一起挂载。layout 包声明复制反馈使用的 `shell.overlay` 座位；其他客户端包提供 Header 座位、locale 与命令界面。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `compressionLevel` | `6` | 每个 ZIP 条目的 DEFLATE 级别，范围为 0 到 9。 |

### 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 记录用户命令的生命周期；提交命令的浏览器下载文档相对的 `api/session.export?sessionId=<id>&includeDescendants=true`（Host 路由 `/api/session.export`） |
| `/export <path>` | 错误；浏览器下载通过浏览器的普通下载行为选择目标位置 |

### 路由响应字段

| 字段 | 含义 |
|---|---|
| `Content-Disposition` | `attachment`，附带归档文件名 `dsh-session-<id>.zip`。 |
| `X-Session-Export-Entries` | 归档包含的 ZIP 条目数：每个纳入的会话日志一条，每个被引用的媒体对象一条。 |
| `X-Session-Export-Bytes` | 这些条目未压缩大小的总和。 |
| `X-Session-Export-Estimated-Wire-Bytes` | 响应体大小的估算值，浏览器按它缩放进度条。 |

`GET` 与 `HEAD` 返回相同字段。当归档在流式传输前无法被测量时，三者一并缺席。浏览器缩放进度条只需要条目数与线上估算值，缺其一即展示不确定进度条；`X-Session-Export-Bytes` 是诊断用字段，只缺它的响应仍然驱动确定进度条。

当 `compressionLevel` 为 `0` 时，归档只存储不压缩，线上字节估算值即未压缩总量；但它在那里仍然略微偏低，差的是被忽略的 ZIP 框架——每条目数十字节，在小归档上约 6%。大于 `0` 时，它对日志条目施加一个标定比例——0.14，取自真实会话日志导出，实测落在 0.13 到 0.15 之间——并对媒体按原值计，因为 PNG 与 JPEG 无法进一步压缩；每条目数十字节的 ZIP 框架开销忽略不计。因此进度条诚实但不精确：压得比标定更狠的归档会在流结束前到达 99% 并停在那里，压得更松的则会从约八成处直接完成。

### 预期行为

面板报告三个阶段：导出中、完成或失败。导出期间它展示一条进度条，下方是已接收的字节数。只要路由给出了归档规模，进度条就是确定的——包括没有子会话也没有附件的会话所导出的单条目归档；只有路由未给出规模时才是不确定进度。`取消` 放弃传输且不保存任何内容；关闭面板不会中断传输，归档仍会被保存，该操作随后完成时面板也不会重新打开。每个会话同时只允许一项下载，重复操作共用该任务。导出包含实时会话的最新事件：Host 端点在读取前会 flush 活动的根会话，因此斜杠命令触发的 ZIP 会包含启动下载的 `command/run` 与 `command/done` 事件对；冷持久化会话不需要 flush。每份逻辑日志在归档中使用当前 generation 的规范文件名（v0 为 `session.jsonl`，其他版本为 `session.vN.jsonl`），每个子会话目录下也遵循同一规则。图片使用 `media/<attachmentId>.<ext>`，通用文件使用 `files/<digest-prefix>/<digest>/<name>`。通用文件以有界分块读取并压缩，因此导出大文件时不会把它完整缓冲进内存。

附件收集读取内置 Session 事件声明的内容字段与已完成的 assistant 流块，包括扁平的 V4 tool 角色消息。未知事件载荷与无关字段在导出日志中保持不变，但不会触发附件读取。

### 失败

当 ZIP 流式传输开始前的预检失败时——例如 Host 端点不可达或配置错误——弹窗显示准备阶段错误。浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。Markdown 准备失败显示重试 Session 读取的浮层；剪贴板写入失败显示单独的检查剪贴板权限浮层。二者都不会为不完整或缺失的记录报告成功，也不会显示进行中的浮层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包如何接入导出控件，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计拆分

本包分为两部分。Host 半包（[`src/index.ts`](src/index.ts)）注册 `/export` 命令，并向 Connection 贡献精确的 `GET`/`HEAD /api/session.export` 与 `/api/session.markdown` Fetch 路由；[`src/archive.ts`](src/archive.ts) 构建有界 ZIP 流，[`src/markdown.ts`](src/markdown.ts) 渲染 Markdown 记录。浏览器半包（[`src/client/index.ts`](src/client/index.ts)）提供共享下载与 Markdown 复制控制器和 UI，并观察 `command/executed`，因此只有提交命令的浏览器会启动下载。

该路由通过它自己的 [Connection](../../client/connection/README.zh.md) 访问规则服务非 owner Peer（例如控制台成员）：[remote access](../../api/remote-access/README.zh.md) 必须在被请求的会话上放行 action `/api/session.export`，并在 `includeDescendants=true` 时在归档将包含的每个 subagent 后代会话上放行。先判定被请求的会话，放行后才读取谱系。规则判定的就是导出随后使用的查询，只解析一次；参数重复时与 owner 一样取最后一个值。缺 `sessionId` 或 `includeDescendants` 取值非法、Host 没有 remote access 或 Session query、谱系读不出或任一判定被拒时，在读取任何日志之前返回 403。owner 的导出不变。

Header 的更多操作入口使用公共紧凑 Button，点击区域为 28px 正方形，与右侧栏展开控件共用圆角和 hover 底色。

### 下载流程

两条入口都通过 `fetch` 以 `GET` 请求文档相对的 `api/session.export?...`，并逐块读取响应体。[`src/client/progress.ts`](src/client/progress.ts) 把已接收字节数与其中的 ZIP 局部文件头签名换算成一个比例——取两个下界中较大者，并在流结束前始终保持小于 1。已接收字节按声明的线上估算值缩放，单条目归档正是由它带动；条目计数则在归档压得比标定更狠时把比例抬离下界，而一个条目只有在下一个条目的头到达之后才算完成，因为头总是先于它自己的数据。进度按动画帧而非按数据块送达面板。流结束后控制器把各块拼成一个 `Blob`，并点击指向其 object URL 的游离下载锚点。一个控制器按会话持有一项进行中的下载，把并发操作折叠进该任务，并在取消与插件释放时中止传输。面板状态存放在按会话键控的快照存储中，因此按钮与命令按会话共享一个面板。

在产出第一个归档字节之前，Host 会把这次导出遍历一遍，统计条目数并累加它们未压缩的大小——日志大小取自流将要推送的文本，媒体大小取自每条引用记录的字节长度，流最终读不出来的图片同样按这个长度计——并把总数作为响应字段发出。测量与流式传输跑的是同一个遍历，但发生在两个不同时刻：因此测量会重新读取每个子会话日志（但绝不重新读取已存储的图片），而在两遍之间追加了事件的活动子会话会让声明的总数偏低。测量失败只会让三个规模字段缺席，因为流式传输会遇到同一个失败并对结果负责。

Host 路由是由该功能拥有的精确 Fetch 路由贡献。Connection 应用 Host/Origin 与浏览器会话检查并桥接流式 `Response`；本包拥有查询校验、活动会话 flush、基于句柄的日志读取与附件读取、ZIP 生成和 HTTP 状态语义。

### Markdown 复制流程

Header 向 Markdown 复制控制器请求被点击的 Session。点击期间，控制器在加载文档相对的 `api/session.markdown?sessionId=<id>` 路由的同时请求延迟的 `ClipboardItem` 写入；其他宿主在准备完成后回退到共享剪贴板助手。Host 路由通过 `ctx.sessionQuery.readSession` 读取完整的 live-preferred 逻辑日志，并把事件交给纯格式化器。它另外通过 `ctx.get('sessionPersistence')?.stat` 获取选中已物化产物的路径，并把可选路径传给格式化器；元数据读取失败属于经过清理的准备失败。该读取是分离的导出观察：不创建 Agent、不保留 Session，也不写入 Session 数据。Session 不存在时返回 404，其他读取失败返回经过清理的 500。

控制器持有一个进行中的操作和一个 `shell.overlay` 浮层条目。第二个 Header 请求加入该进行中的操作，因此剪贴板及其提示始终描述第一次点击的 Session。准备 promise 与已接受的剪贴板写入都会被观察，所有拒绝都被包含。释放会中止读取、阻止后续文本进入由 Promise 提供的 Blob、抑制提示，并等待已接受的剪贴板工作完成。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 Web 控件逐步进入 Host 端点及相关的命令与会话接口。

- [dsh-client-connection](../../client/connection/README.zh.md)——Host 端点使用的认证 Fetch 路由载体。
- [命令子系统参考](../../../docs/subsystems/commands.zh.md)——`/export` 命令注册的用户命令注册表。
- [dsh-client-ui-commands](../../client/ui-commands/README.zh.md)——渲染并确认 `/export` 的浏览器命令界面。
- [会话查询包映射](../README.zh.md)——本包所属的检索包族。

-----

<a id="model-experience"></a>
## 模型体验

### 用户导出与复制控制

#### 模型看到什么

无。`/export` 留在用户命令平面，ZIP 下载不会进入模型历史。Markdown 复制操作同样只属于人类：它读取已提交日志、写入浏览器剪贴板，且不追加 Session 事件。

#### Token 影响

为零。该命令不创建模型轮次，两个导出控件也不会改变请求。

#### KV Cache 影响

无。仅日志命令生命周期、浏览器下载与剪贴板写入不会改变派生请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **浏览器下载，而非 Host 路径写入**——目标位置由浏览器选择；不会返回 Host 路径或原生文件夹操作。
- **预检只报告流式传输前的失败**——浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。
- **Markdown 只包含已提交历史**——未稳定的实时 token 分块没有已提交文本，因此不会出现在复制的记录中。压缩与 fork 继承遵循原始日志，而非当前模型上下文。
- **Markdown 复制仅限选中的 Session**——子会话日志由 ZIP 下载导出，而不是 Markdown 复制。
- **记录文本缓冲在内存中**——完整的 Markdown 字符串及其 Blob 在剪贴板接受前都会保留。浏览器剪贴板限制可能拒绝大型导出；本包不增加字节上限，也不截断请求的完整记录。
- **已接受的剪贴板写入无法回滚**——释放会停止待处理的准备与反馈，但操作系统已经成功的写入会留在剪贴板中。
- **来源路径是观察到的元数据，不是原子日志声明**——`stat` 标识导出时选中的已物化产物。实时已提交事件可能领先于该文件，未物化的 Session 没有来源路径块。
- **整个归档在保存前驻留内存**——页面把收到的每一块拼进一个 `Blob`，在数据块列表与 `Blob` 并存的瞬间会占用两倍归档大小，因此导出受标签页内存限制，而非受可用磁盘空间限制。实践中会话归档是兆字节量级；数 GB 的会话树无法处理。
- **可预见的撕裂同时也让进度条失效**——测量那一遍同样读不出来的子会话会让三个规模字段一并缺席，因此进度条从第一帧起就是不确定态，而传输仍会在稍后撕裂。
- **中途失败没有 Host 给出的原因**——子会话日志读取失败时，归档的状态码与响应头早已发出，页面只能报告浏览器的传输错误。真正的原因在 Host 日志里。
- **非 owner 导出只判定一次后代**——访问规则先于归档读取谱系，所以在两次读取之间新建的 subagent 会话不经单独判定就进入归档。
- **读不出来的附件仍按记录的大小声明**——测量从不打开已存储的对象，因此一个最终由流记录下来（而非携带）的条目，仍按引用记录的字节长度计入。条目数依旧准确；两个规模字段会高出那一个附件的大小，于是页面拿收到的字节去除以一个大于实际响应体的线上估算值。进度条因此走得比传输更慢，并从它停下的位置直接跳到完成——方向与「按存储大小计量、上线时已被 deflate 压过的通用文本文件」相同。
- **首字节要等测量走完**——路由在应答前会把整次导出遍历一遍，因此首字节时延随子会话数量增长。没有子会话的会话只多付一次谱系调用，不多读任何日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关页面为准。

#### 未来：浏览器之外的导出目标

下载刻意限定在浏览器范围；Host 路径或原生文件夹导出需要新的端点约定，并决定 ZIP 的落盘位置。

</details>
