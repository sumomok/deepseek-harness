# Agent Note: 不再悄悄吞掉不被允许的链接目的地

Status: implemented

[English](2026-08-27-markdown-link-destination-fallback.md) | 中文

## 问题

`dsh-client-ui-primitives` 直出 markdown renderer（`src/markdown/render.tsx`）中的 `renderSafeLink` 会按协议白名单（`http:`、`https:`、`mailto:`）检查链接目的地。一个未通过白名单的目的地——相对路径（`[text](relative/path.ts)`）、绝对本地路径、`file:` URL，或其他不受支持的 scheme——此前渲染为包裹链接子内容的一个裸 `Fragment`：链接文字保留了下来，但目的地本身被悄悄丢弃。读者完全无法得知这里曾经存在过一处链接，更不用说它指向哪里。

## 决策

一个不被允许的目的地现在渲染为链接的子内容，后跟以可见、不可交互文本形式呈现的目的地：`文字 (目的地)`。展示的文本就是原本已算好、作为候选 `href` 的那个字符串（对 `link` 或引用型节点而言即经归一化的 `mdast` 目的地），不会另行推导。fallback 不用任何元素包裹——它是纯文本，不带 `href`、没有可点击目标，也没有任何可能被误认作活链接的样式。`title` 属性被否决，理由与原先 Fragment 存在的问题正是同一个：两者都要指针悬停在文字上才可见。协议白名单本身（`sanitizeUrl`）未作改动，只改变了不允许分支的渲染方式。

渲染出的 markdown DOM 由 `tests/fixtures/markdown-dom` 逐字节固定。`links-and-autolinks.settled.txt` 与 `links-and-autolinks.streaming.txt` 已更新为新渲染结果——该段落的文本行由 `relative dropped and js dropped and ` 变为 `relative dropped (/settings) and js dropped (javascript:alert(1)) and `——这是一次刻意、经过评审的行为变更，而非为掩盖重构而重录。`markdown.client.spec.tsx` 中的中和测试同步更新。

## 备选方案

**保留 Fragment，改为添加一个写明目的地的 `title` 属性。** 不予采纳：`title` 在指针悬停之前不可见，因此扫读渲染后文字的读者——或通过无悬停的辅助技术阅读的读者——仍然看不出这里曾经有一处链接。

**把目的地样式化为行内代码（`<code>`）。** 不予采纳：现有的行内代码路径是留给真正的 Markdown 代码片段，以及行内代码本身即是活链接的唯一情形（完整的 HTTP(S) URL）；把这份呈现方式挪用到一个无关的 fallback 上会把两者混为一谈。

**丢弃目的地，只标记“该链接失败”（例如一个警告图标）。** 不予采纳：重点在于让读者看到链接指向哪里，而不只是知道有什么东西被略去了；一个不带目的地文本的图标只是换了个形状重现原来的问题。

## 后果

读者始终能够看出这里曾经存在一处链接，并看到其目的地，即便该目的地无法成为活链接——补上了不受信任 markdown 渲染中一处静默丢数据的缺口。一个不被允许的链接目的地现在渲染出的文本更长（链接文字加上括号中的目的地）；两个已更新的 DOM 一致性 fixture 与 `markdown.client.spec.tsx` 中的断言固定了新文本。

**退役条件。** 本补丁是一个临时 overlay：若上游自身的 markdown renderer 不再悄悄丢弃一个不被允许的链接目的地，即退役该补丁，并让 fork 适配上游的渲染方式。
