# Agent Note: `proseReferents` 正文可点扫描缝

Status: implemented

[English](2026-08-28-chat-prose-referents-seam.md) | 中文

## Problem

行内代码文件提及（`chatFileMentions`/`MarkdownFileMentions`）已经能让反引号内的已知文件词元可点，但仅限于代码内，且仅对收尾轮次实际产出的文件词表生效。Assistant 消息正文里的其余一切——以纯文本写下的绝对路径、`~/…` 简写、裸 URL、UNC 共享——都保持死字，完全没有拦截点，即便同一条 `referent/open` 缝（`packages/client/runtime/src/client/referent.ts`）已经为文件卡片与 `openFile` 收口点存在、目的完全一致。想让回复正文里"每一处可点引用"（不止行内代码，也不止已产出文件）都可点的插件，无契约可实现。

## Decision

**新增一个可选服务 `ProseReferents`**（`packages/client/ui-conversation/src/client/contract/slots.ts`），完全沿用 `ChatFileMentions` 的惯例：`ctx.get('proseReferents')` 是唯一入口，一处 `declare module` 合并把 `proseReferents` 并入 `Context`，缺席的提供者让整块表面关闭。它唯一的方法 `scan(text, { cwd, home, inlineCode })` 是纯函数——零 IO、不 `stat`——返回互不重叠的 `ProseReferentSpan`（`start`/`end`/`kind`/`target`/`raw`，与 `ReferentRef` 自身相同的字段，只是少了 `sessionId`/`source`/`provenance`）。

**`render.tsx`（ui-primitives）保持零检测。** `MarkdownRenderContext` 再添一个可选字段 `referents: MarkdownProseReferents | undefined`，携带一对已绑定的 `scan(text, inlineCode)`/`open(span)`，渲染器把它当作完全不透明——它自己的 `MarkdownProseSpan` 类型只携带 `start`/`end`，从不携带 `kind`/`target`/`raw`。这让 ui-primitives 不必依赖 `dsh-client-runtime` 的 `ReferentKind`：渲染器把 `text.slice(span.start, span.end)` 切片包成一枚 `css.fileMention` 样式的 `<button>`（沿用 `fileMentions` 已经在用的常显提及视觉 token，不发明新样式），点击时原样把 `scan` 返回的那个对象传给 `referents.open(span)`；只有构造这对绑定函数的一方才会去读那些更完整的字段。`case 'text'`（此前只是原样返回字符串）现在直接接入扫描；`case 'inlineCode'` 只在 `fileMentions` 放弃认领该词元之后才轮到它，让已知文件提及仍然优先于通用扫描器。两处在 `context.inLink` 内都保持关闭（交互元素不可嵌套进锚点内），且只在 `renderSettled` 的 context 里生效——`StreamingRenderer` 的两处冻结/尾部 context 把 `referents` 写死为 `undefined`，与 `fileMentions` 已经在用的同一套机制一样，防止流式消息的缓存元素烘进将来可能失效的处理函数。

**`apply.ts` 的 `buildProseReferents(ctx, sessions, connection, sessionId)`** 是唯一把这对不透明绑定函数变成真实派发的地方。`scan` 每次调用都现读会话的 `cwd`（`sessions.list.getSnapshot()`，与 `openFile` 已经在用的惰性读取同法）与 Host 账户 `home`（`connection.hostDescription.getSnapshot()`，经 `ctx.get('connection') as ConnectionHandle` 取得——这个包没有 `ctx.sessions`/`ctx.workspaces` 那样的环境态 Context 合并），所以把提供者组合进出，下一次渲染即刻生效，无需重新注册。`open` 自建 `ReferentRef`——`source: 'chat-prose'`，`provenance: 'model-text'`——经 `dispatchReferentOpen` 派发，绝不经过下方几行的 `openFile` 闭包（那会让这次点击二次派发且把 provenance 错标成 `'structured'`）。默认动作（仅在无人认领点击时才跑）与 `openFile` 收口点的现行为一致：`url` → `window.open(target, '_blank', 'noopener,noreferrer')`，`file`/`dir` → `workspaces.openPath(target)`。`referents` 沿 `fileMentions` 已经走过的同一条线穿下去——`ChatViewInjected` → `ChatView.tsx` → `ChatNodeOwnerProps`（经 `ChatNodeSeat`）→ `AssistantNodeView` → `AssistantMarkdown` → `MarkdownText`——但是一个按会话取值的普通值，而非按 turn-owner 取值的函数，因为正文扫描并不像 `fileMentions` 那样绑定于某一条收尾轮次的产出文件词表：它对每一条 Assistant 消息一视同仁。

