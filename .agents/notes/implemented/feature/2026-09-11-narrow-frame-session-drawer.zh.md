# Agent Note: 控制台侧栏在 1024px 以下折叠为左上角汉堡抽屉

Status: implemented

[English](2026-09-11-narrow-frame-session-drawer.md) | 中文

## Problem

服务线控制台外壳（`packages/experimental/server-layout`）按固定的 24 份比例平铺四条栅格轨道，没有响应式行为。[session 栏下限](../bug-fix/2026-09-11-session-column-floor.zh.md)把展开状态的 session 栏钉在 180px，从而阻止窄框架把会话标题挤成一字一行——但这个下限会从手机宽度的窗口里拿走会话列表放不下的 180px，让 chat 栏在约 540px 以下跌破 360px。下限那篇 note 有意把抽屉或浮层作为「几何修复的范围之外」推迟了。产品负责人在 ~500px 下对控制台的截图，就是这份被推迟的工作现在需要做的报告。

## Decision

**在 `SIDEBAR_AUTO_COLLAPSE`（1024px）以下，session 栏整个离开栅格，它的列表移入一个由外壳画在内容之上的离屏浮层抽屉。** 整套机制都在 `server-layout` 里；sidebar 占用者（`server-sidebar`）不变。

- `tracks.ts` 在 `SESSION_RAIL` 与 `DETAILS_WIDTH` 旁新增两个约定冻结常量——`SIDEBAR_AUTO_COLLAPSE = 1024` 与 `SIDEBAR_DRAWER = 280`——一个纯谓词 `isNarrow(frame)`，以及 `solveTracks` 上的第五个 `narrow` 布尔。`narrow` 为真时，session 轨道解出 0（而不是 56px 控制条），content 与 chat 按各自的 16:5 瓜分 details 带剩下的部分，content 在为空时仍折叠到 0。只要框架为正，轨道之和仍等于框架宽度。断点以上的求解与下限那篇 note 逐字节一致。
- 面板 store 新增瞬态 `drawerOpen` 标志（默认 false）、`openDrawer`/`closeDrawer`，以及由 `setNarrow` 写入的 `narrow` 镜像。`toggleSidebar`——外部调用者通过 `ctx.layout` 触及的唯一折叠动词——在宽框架下表示折叠，在窄框架下表示抽屉，因为那时列在栅格之外、控制条无处可显。`setNarrow` 在框架重新变宽越过断点时强制关闭抽屉，因此不会有浮层残留到宽版面上。
- `ShellFrame` 把 `isNarrow(frame)` 镜像进 store，在窄且关闭时于既有的 `shell.overlay` 层里渲染一个左上角汉堡按钮，在窄且打开时把同一个 `sidebar` 槽渲染为左侧贴边、宽度 `SIDEBAR_DRAWER`（钳到框架）的抽屉，其后是一层遮罩。抽屉滑入、遮罩淡入，二者在 `prefers-reduced-motion` 下都不动画。打开时焦点移入抽屉、关闭时移回汉堡按钮，且不引入 focus-trap 依赖；因此背景从不被置为 inert，抽屉是带标签的 `role="dialog"` 但不加 `aria-modal`，汉堡按钮声明 `aria-haspopup="dialog"` 而非永远处于收起态的 `aria-expanded`。抽屉靠遮罩（指针）与 Escape 键（键盘）关闭。
- 文案由 locale 拥有：`sidebar.open`（汉堡按钮标签）与 `sidebar.navigation`（抽屉区域标签）同时加入 `serverLayout` 的 `zh` 与 `en` 词典。

**导航点击不会自动关闭抽屉。** `server-sidebar` 的 `open-nav.ts` 用 `resolveOrCreateSession({ reuseCurrent: true })` 解析导航目标，因此打开一个页面或视图是在*当前* session 里展示内容，而不是切换 session。没有 session 切换抵达 `ShellFrame`，所以它能观察到的当前 session 变化只对会切换 session 的打开（工作台、工作流）触发，而不是常见的页面/视图打开。与其不一致地关闭，抽屉在导航时一律不自动关闭；遮罩、Escape 与 `ctx.layout.toggleSidebar()` 是完整的关闭手段集合。

## Alternatives considered

**断点以下保留 56px 控制条（出厂外壳的折叠）。** 否决。`ui-layout` 在窄宽度把侧栏折成 56px 图标条，但本控制台的侧栏在决策①里就是渲染全部内容、从不折叠——它没有控制条 UI——而且 500px 框架上的 56px 列，仍是本产品的 content 与 chat 版面挤不出来的 56px。把这一栏整个移出栅格、按需把完整列表浮在内容之上，才能把窄框架的宽度全数还回去。

**宽版折叠控件（在桌面框架上折叠 session 栏的汉堡或开关）。** 作为未建的范围否决。控制台今天没有宽版折叠控件，发明一个是另一项产品决策；本次响应式工作只关窄框架。`toggleSidebar` 在宽框架下对任何想要的外部调用者仍照旧折叠。

**导航点击时自动关闭抽屉。** 首选但无法干净观察。它要么需要改 `server-sidebar` 向外壳发信号，要么需要盯着当前 session 的 content surface 条目看同 session 变化——那会加深包 README 已列为已知限制的那份无类型软耦合。只对切换 session 的打开关闭，会让抽屉的关闭在不同导航种类之间不一致，读起来比单一的手动关闭更差。因此抽屉交付遮罩 + Escape + 布局折叠动词，并把该限制写进文档。

**一个 `narrow` 配置项或可配的抽屉宽度。** 否决。断点与抽屉宽度与比例、控制条、details 宽度一样是约定冻结的几何，原因也一样：外壳的几何是固定的产品决策，好让注册方在每种组合下渲染一致。README 把它们列为约定冻结常量，而非缺口。

## Consequences

- 1024px 及以上的每个框架都与下限那篇 note 之后完全一致求解；只有其以下的框架改变，那里 session 栏为 0、抽屉承载列表。求和不变式在任何宽度都成立。
- sidebar 占用者不再在页面整个生命周期里只挂载一次，而是每次抽屉打开时重新挂载，因为它只在打开时才渲染进抽屉。这可以接受：窄路径不是控制台的主力桌面用法，且 sidebar 从 `useSessions` 读当前 session 自行重建。真正不能在切换时丢 DOM 状态的 content 栏则不受影响。
- 在抽屉里点击导航会让它保持打开；用户用遮罩或 Escape 关闭它。这是文档记载的限制，源于导航路径复用当前 session。

## Testing

`tracks.client.spec.ts` 钉住 `isNarrow` 在 1024/1023 边界、session 栏在 500px 离开栅格（session 0、chat 500）、details 带在窄状态下存活、窄且折叠的框架仍解出 0，以及端到端的断点边界；平铺属性测试新增 `narrow` 作为第四层循环。`panel-store.client.spec.ts` 覆盖 `openDrawer`/`closeDrawer`、`toggleSidebar` 在窄时选中抽屉，以及 `setNarrow` 镜像断点并在变宽时丢弃抽屉。`shell-frame.client.spec.tsx` 覆盖窄渲染（显示汉堡、栅格内 session 占用者消失）、以钳后宽度打开带遮罩的抽屉、焦点移入抽屉又移回汉堡、Escape 关闭而非 Escape 键不关闭，以及越过断点变宽清掉抽屉。每文件覆盖率仍保持 100%。
