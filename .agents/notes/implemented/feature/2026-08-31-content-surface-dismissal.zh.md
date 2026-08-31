# Agent Note: 把关闭标签页做成一个会话事件

Status: implemented

[English](2026-08-31-content-surface-dismissal.md) | 中文

## Problem

[content-surface 路由器](2026-08-24-content-surface-router.zh.md)给了这一栏一条切换条，却没给它任何移除手段。一条 entry 一旦存在就会永远留在流里——重绘的图表或重新展示的页面会原地替换自己的记录，但从没有什么东西会真正离开这份列表。一个长对话里打开过五个页面的用户，就得面对五个标签页要翻，却无法关掉已经看完的那些；而切换条视觉上早就长成了 Chrome 风格标签页的样子，人们理所当然会期待它带一个关闭按钮。

## Decision

关闭一个标签页是一次持久的、被记录的行为，而不是浏览器本地的隐藏。`content-surface/dismissed`（`{ kind, entryId, by: 'user' }`）是 content-surface 自己拥有的第一个会话事件——流里其余每一条 entry 仍然派生自别的包已经记下的事实，但「关闭」这件事只有这个路由器自己的切换条会产生，因此这个事件归它所有。它不是 `ignorable`：不认识这个事件类型的旧构建必须拒绝该日志，而不是悄悄把一条已关闭的 entry 当作仍然存活。新增它没有让 `SESSION_FORMAT_VERSION` 递增——按 [session-log-version-mechanism 笔记](../architecture/2026-08-10-session-log-version-mechanism.zh.md)的说法，这属于普通的词汇增长。

`projection.ts` 的 fold 把 `content-surface/dismissed` 当作唯一绕过整张 extractor 表的事件：它直接删掉指名的 `(kind, entryId)` 记录，完全不跑任何 `read`。这是对 fold 自身控制流的改动，而不是对已注册 extractor 的改动，因此 `extractor.ts` 的 `foldVersion`——此前是表的纯函数——现在还折入一个 `FOLD_SEMANTICS_VERSION` 常量，从它隐含的旧值 1 递增到 2。在这次 fold 能够删除记录之前写下的 checkpoint 会被丢弃，而不是按一条它写下时还不存在的规则被重放——这与一次表变化已经获得的那种防御姿态完全一致。

一次关闭从不对照活的流做校验。这个路由器没有任何目录记录着当下存在哪些 `(kind, entryId)` 组合——extractor 只在 fold 内部运行，fold 之外没有任何东西追踪「当下」状态——因此命令（`dismiss-content-entry`，content-surface 的 node 半边）会无条件地为其输入指名的任意组合追加事件。一个已经不存在的组合会被折叠成一次无操作，与一个从未存在过的组合完全一样；没有什么需要被拒绝。后来若有记录再次指名同一组合（agent 重绘了图表、用户重新导航到该页面），一旦被关闭的那条记录已经不在，这就是一次普通的新插入，因此一条被关闭过的 entry 会像从未被关闭过一样复活——关闭只会移除，从不压制未来的写入。

切换条的选择回落逻辑不需要任何新代码。`selectedEntry`（content-column 的 `surface-seats.ts`）此前就已经会在用户所选的 key 不在 `entries` 里时回落到最新的 entry——此前这条路径只能通过「所选被替换」这种情形触及（重绘的图表保留同一个 key，所以这条路径大体上只是理论上存在），以及「尚未选择任何东西」的初始情形。关闭直接移除一条记录，让「所选 entry 已经消失」第一次成为一条真实、常见的路径，而既有的回落逻辑已经给出了正确答案：它不需要知道那个 key 为什么会消失。

### Chrome 风格标签页，绝不按钮嵌按钮

切换条里的每个标签页现在是一个 wrapper `<div>`，里面包着两个兄弟 `<button>`：既有的选择按钮（`data-content-surface-entry`、`data-content-surface-selected`，属性不变）和一个新的关闭按钮（`data-content-surface-dismiss`，携带同一个 `<kind> <entryId>` key）。两者是独立的 DOM 兄弟节点，绝不是一个嵌在另一个里面——一个可交互元素嵌在另一个可交互元素里面，本身就是无效的 HTML，也难以可靠地做点击测试；把这颗药丸的边框和背景放在 wrapper 上而不是任何一个按钮上，则保住了「一个标签页」这个视觉整体。

### 隐藏命令自己的聊天回声

