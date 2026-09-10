# Agent Note: server-sidebar — the footer identity band is one row

Status: implemented

[English](2026-09-10-server-sidebar-footer-one-row.md) | 中文

## Problem

控制台底部并排画两样东西：谁登录了这台工作台、以及撤销它的那个控件（[身份显示与退出](2026-09-04-server-sidebar-identity-and-sign-out.zh.md)），还有 `sidebar.settings` 的占位方——[控制台改造](2026-08-30-server-sidebar-product-console-retrofit.zh.md)把两者并成了一条 `space-between` 带。这条带允许换行，而在部署方自己的窗口里它确实换了：名字与退出按钮在一行，设置触发器独占下一行。产品决定是一行——身份在左、设置在右——而样式表自己的注释早已宣称是这个版式，规则集做的却是相反的事。

换行不是疏忽。会话列是画面宽度的一个份额（`dsh-experimental-server-layout` 的 `solveTracks` 给它 24 份中的 3 份，因此 1568px 的画面得到 196px 的列，扣掉本外壳的内边距后是 172px 的内容宽），而这条带的三个固定部分——24px 的头像圆、退出按钮的文字、以及同时画图标与文字的设置触发器——在本控制台发布的两种语言里都超过了这个宽度。硬压成一行的结果，是把唯一可伸缩的那一项（名字）压到零，再让退出文字被身份簇自己的 `overflow: hidden` 切掉。

## Decision

**这条带永不换行，设置席位改要它的紧凑形态。** `.identityRow` 写明 `flex-wrap: nowrap`，渲染处传 `wide: false`——`dsh-client-ui-settings-general` 对这个取值画的是一个 36px 的图标按钮，而不是图标加文字。这是本列唯一放得下的触发器形态；有了它，这条带在控制台会跑到的最窄画面下也装得下。

**压缩顺序是写明的，不交给 flex 默认值。** `.avatarRow` 是 `flex: 1 1 auto; min-width: 0`，因此任何不足都由身份簇整个吸收；簇内只有 `.avatarName` 可伸缩，因此过长的名字会截断成省略号，而退出文字保持完整；`.settingsArea` 保持 `flex: none`，因此触发器永远不会被压得小于它画出的那个图标。`.avatarRow` 的 `overflow: hidden` 是这一切之下的最后一道：一列窄到连零宽的名字都不够时，被切掉的是身份簇自己的尾巴，而不是把触发器挤出这一行。

**紧凑形态的代价是记录下来的，不是吞掉的。** 那个包只在 `wide` 为真时画它的 `ConnectionIndicator`，而这个提示是本控制台唯一的断线通知、也是唯一的重连按钮，因此连接掉线时侧栏现在什么都不会说；包 README 把它连同唯一的补救方式一起列为 Known Limitation。也正是这条耦合让紧凑形态不只是「更窄」而已：那个提示坐在一个 `flex: none` 的席位里，因此在 `nowrap` 之下，一次掉线会当场把那个席位撑宽、把旁边的身份簇压垮。

## Alternatives considered

**保持 `wide: true`，让一行自己去解决。** 按上面的算术否决：带文字的触发器在两种语言里都会让 172px 的内容宽给名字剩不下东西，还会把退出文字一并挤出去——而这正是 e2e 场景对身份簇那条 `scrollWidth <= clientWidth` 断言存在的意义。

**保持 `wide: true`，用 `max-width` 卡住 `.settingsArea`。** 否决：占位方的文字带的是 `overflow: hidden` 而没有 `text-overflow`，被卡住的席位会把那两个字硬切掉而不是截断；同一条规则还会把连接状态提示一起切没——那是这个席位里唯一必须够得到的控件。

**按 `width` 这个 owner prop 选形态，超过某个像素阈值才带文字。** 否决：那等于把一个断点当作写死的可调参数塞进插件，而且会让断线通知随着窗口缩放忽隐忽现。

**把会话列加宽。** 在本次改动里否决，并记录为补救之路：`SESSION_UNITS` 是 `dsh-experimental-server-layout` 里与其余每一条轨道共用的、约定冻结的几何值，一条底部带不是移动它的理由。

## Consequences

控制台的设置入口是一个没有文字的齿轮图标，侧栏也没有任何连接反馈。两者都写在包 README 的 Known Limitations 里，连同能把它们换回来的那个列宽。

有两个测试钉住这套规则。`tests/identity-row-styles.client.spec.ts` 把样式表当文本读——jsdom 没有布局——断言这条带的 `nowrap`、压缩顺序、以及名字的省略号；`tests/server-sidebar-root.client.spec.tsx` 断言渲染处在这里要的是 `wide: false`，而在它上方那条整宽的 footer-action 行里要的仍然是 `wide: true`。Playwright 场景保留原有的「装得下」断言，并新增两个子元素共用同一条垂直中线。
