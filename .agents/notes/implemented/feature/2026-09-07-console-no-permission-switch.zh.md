# Agent Note: 客户控制台不提供权限开关

Status: implemented

[English](2026-09-07-console-no-permission-switch.md) | 中文

## Problem

客户控制台此前只藏起了三个权限控件中的一个，另外两个照常可用。

`terminology-guard.ts` 用 CSS 藏掉了输入框的权限 chip——它的「Workspace Write」标签由预设的机器名逐词首字母大写转出，没有任何 locale 条目或可禁用的行能触达它。这关掉的是这层 CSS 看得见的那个入口。它没有关掉 `/permission`：只要组合里有命令注册表，`@deepseek-ai/dsh-permission-presets` 就会注册这条命令，而控制台的斜杠菜单把它和 `compact`、`feedback` 一起列给每一个访客。它也没有关掉 Settings → General 的默认预设行——那是 `@deepseek-ai/dsh-client-ui-permission-presets` 自己的注册，写的是后续新会话的 `permission.defaultPreset`，并通过 Settings 缝盖过组合层推断出的默认值。

于是客户表单部署交付的是这样一个页面：权限 chip 看不见，而通往同一个旋钮的两条写入路径一个点击、一句手打之外就在那里，包括通往完全放开的那条。产品决策（2026-09-07）是：控制台不向终端用户提供任何形式的权限开关。

## Decision

**三个入口全部关掉，各用能够到它的最省的一种手段。** chip 继续由 CSS 隐藏（不变）。Settings 那一行作为一条普通的 overlay 行直接禁用。`/permission` 则通过隔离它注册所经的那个服务，让它从未被注册。

**在 `permission` 行上写 `isolate: { commands: true }`。** 内置的 loader 接受按 entry 的 `isolate` 映射（`vendor/loader/src/config/isolate.ts:5-14`），并在 `loader/patch-context` 时把该 entry 的 isolate 映射换成每个被隔离名字一个新铸的 realm 符号（`:96-100`）。`isolate: true` 铸的是一个 entry 本地的 realm，没有任何东西向那里提供服务，因此 `packages/interaction/permission-presets/src/index.ts:269` 的 `ctx.inject(['commands'], …)` 永不激活，这条命令也就从未注册：`commands.list` 不会点到它的名字，而本身没有过滤缝的斜杠菜单也没有需要过滤的东西。插件依旧被无条件加载，这一行上也没有别的东西被隔离，因此预设表、`permissions` 投影、该包安装的 Settings 分区，以及权限执行本身，都原样不动。这个键早已被 `scripts/verify-cordis-config.ts:39` 当作字面 entry 元数据接受，出厂配置里也已在用（`packages/preset/agent-presets/presets/standard/agent.cordis.yml`、`apps/cli/config/examples/github-review/cordis.yml`）。

**隔离是按 entry 生效的，这正是这里能用它的全部理由。** 注册表本身必须留着：`@deepseek-ai/dsh-commands` 由 `packages/bundle/base/cordis.patch.yml` 组合进来，而控制台在两个平面上都依赖它——内容列切换条派发 `dismiss-content-entry`/`select-content-entry`，侧栏导航行派发 `show-content-page`/`show-content-view`，`show_component` 的按下回传路径经由它从浏览器走到宿主，`SessionFace.command()` 则是通用的命令发送。它们每一个拿到的都还是 base bundle 组合进来的那个注册表；只有这一个 entry 看到的是一个这个名字解析不到任何东西的 realm。

