# Agent Note: The approval card's detail is keyed by tool name, so a file mutation previews its diff

Status: implemented

[English](2026-09-06-approval-detail-keyed-by-tool.md) | 中文

## Problem

送到浏览器的审批请求只携带 `toolName`、`callId`、`reason` 与一个取消信号（[`ApprovalPresentationRequest`](../../../../packages/client/ui-approval/src/client/contract/slots.ts)）。卡片画的是这条 reason，加上 `conversation.approval.detail` 这个子槽里的占位者画出来的东西，而该槽是 `single`：所有工具共用唯一一处注册。唯一的占位者是 `ui-chat` 的 `ApprovalCommand`，它解析相关调用的参数，在 `args.command` 是字符串时把它返回。只有 `bash` 与 `pwsh` 带这个字段，于是其余每一个工具的卡片正文都只剩那一行 reason。

对 `write`、`edit`、`str_replace_editor` 来说，那行 reason 就是模型自己写的 `justification`——关于一个用户看不见的文件的一句话。用户被要求批准一次沙箱提权，而这次提权的全部意义就是写入内容，内容却不在卡片上。同一次待决调用在会话流里的那一行工具卡片已经在画预期 diff（对未结算块，`diffCardModel` 返回由参数推导出的 hunk），也就是说这份信息本就在页面里，离决策处只隔一个组件。

`single` 槽无法从外部扩展而不整体接管：不同 priority 的条目可以共存，但只有最低的那个渲染，且没有 fallthrough，因此为了加一个 diff 渲染器去遮蔽该槽，就必须连 shell 分支一起重写——把 `commandOf` 抄一遍，把 `intendedDiff` 里的提权字段校验、`replace_all` 校验、`str_replace_editor` 两个子命令分支也抄一遍，而上游任一处改动都会让这份拷贝悄悄走偏。

## Decision

`conversation.approval.detail` 改为 `keyed`，按线上工具名派发——与 `tool.call.toolview` 给会话行用的形状完全相同，键域同样开放（任意线上工具名；没有条目的键什么都不渲染，这正是任何条目出现之前每个工具的样子）。

`ApprovalPanel` 传 `{ entryKey: approval.toolName }`；`ui-chat` 把 `ApprovalCommand` 注册在 `bash` 与 `pwsh` 两个键上（这是一次性 shell 与常驻 shell 共同的线上名——常驻工具注册的就是这两个名字）；`ui-tool` 新增 [`approval-diff-row.tsx`](../../../../packages/client/ui-tool/src/client/tool/toolviews/approval-diff-row.tsx)，注册在 `write`、`edit`、`str_replace_editor` 上。它像 `ApprovalCommand` 一样从 Chat 快照里取出相关的未结算调用，交给同包的 `diffCardModel`，再用 `DiffBlock` 画出结果。没有任何东西被重新推导：预览与会话行自己的待决 diff 出自同一个函数，参数校验一旦改动，编译器会同时找上两处。

`APPROVAL_DIFF_MAX_LINES` 取 40，对照会话行的 8 与图元自身默认的 16。会话行是读者一扫而过的摘要；审批卡片是读者做决定的地方，而卡片正文本来就在 composer 的高度上滚动，因此再长的预览也挤不走按钮。剩下的部分由 `DiffBlock` 的折叠开关展开。

hunk 路径在位于会话工作区之内时按相对路径显示，否则逐字显示，因此一次写到工作区之外的操作会把它要动的绝对路径亮出来。卡片不另加标题：`DiffBlock` 以路径开头，而它上方的 reason 行已经说明了这次要求是什么。

`write` 会把全部内容显示为新增行，因为浏览器在审批时刻无从得知目标是否已存在——客户端没有文件读取能力，而 `intendedDiff` 一直把 write 建模为 `oldText: null`。因此卡片只声称它能声称的：这个路径、这份内容。

这必须是一个核心补丁，因为槽声明、派发点与它的 shell 占位者分属三个上游包；fork 插件只能遮蔽该槽，而那正是本次改动要避免的复制。它登记在 [`.claude/core-patches.md`](../../../../.claude/core-patches.md)，上游让审批详情按工具渲染、或开出同等座位时即退役。

## Alternatives considered

