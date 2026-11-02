---
description: "⌘F 消息搜索浮层：把 Host 的全文检索结果按游标分页读回，以「消息」而不是「会话」为单位呈现，带命中片段高亮与键盘操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-search

[English](README.md) | 中文

## Summary

`dsh-client-ui-search` 在工作区的所有会话之上放一个搜索框。输入即读取 Host 已建索引的消息内容，按 Host 给出的游标一页页取回，并把每条命中画成「某会话里的某条消息」——而不是「曾经提过这个词的会话」。回车打开选中的命中，Esc 关闭浮层。面板对按键做防抖、取消被取代的读取，并在下一页加载期间保留上一页内容。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在桌面窗口中任意位置按 ⌘F（Windows / Linux 为 Ctrl+F）。Web 端用 ⌘⌥F，因为那里 ⌘F 与 ⌘⇧F 分别属于浏览器的查找栏和既有的会话搜索；两个入口是同一个命令 `search.messages`，改键位即同时生效。

浮层只持有三样状态：查询词、已读各页累积的结果行、以及选中项。它不持有传输状态——每次读取都走会话数据层，失败的调用被折成结果，面板据此渲染失败态并提供重试。

<a id="understand-the-implementation"></a>
## 实现说明

`src/client/index.ts` 是插件本体：注册字典、快捷键与 `shell.overlay` 条目，并持有防抖后的读取序列。序号计数器丢弃被新按键或关闭动作取代的旧回复，因此慢到的页永远覆盖不了新结果。

`src/client/state.ts` 承载面板状态与由线上类型派生的游标类型。`src/client/SearchPanel.tsx` 是纯展示层：状态快照与回调经插槽的 inject 面传入，它自己不持有任何服务。

分页跟随 Host：`nextCursor` 是不透明值，缺失即停止索取。滚动到列表底部只在序列处于完成态时请求下一页，因此待发的读取不会被重复触发。

<a id="further-exploration"></a>
## 延伸阅读

- [会话查询](../../session-query/session-query/README.zh.md) 持有索引与它所服务的消息检索。
- [会话控制器](../../api/session-controller/README.zh.md) 持有 `session.searchMessages` Remote 及其游标信封。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md) 说明本包遵循的插槽与 inject 约定。

<a id="model-experience"></a>
## 模型体验

无。本包只为人渲染搜索结果，不触碰提示词、消息、模式、流或工具结果；它展示的已索引内容本就存在于模型已经读到的会话记录中。

#### KV Cache 影响

无；本包从不组装或发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 打开一条结果只打开它所属的会话。要落到命中的那条消息并高亮，需要有「事件 → 节点」的映射，而会话视图目前不暴露它；助手消息会合并进分组节点，一个 `seq` 并不对应某一个节点。
- 面板读取的是 Host 当前的索引状态。未被索引的会话由 coverage 字段报告，并呈现为「结果可能不全」的提示，而不会安静地漏掉。
- 结果是平铺的，没有按会话分组；分组方案已出图，暂缓。
- 只有在 Host 的消息索引打开时本面板才挂载。现成的 Web profile 让索引保持关闭，因此该 profile 中这一行被禁用；要启用内容检索的部署，在覆盖 `openAt` 的同时加上这一行。

<a id="dev-note"></a>
### 开发说明

所有可见文案由字典持有，面板内没有字面文案。行内高亮来自 Host 返回的命中区间，那些区间已裁剪到摘要窗口之内；面板只负责把摘要切成片段，不会二次检索。