**`defaultPreset: workspace-write` 是写明的，不是推断出来的。** 不写 `defaultPreset` 时，`PermissionPresetService` 会把组合出的沙箱与审批默认值按声明顺序在表里折叠匹配（`src/index.ts:207-211, 327-338`）。`packages/bundle/base/cordis.patch.yml:220-239` 的两个旋钮都由同一个 `DSH_PERMISSION_MODE` 表达式导出，它未设置时的默认是 `workspace-write` + `ask`，而控制台 overlay 的表里恰好只有一行是这一对——所以控制台今天钉住的就是 `workspace-write`，写明它不改变这份部署的任何行为。它换来的是：这个预设不再取决于一个没有任何控制台会设置的环境变量。config 写明它，`pinInitialPermission`（`src/index.ts:423-435`）把它钉进每一个新会话，而 chip 的 `aria-label` 是它唯一还被读到的地方。它是下限，不是常量。`installSection` 是把它当组合层 `base` 传进去的（`src/index.ts:213-232`），而 settings 服务的解析顺序是 schema 默认值、然后 `base`、然后用户层（`packages/settings/settings/src/index.ts:739`），因此部署的 settings 文档里已经存下的 `permission.defaultPreset` 仍然胜出，被钉进去的也是它。被禁用的那一行 Settings 正是写这个键的界面，移除它抹不掉任何已经写下的值——从访客用过它的版本升级上来的控制台，会带着那个预设，而此后没有任何界面能展示或改动它。补救办法是把这个分区——一个 `permission:` 键，下面缩进一行 `defaultPreset: <名字>`——从 `<harness home>/settings.yaml` 里删掉（即 `$DSH_HOME/settings.yaml`，否则 `~/.dsh/settings.yaml`，再否则 `settings-file` 那一行配置的 `path`；`packages/settings/settings-file/src/index.ts:23-24,51-57`）。没有任何组合层的键能清掉或钉住它：`base` 是 cordis.yml 的一行唯一能提供的那一层，而作为重置手段的 `SettingsScope.replace({})` 是拥有方的运行期调用。

**残留是一句手打的文本，且被接受。** `/permission read-only` 仍然会提交。在运行中的浏览器泳道里实测：这个名字下既没有宿主描述符也没有客户端贡献，`matchEnter` 解析不出任何东西（`packages/client/ui-commands/src/client/service.ts:343-344`），触发层的 Enter 裁决返回 `undefined`（`ui-input-trigger/src/client/controller.ts:319-329`），输入框的默认落点把这一行当作普通文本提交。它作为一条内容就是字面量 `/permission read-only` 的 `user/message` 落到日志上，开启一个轮次，并作为这两个词抵达模型。没有 `permission/preset` 事件被追加，权限 chip 的 `aria-label` 仍然是被钉住的那个预设。界面上没有任何东西对这个字符串作出回应。

**server 部署该如何控制权限，是另一件待办。** 本次改动关掉的是终端用户侧的入口，并钉住这份部署的预设；它没有设计面向运维方的控件。

## Alternatives considered

**在客户端把这一行过滤掉。** 没有缝。`CommandUiContract` 只能增：`register` 只能添加一个客户端行——重复的贡献名在注册时抛错（`packages/client/ui-commands/src/client/service.ts:171-181`），与宿主命令重名则在菜单构建时抛错（`:258-262`），两者都影子化不了 `permission`；`decorate` 明确既不能凭空造出一行也不能移除一行（`src/client/contract.ts:69-72`），`candidates()` 没有任何钩子，宿主的 `list()` 则是一个返回冻结有序数组的普通 `@Remote` 方法——没有 waterfall，没有否决权，`CommandDescriptor` 也不携带可见性位。

**照着 chip 的办法用 CSS 藏掉这一行。** chip 那一招无法复用。`MenuView.tsx:133-137` 给每个选项的 id 由分组名加一个随每次查询变动的位置下标拼成；没有 `data-name`，没有按命令区分的类名，也没有按文本匹配的选择器。用 slot 优先级去影子化整个 `conversation.input.overlay`/`slash-menu` 在技术上够得着，但 `MenuView` 未导出、其 CSS module 是私有的，那意味着要在 `packages/experimental` 里重写一个上游组件连同它的样式。

**把 `commands` 注册表从控制台组合里拿掉。** 那会弄坏切换条的标签、侧栏的导航、component-surface 的每一次按钮按下，以及通用的命令发送。四个消费者，全是我们自己的。

**从控制台自有的 agent preset 里作用域影子化 `permission`。** `ScopedLayers.merge`（`packages/core/scope/src/store.ts:208-217`）允许挂在某个 agent ctx 下的插件抢到这个名字，替换掉处理器与描述。但它删不掉这一行——`list()` 返回的是合并视图，里面依然恰好有一个 `permission` 描述符——所以菜单还是会列出它。它还需要一份控制台自有的 agent preset，比一个 YAML 键的机械量大得多。

