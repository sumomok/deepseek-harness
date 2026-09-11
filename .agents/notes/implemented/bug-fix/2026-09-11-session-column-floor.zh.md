# Agent Note: the session column floors at 180px

Status: implemented

[English](2026-09-11-session-column-floor.md) | 中文

## Problem

`packages/experimental/server-layout/src/client/tracks.ts` 把外壳的四条栅格轨道按固定的 24 份比例求解——session 3、content 16、chat 5——它是「测得的框架宽度 + 三个布尔」的纯函数。这个比例没有下限，因此在 500px 宽的浏览器窗口里，展开状态的 session 栏解出 63px。会话列表在这个宽度里渲染中文标题，每个标题都被拆成一字一行；这一栏不是紧了一点，而是没法读。产品负责人在该宽度下对控制台的截图就是这份报告。

## Decision

**展开状态的 session 栏永不解到 `SESSION_MIN = 180` 以下。** 在 `solveTracks` 里，未折叠的这一栏是 `min(columns, max(SESSION_MIN, share(columns, 3, 24)))`，其中 `columns` 是框架宽度减去 details 带。content 与 chat 随后照旧按各自的 16:5 瓜分剩余，因此只要框架宽度为正，各轨道仍精确铺满框架。

180 正是 3/24 份额在 1440px 列宽下已经给出的值。因此 1440px 及以上的每个框架（details 关闭时）都与此前逐字节一致地求解，只有更窄的框架才会把这一栏抬到份额之上；下限在控制台实际使用的桌面宽度上什么都不改，只触及比例已经失效的那些窗口尺寸。窄于 180px 的框架把这一栏钉到框架宽度，而不是溢出。

下限是与 `SESSION_RAIL`、`DETAILS_WIDTH` 并列的约定冻结常量，不是配置字段：外壳几何是固定的产品决定，这样针对某一栏写出的注册方在每种组合下都渲染一致，包 README 也是这么陈述的。

下限不做的事：它不会自行折叠这一栏，不加断点，也不开抽屉。折叠后的栏仍渲染 56px 控制条，不受影响。约 540px 以下，即使 content 栏已折叠，chat 栏也会跌破 360px；在手机宽度的窗口里，折叠控件是把这份宽度要回来的唯一办法，README 的 Known Limitations 已如此写明。

## Alternatives considered

**在某个断点以下自动折叠 session 栏。** 否决。本包声明的几何是：求解是框架宽度与三个布尔的函数，没有让步链，因此一次 resize 复现同一布局，也没有什么需要恢复。折叠栏的断点给布局服务加了一个它不拥有的第四个输入——折叠是用户状态，经 `ctx.layout.toggleSidebar()` 切换——外壳要么在 resize 时覆盖这份状态，要么持有两份互相矛盾的折叠状态。它也修不了报告里的宽度：500px 的窗口高于任何还能让桌面可用的断点。

**在窄宽度下给会话列表做抽屉或浮层。** 以超出几何修复范围为由否决。那是一个带有自身打开状态、关闭与焦点处理的新界面，而出厂的 ui-layout 已经为需要响应式行为的部署提供了这种外壳。（这后来针对控制台在 1024px 以下落地了——见[窄框架会话抽屉](../feature/2026-09-11-narrow-frame-session-drawer.zh.md)。）

**把下限做成配置字段。** 否决。控制条宽度与 details 宽度之所以约定冻结，与比例冻结的原因相同，README 把「比例与控制条宽度是约定冻结的常量，不是配置项」列为已知限制，而非缺口。

**更小的下限，例如 150px。** 否决。150px 是 1200px 框架按比例得到的值，也正是截图里开始出现换行的地方；180px 是既能让采样标题不再两字一行、又恰好与比例已经产生的某个宽度重合的最窄值，因此改动在 1440px 及以上不可见。

## Consequences

- 500px 框架在 content 栏折叠时解出 session 180、chat 320；1440px 框架与此前一样解出 180；2400px 框架解出 300，即比例自己的答案。
- 1440px 到约 540px 之间的框架给 content 与 chat 的宽度少于比例本应给的；总和不变式在每个宽度上都成立。
- shell-frame 台架的 1200px resize 用例现在对 session 栏期望 180 而非 150，走的是它本来就用来对照的同一个 `solveTracks` 调用。

## Testing

`packages/experimental/server-layout/tests/tracks.client.spec.ts` 固定了 500px 下的下限（session 180、content 0、chat 320）、1440px 与比例的重合、2400px 下比例胜出（300）、120px 下的钉住（session 120、chat 0）、下限作用于 details 带留下的宽度（500px 且 details 打开：session 140），以及折叠的 500px 框架仍停在 56px 控制条上。铺满属性测试新增 120 与 500 两个采样宽度。