`dismiss-content-entry` 和 `show-content-page` 一样是个命令，因此它在聊天记录里默认渲染出来会是一张写着「成功」的 `GenericCommandCard`。content-column 为这个 key 注册了自己的空 `conversation.chat.commandview` 条目，外加自己那份折叠样式表（`hide-empty-command-row.ts`，与 content-frame 一模一样的机制用的是不同的 `STYLE_ID`）——持久的关闭记录才是关键，而不是一条复述用户刚关掉的标签页的聊天消息。这是照抄 content-frame 已有的、用来隐藏 `show-content-page` 自己回声的机制，而不是共享它：content-column 不依赖 content-frame，两个包在这次部署里是一起被 fork 拥有的。

## Alternatives considered

**浏览器本地隐藏，完全不碰日志。** 已拒绝：刷新、第二个浏览器标签页、第二台设备都会让「关掉的」entry 复活，因为没有任何持久记录记下这次关闭。`content/shown` 之所以是持久的正是同一个理由——这个事件延续的是那个先例，而不是把关闭当成纯粹的视图关切。

**在接受一次关闭之前，先对照一份活的目录做校验。** 已拒绝：没有现存的所有者需要它——这个路由器除了正在折叠的那份状态之外，没有任何持久的「当下存活」索引；单单为了拒绝一个本来就无害的无操作而去建一个，是没有现存消费者要求的复杂度。

**因为没有 extractor 表发生变化，就不给 `foldVersion` 加盐。** 已拒绝：fold 自身的语义变了（它现在能删除一条记录，此前完全不能），而 `stateVersion` 存在的全部意义就是让一份 fold 已经不再匹配、生成它的那份 checkpoint 失效——只绑定到 extractor 表上恰恰会漏掉这一类变化。

**一个确认对话框或撤销手段。** 已拒绝，尚未得到证实：切换条今天没有任何其他确认手势，而关闭这件事在唯一要紧的意义上本就成本很低——重新导航到（或让 agent 重绘）同一份内容，会让这条 entry 以一次普通的新记录复活。

## Consequences

content-column 现在依赖 `@deepseek-ai/dsh-client-ui-conversation`，并要求 `remote`/`remote.commands`，此前两者都不需要——关闭按钮的命令派发和它自己的隐藏回声注册，正是把两者都拉进来的原因。content-surface 获得了它对 `@deepseek-ai/dsh-commands` 的第一个依赖，以及它的第一个会话事件，因此它的包不变式（此前是一个有文档说明的空操作）现在会校验 `content-surface/dismissed` 的形状。

切换条的 DOM 形状变了：原本每条 entry 一个 `<button>`，现在是一个 wrapper `<div>` 里包着两个。除 `ContentSurface.tsx` 之外没有任何包读取过此前那个单按钮的形状（`data-content-surface-entry`/`-selected` 保持原位），因此这次改动无需触碰任何其他包。

content-column 自己的空状态文案（`locales.ts`）在同一次改动里被修正：它的中文「column.empty」字符串此前提到了「会话」，这是一个在客户可见文案里被禁用的词；现在它不再提及是什么产生了这些 entry，改动范围也就此打住，没有借机扩大。

## Testing

`packages/experimental/content-surface/tests/projection.spec.ts` 直接覆盖了这次 fold：一次关闭移除它指名的记录、针对一个已经不存在的组合的无操作 fold，以及在记录消失之后通过一次普通的 `read` 完成复活。`command.spec.ts` 针对真实的 registry 覆盖了这条命令（注册元数据、一次成功的关闭、畸形输入、HMR 卸载）。`invariant.spec.ts` 在实时追加路径和磁盘上已存在的坏记录两侧都覆盖了持久形状校验。`command-child.spec.ts` 以 `prompt-section.spec.ts` 覆盖可选的 `systemPrompt` 子节点同样的方式，覆盖了可选的 `commands` 子节点。

`packages/experimental/content-column/tests/content-surface.client.spec.tsx` 覆盖了关闭按钮是一个 DOM 兄弟节点而不是被嵌套的按钮、关闭动作以正确的参数调用注入的 `onDismiss`，以及所选 entry 消失后选择会回落。`surface-seats.client.spec.ts` 在既有的「被替换」情形之外，明确点名了「被关闭」这一情形。`dismiss.client.spec.ts` 覆盖了命令执行这道缝的失败路径。`browser-plugin.client.spec.ts` 覆盖了 `content` 注册所注入的关闭回调，以及新增的 `conversation.chat.commandview`／隐藏样式表注册，与 content-frame 自己对 `show-content-page` 的覆盖方式一一对应。

`apps/web/tests/content-surface.e2e.ts` 针对一次真实组合驱动了整条往返路径：通过切换条关闭一个标签页会移除它并让选择回落，持久的 `content-surface/dismissed` 记录出现在活的 agent 会话日志里，一次完整的页面重载不会让被关闭的 entry 复活，而针对同一页面追加一次新的 `content/shown` 则会。
