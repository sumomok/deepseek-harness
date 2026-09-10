# Agent Note: 控制台的对话列重新呈现过程

Status: implemented

[English](2026-09-10-console-process-shown-again.md) | 中文

## Problem

控制台把对话列里的每一个过程行都隐藏了，把运行指示器重新写了文案，也把输入框的占位文案换掉了——这是[2026-09-07 的决策](../feature/2026-09-07-console-business-content-only.zh.md)，全部由 `packages/experimental/server-sidebar/src/client/terminology-guard.ts` 里的 CSS 规则承载。

产品负责人在 2026-09-10 把这个决策整体推翻，两半一起：过程要原样回来，被改过样式的输入框与指示器对产品来说是错的（「样式有问题，还是用以前的就行」）。一列只有问题与答案的对话，不给访客留下任何可读的运行经过；而每一次 `::after` 替换，在换掉文字的同时也换掉了输入框与指示器自己的排版。

## Decision

`terminology-guard.ts` 与 `tests/terminology-guard.client.spec.ts` 逐字节回到 2026-09-07 之前的内容，包 README 的中英双语也一并去掉那节记录被删规则的「只呈现业务内容」。样式表的 `STYLE` 常量此后只承载去术语化的那几条规则，别无其他。

控制台重新原样画出 `dsh-client-ui-chat` 与 `dsh-client-ui-conversation` 画的东西：工具调用行，含 `content_read` 自己的结果卡片；思考折叠盘；系统提示词面板；三个 kind 下的命令卡片（`command`、`manual-compaction`、`compaction`）；已完成轮次的折叠行；`context`、`model-retry`、`command-input`、`workflow-run` 与 `unknown` 行；回复页脚的用量与用时药丸；带着自己那句「深度求索中...」与 DeepSeek 色板渐变的运行指示器；以及 `InputBar.tsx` 那条占位文案阶梯上每一个状态的上游原文，包括「会话不可用」与英雄区文案。

仍然被隐藏的是[决策②自己的清单](../architecture/2026-08-30-server-sidebar-product-console-retrofit.zh.md)，本次改动不碰它：坐在输入框卡片之后的轮次/步骤统计行、英雄区的鱼形标记热区、PREVIEW 徽标、英雄区标题画出来的文案、英雄区的工作区选择器整行，以及输入框的权限预设选择器。

2026-09-07 那份 note 留在原处，作为「这些规则隐藏了什么、每一条选了哪种耦合、备选方案各自的代价」的记录；本 note 取代它。

## Alternatives considered

**只保留过程隐藏，单独重做输入框与指示器的样式。** 这次推翻先点名的是过程（「之前是不是让你把所有的过程都隐藏了？还原回来吧」），样式是第二句；只改那两处被重写文案的界面，会把负责人要求恢复的那些行继续留在隐藏状态。

**手工把样式表删减回决策②的那几条。** revert 这四个提交，会把规则、逐条解释耦合方式的模块文档、以及单元用例一起复原，而且结果可以用「与决策前的树相比是空 diff」来验证。手工编辑则要把这三样都重做一遍，描述被推翻决策的那些文字还会无声地留下来。

**给这些规则加一个 `Config` 字段，让部署自己选。** 没有任何部署要那一列被隐藏的对话；而这个字段会把其中每一处 DOM 耦合——kind 规则用的真属性，页脚、指示器与占位文案用的 CSS module 类名子串——继续养着，为一个无人选择的取值持续对抗上游改名。

**删掉 2026-09-07 那份 note。**[Agent Note 规则](../../README.zh.md#when-to-write-one)只允许通过把被取代 note 的每一条理由并入接管方来删除它。它记下的那些耦合、四条被否决的备选方案，以及无障碍方面的结论，正是将来再做同一个产品目标时需要的材料，而本 note 并不复述它们。

## Consequences

- 模型可见面没有任何变化，两个方向都没有。这是一个客户端插件里的浏览器 CSS：系统提示词、工具 schema、会话事件、模型请求都没有动，因此 `pnpm run test:snapshot snapshots/console` 不需要更新——理由与 2026-09-07 那份 note 给出的完全相同；web 泳道的 aria 基准也不受影响，因为每一个带基准的用例跑的组合都不会插入 `server-sidebar`。
- 控制台重新把这套 harness 完整的开发者流水呈现给终端客户，含系统提示词面板与每一个工具行。这正是本包在 2026-09-07 之前发出去的状态，也是产品负责人要的状态；将来若要一列更安静的对话，可以从本 note 的来龙去脉与被取代 note 里的那些耦合起步。
- 本包那两处针对整页的禁用词筛查（`workspaceWordsInChat`，以及 `apps/web/tests/server-sidebar.e2e.ts` 里对落位页 `body.innerText()` 的扫描）重新拿回被隐藏所削去的射程：`display: none` 会让一行不进入渲染文本，因此落在这种行内部的禁用词汇此前两处都读不到。

## Deferred

`apps/web/tests/server-sidebar.e2e.ts` 里仍然留着为被推翻的决策写的那组浏览器场景——种下的那个已结束轮次、逐 kind 的 `display: none` 断言、页脚药丸的读取、占位文案 `::after` 的读取、指示器的读取，以及它们共用的 `expectGuardHidesSelector` 辅助函数。它们断言的是本次改动移除掉的隐藏，因此在它们被一并删掉之前，那个 describe 会失败；本次一并 revert 的单元用例，才是钉住剩余规则的那一份。