## Alternatives considered

**复用 `openFile` 闭包处理正文点击。** 已否决：`openFile` 的 `ReferentRef` 写死 `source: 'chat-view.openFile'`、`provenance: 'structured'`——对 Tool 行/产出文件/提及点击是对的，对模型写下的正文是错的。若一个监听者按 `provenance` 区分结构化打开与模型正文打开，会把每一次正文点击都误报成结构化；两条路径一旦真的相交，这次点击还会被二次派发。

**让 `render.tsx` 携带完整的 `ProseReferentSpan` 形状（`kind`/`target`/`raw`）。** 已否决：渲染器根本不需要解读这些字段——它只切 `[start, end)` 再把对象原样传回去——携带它们只会新增一条真实的跨包类型依赖（`ui-primitives` → `dsh-client-runtime` 取 `ReferentKind`），而目的仅仅是满足一个渲染器从不读取的类型签名。不透明的 `MarkdownProseSpan`（只有 `start`/`end`）把"渲染器从不猜"这条界线钉在类型层面，而不只是写在注释里。

**把 `referents` 像 `fileMentions` 一样限定在 `TurnTailOwnerProps`（仅收尾轮次）。** 已否决：`fileMentions` 的词表确实是按轮次限定的——它回答的是"这一轮产出了哪些文件"——但正文里写下的一条普通路径或 URL 并不携带这种出处；把扫描限定在对话最后一条消息，会让更早的每一条 Assistant 回复的正文永久死字，即便之后组合进了提供者也无济于事。

**在 core 内部直接检测任何看起来像路径或 URL 的东西。** 被产品自身的分工线直接否决：core 只开一条通用缝、零分类逻辑；每一条正则、每一种操作系统路径语法、每一条拒开名单决策都归插件层（`@haoran/dsh-clickable-refs`）所有。这与 `chatFileMentions` 自身的分工（`MarkdownFileMentions.resolve` 对渲染器而言是黑盒）完全一致，只是把同一分工推广到了非代码场景。

## Consequences

没有 `proseReferents` 提供者时，`ctx.get('proseReferents')` 返回 `undefined`，`buildProseReferents` 返回 `undefined`，`MarkdownText` 永远收不到 `referents` prop——`case 'text'` 与 `case 'inlineCode'` 走的正是这条缝存在之前的原有代码路径，由每一个既有的 `MarkdownText`/`AssistantMarkdown`/`ChatView` 测试原样通过、外加一条新增的显式断言（`apply-inject.client.spec.tsx`，`'referents (chat view face) is undefined with no proseReferents provider composed in'`）共同证实。`packages/client/ui-primitives/src/markdown/render.tsx` 与 `MarkdownText.tsx`（不在此前文件附件 Agent Note 实测确认的 `ui-conversation/src/client/*` 覆盖率豁免范围内）对每一处新增分支——正文扫描、行内代码在提及放弃认领后的扫描、`inLink` 与流式两道闸、零间隙相邻 spans、无 referents 时的快路径——都跑到语句/分支/函数/行 100% 覆盖率（`markdown.client.spec.tsx`、`markdown-render-units.client.spec.tsx`）。`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（生成文件）经 `pnpm run gen-client-catalog -- --write` 拾取了 `ChatNodeOwnerProps.referents`/`ChatViewInjected.referents`；`api-catalog.ts` 重新生成后内容不变（`ISession`/API 表面未改动）。`SessionEventMap` 未受影响——这是一条纯客户端渲染缝，不涉及会话日志，不需要提升 `SESSION_FORMAT_VERSION`。

## Retirement

这条缝是为上游尚不具备的能力搭的临时覆盖层：一旦上游自己的会话 UI 也对 Assistant 正文（不止行内代码、不止对着产出文件词表）做可点引用扫描、并暴露出等价的 scan/open 契约，本补丁即退役，fork 改为适配上游的形式。