**用 fork 插件遮蔽 `single` 槽。** 不动任何上游文件，而且这是 fork 其余每一处 UI 增补的发布方式。代价是逐字复制 `commandOf` 加 `intendedDiff`——约五十行，而其中的校验规则（提权字段成对出现、`replace_all` 的类型、`str_replace_editor` 的两个子命令）恰恰是上游会改的部分，改了也没有编译器指向这份拷贝。`jscpd` 会报出这处克隆，而且插件根本 import 不到 `diffCardModel`：`ui-tool` 没有导出它。

**消费工具自己的 `presentCall(args)`。** `edit`、`write`、`str_replace_editor` 各自声明了纯函数 `presentCall`，返回 `{ card: 'diff', diffs, locations }`——工具自己拥有的渲染意图。Web 客户端从不调用它：它在 `diff-card-model.ts` 里把同一份 diff 重新推导了一遍。让客户端改走 `presentCall` 是更好的长期形状，也是大得多的改动（需要一条从 Host 到 Client 的渲染意图通路），与审批卡片能不能显示一份 diff 无关。

**把参数挂到审批请求上。** `ApprovalRequestEvent` 可以新增 `argsRaw`，这样审批包不必伸手去取 Chat 快照就能渲染。它加宽的是一个 Host 侧交互契约，重复了会话日志本已持有的数据，并且会让审批包成为工具参数格式的消费方——而按工具名分派要避开的恰恰是这一点。

**改为在派发点用 `fallback` 承接 shell 键。** `renderSlot` 的 keyed 形态对未占位的键接受一个 `fallback`，把 `ApprovalCommand` 放进去就能让每一个未注册工具保持今天的行为。`ui-approval` 引用不到它：依赖方向是 `ui-chat` 依赖 `ui-approval` 而非相反；而且这个 fallback 会在 owner 处重新引入「一个渲染器替所有工具做决定」的形状。

**取更大的上限，或者不设上限。** 正文会滚动，因此不设上限也读得完。折叠让「决策按钮距卡片顶部的距离」在一次上千行的写入面前仍然有界，而 40 行正是「不靠滚动就能看全」的那条界线。

## Consequences

`str_replace_editor` 的审批此前会显示它的 `command` 参数——字面上的 `create` 或 `str_replace`——因为 `commandOf` 接受该键下的任意字符串。现在它改为显示 diff。任何其他参数里恰好带有字符串 `command` 的工具会失去这一行附带产物；在已发布的工具里，除两个 shell 与 `str_replace_editor` 外没有这样的工具。

`ui-tool` 为槽声明合并新增了一条对 `ui-approval` 的纯类型依赖，与 `ui-chat` 的同款。依赖方向不变：`ui-tool` → `ui-chat` → `ui-approval`，没有任何运行期值跨过去。

生成的 Client 槽目录现在给出了键域（`open: … already taken: bash, edit, pwsh, str_replace_editor, write`）并列出五个占位者，因此想给自家工具加审批预览的插件不用读本 Note 也能看见这个座位。

包内测试覆盖派发与渲染器：`ui-approval` 对一个已注册与一个未注册的工具名断言 `entryKey`，`ui-chat` 断言它的两个键，`ui-tool` 的 [`approval-diff-row.client.spec.tsx`](../../../../packages/client/ui-tool/tests/approval-diff-row.client.spec.tsx) 覆盖 write、edit、`str_replace_editor` 两个可预览子命令、工作区外路径与无工作区路径、缺失／不相关／已结算的调用、尚未描述出变更的参数，以及三处注册。

整机取证是 [`apps/web/tests/approval-preview-diff.e2e.ts`](../../../../apps/web/tests/approval-preview-diff.e2e.ts)，一条无密钥的通路：一份手写回放脚本在 Read Only 下发出一次携带 `sandbox_permissions: workspace-write` 的 `write`，金样记录下卡片在提权 reason 旁显示 `notes.txt`、它的三行新增内容与 `+3 -0 · 1 file` 页脚，随后落盘文件与这几行逐字相符。脚本是手写而非录制，因为该场景只是一次确定性调用，手写能让这条通路在没有模型密钥时也跑得起来。`approval-composer` 的录制金样逐字节不变，这是 shell 分支的回归证据。
