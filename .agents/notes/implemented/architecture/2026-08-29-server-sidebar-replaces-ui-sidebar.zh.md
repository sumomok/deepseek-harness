# Agent Note: server-sidebar replaces ui-sidebar through the overlay pattern, not a mid-column extension point

Status: implemented

[English](2026-08-29-server-sidebar-replaces-ui-sidebar.md) | 中文

## Problem

「改造」菜单（页面路由加收藏会话）需要一个座位，位置在会话列表上方、新会话按钮下方——在出厂侧边栏内部，而不是与它并排。出厂的 [`dsh-client-ui-sidebar`](../../../../packages/client/ui-sidebar/README.zh.md) 把 `sidebar` 声明为一个 `single` 槽，并在其自身组件内部声明五个子槽（`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`），新会话按钮与工作区浏览器之间没有留出座位——槽系统没有任何机制能让第三方往别人单占槽组件里插入第六个子项，把那五个 key 中的任何一个重复声明为不同类型都会抛错（`ui-slots` 会拒绝类型不同的重复 key；即便是完全相同类型的重复声明，对一个 `single` 槽唯一占位者而言也是第二次抢占）。

## Decision

**整体替换侧边栏，采用 [`dsh-experimental-server-layout`](../../../../packages/experimental/server-layout/README.zh.md) 替换 `dsh-client-ui-layout` 时已经用过的同一种做法。** `overlay/sidebar-menu.patch.yml` 禁用 `ui-sidebar` 行，把 `@deepseek-ai/dsh-experimental-server-sidebar` 插到它的位置。新包的 `ServerSidebarRoot` 逐字移植了 `SidebarRoot` 的整套行为契约——56px 折叠态窄栏、150ms 的宽内容淡出、只在「活的」折叠上生效而非冷启动直接进入折叠态的 `.railIn` 动画、以及随指针显隐的滚动条停留逻辑——并以同样的 kind 与 scope 重新声明那五个子槽注册，因此 ui-workspace 与 ui-settings 既有的注册、以及任何填充这两个身份槽的品牌包，都无需对那些包做任何改动即可继续工作。这个外壳在这份契约之上唯一新增的东西，就是新会话按钮与 `sidebar.workspaces` 区域之间的菜单区。

这个决定押在两个工程细节上：

- **运行期注册与 TypeScript 声明用了不同的复用方式。** `ctx.slots.register({ children: {...} })` 调用要被完整地重新写一遍——声明即是抢占，不论另一个包是否已经声明过完全相同的规格，每个注册方都要陈述自己的子项。而那五个 key 对应的 `SlotMap` TypeScript 接口扩展，则通过对 `@deepseek-ai/dsh-client-ui-sidebar/client` 的仅类型导入来复用：第二次类型相同的扩展是合法的（`ui-slots` 只拒绝*冲突*的重复声明），但导入类型能让注册方的编译期契约始终有一处文档化的真源，不论组合了哪个侧边栏；而且仅类型导入在构建时会被完全擦除（`type`-only 导入不产生任何模块图请求，因此在打包产物里零成本）。
- **确认了没有别的东西需要迁移。** 这个决定所依循的先例此前已经漏掉过一次东西（server-layout 自身的主题投影迁移记录在它 README 的组合方式一节里，而非某篇专门的 Agent Note）——因此在把「替换即客户端半边就是全部契约」这个判断落笔之前，先直接读了出厂 `ui-sidebar` 的 node 半边：`export function apply(): void {}`，一个没有配置、没有服务、不追加任何会话事件的空占位符。host 侧没有任何东西需要迁移，本包自己的 node 半边只为下文的收藏功能而存在，出厂侧完全没有对应物。

## Alternatives considered

**向槽系统要一个 `SidebarRoot` 组件内部的插入点。** 拒绝：这需要 `dsh-client-ui-sidebar` 自己新增一个没有任何出厂消费者需要的槽（`sidebar.menu` 或类似），把一个实验性包的需求变成官方外观的永久新增。overlay 替换模式完全不需要改动上游。

**把菜单组合成 `sidebar.footer.action` 列表的第六项。** 拒绝：那个槽是仅 `wide` 态的底部空间（设置触发器、其他底部动作），既没有为一个两分组的导航菜单预留 scope 或样式，其 owner share 里也没有容纳页面清单或收藏数据的空间。

**直接原地 fork `dsh-client-ui-sidebar`（改动官方包本身）而不是 overlay 替换它。** 被本仓库自身的耦合规则拒绝：为一个实验性部署的需求跨包修改官方包，正是 overlay 替换模式存在的意义所在；这样做还会让 ui-sidebar 未来的每一次改动都与这份部署自己的 fork 产生冲突。

## Consequences

想要这个改造菜单的组合携带 `overlay/sidebar-menu.patch.yml`（通常与 content-frame 自己的 overlay 一并携带，让页面路由组有东西可列）。`dsh-client-ui-sidebar` 本身不受触碰：任何不组合这个 overlay 的部署都不受影响，官方包自身的测试、快照与未来的改动都无需知道这次替换的存在。

这次替换唯一给不了 ui-sidebar 消费者的东西，是这次移植*之后* 出厂侧边栏可能新增的任何东西：一个新 prop、一个新子槽，或者 `SidebarRoot` 的几何改动，都会先落到 `dsh-client-ui-sidebar` 里，需要手工再移植到 `ServerSidebarRoot`——没有任何机制会自动让两者保持同步。这与 `server-layout` 相对 `ui-layout` 早已承担的维护成本相同，不是新增的负担。