**给 `permission-presets` 加一个 config 开关。** 它的 `Config` 恰好只有 `presets` 与 `defaultPreset`（`src/index.ts:156-190`）；一个「抑制命令」的开关会是一次上游改动，而在存在组合层答案的地方，本 fork 的既定规矩不允许这么做。

**把 overlay 的预设表裁成控制台实际交付的那一个预设。** 那会让被钉住的预设不言自明，也缩小标签漂移守卫要覆盖的面，但它扔掉的是后续面向运维方的控件要配置的那张表，而在另外两个名字都不被渲染的当下，用户可见的收益为零。

## Consequences

- 控制台的斜杠菜单列出八条命令，`permission` 不在其中；Settings → General 面板没有权限行；权限 chip 存在、隐藏，并钉在 `可修改文件` 上。
- 访客手打 `/permission` 得不到任何菜单行，也得不到拒绝——这一行作为文本抵达模型（见上文的残留，以及包 README 的「已知限制」）。
- 升级之前存下的 `permission.defaultPreset` 仍然盖过 overlay 的值，而且已经没有任何界面能改动它；优先级链与部署清掉它的办法见上文 Decision。`remote.settings` 也依然是一条浏览器够得到的写入路径——那是一台不带应用内鉴权运行的控制台的固有属性，不是这里的退化。
- `DSH_PERMISSION_MODE` 不再改变控制台的默认预设。它仍然改变组合出的沙箱与审批旋钮，因此把它设成 `workspace-write` 以外的值的部署，组合出的会是一个由被钉住的预设按会话覆盖掉的错配，而不是一个悄悄不同的默认值。没有任何控制台设置它。
- `apps/web/tests/` 下那三份控制台 overlay 是出厂行的副本而不是 include（`extraOverlayPath` 只接受一条路径），因此它们之间可能漂移；`packages/experimental/server-sidebar/tests/customer-overlay.client.spec.ts` 会把每一份副本与出厂行比对。
- 模型可见的东西没有任何变化：`commands.list` 是一个抵达不了模型的 Remote 方法，运行时上下文消息报告的仍是 `workspace-write` + `ask`。

## Testing

`packages/experimental/server-sidebar/tests/customer-overlay.client.spec.ts` 用 `js-yaml` 与 loader 的 entry schema 解析出厂 overlay（沿用 `packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` 立下的做法），钉住原先由 e2e 守着的那个闭集：表序下的三个预设 id、它们面向客户的名字、`isolate.commands === true`、一个点名其中之一的 `defaultPreset`，以及 `ui-permission` 禁用行——然后断言 `apps/web/tests/` 下那三份 overlay 携带的这两行完全一致。它是一个 YAML 文本钉，对 loader 一无所知：`isolate` 的语义在一次 `vendor/` 同步中变了，或者 `permission-presets` 把注册挪到它的 `static inject` 上，它都会照样是绿的。那个机制唯一的覆盖是下面那条浏览器泳道，而 `pnpm run test` 不跑它。

`apps/web/tests/server-sidebar.e2e.ts` 的预设场景已经够不着，替换为一个在装配好的浏览器里读这三个入口的场景：输入框里一个裸 `/` 会列出控制台的整个命令集（`compact`、`content-navigated`、`dismiss-content-entry`、`feedback`、`goal`、`plan`、`select-content-entry`、`show-content-page`），因此这份组合新增一条命令时同样会失败；Settings → General 渲染出它自己的一条出厂行且没有权限行；chip 则通过既有的 `expectGuardHides` 助手断言「存在且不可见」，并停在被钉住的那个预设名字上。这个场景对着一个故意改坏的构建验过：把 `isolate` 键从 e2e overlay 里去掉后，菜单列出九行，用例在多出来的 `permission` 上失败。

`snapshots/console` 在快照泳道里是跑起来的——这次搬迁由[重新安置笔记](../process/2026-09-07-console-snapshot-lane.zh.md)持有。这里不需要它做任何事：它组合的是后端骨干，带着 `@deepseek-ai/dsh-commands` 而完全没有 `permission` 行，并且从不应用 `overlay/customer.patch.yml`。它自己的 `cordis.yml` 记着，浏览器那些行的证据在 `apps/web/tests` 下的 Playwright 泳道，而本次改动的证据正在那里。
