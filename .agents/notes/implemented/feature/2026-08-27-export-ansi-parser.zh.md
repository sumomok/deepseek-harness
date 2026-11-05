# Agent Note: 导出 ANSI 逐行解析器

Status: implemented

[English](2026-08-27-export-ansi-parser.md) | 中文

## 问题

`dsh-client-ui-primitives` 中的 `parseAnsiLines`（及其结果类型 `AnsiLine`）把原始命令输出转换为逐行的带样式 span——正是 `TerminalBlock` 渲染时所用的解析。它是 `ansi.ts` 内部私有的，未出现在该包的 `src/index.ts` 导出清单中，因此 `TerminalBlock.tsx` 之外没有任何代码能以同样方式对 ANSI 分词。一个 fork 内部插件要为终端输出加上可点击的指代（把输出中的某个路径或符号连接到另一个界面），需要与宿主渲染器完全一致地对 ANSI 分词；另写一份实现只会在任一实现改动时与之走偏，从原来的光标重放与 SGR 折叠行为分道扬镳。

## 决策

`parseAnsiLines` 与 `AnsiLine` 现为 `@deepseek-ai/dsh-client-ui-primitives` 的公开导出项，与其余 `TerminalBlock` 导出并列加入 `src/index.ts`。实现未作任何改动：解析器的光标重放、SGR 折叠与主题 token 映射与 `TerminalBlock` 内部一直使用的完全一致（逐字节相同），并保留 `ansi.ts` 原有的 JSDoc 约定。

## 备选方案

**把 `parseAnsiLines`复制一份到 fork 内部插件中。** 不予采纳：该解析器的光标重放与宽字符处理是精确对齐 `TerminalBlock` 自身渲染而调校的（见其模块文档）；一旦任一份实现改动，第二份副本便会走偏，导致两个 renderer 对同样的输出给出不同的分词结果。

**给 `TerminalBlock`加一个渲染 hook，而不是导出解析器本身。** 不予采纳：该 fork 内部插件渲染的是自己的界面，不是一个 `TerminalBlock` 实例，它需要的是解析后的 span 数据，而不是挂进 `TerminalBlock` 自身 JSX 的一个 hook。

## 后果

消费方包可以 `import { parseAnsiLines, type AnsiLine } from '@deepseek-ai/dsh-client-ui-primitives'`，获得与 `TerminalBlock` 完全一致的分词结果，无需 fork `ansi.ts`。该包的公开面增加一个函数与一个类型；`TerminalBlock` 自身的渲染保持不变。

**退役条件。** 本补丁是针对上游尚未提供能力的临时 overlay：若上游自行导出该解析器，或提供了一个终端输出渲染 hook、使得在 `TerminalBlock` 之外重新解析 ANSI 不再必要，即退役该补丁，并让依赖它的插件适配上游形式。
