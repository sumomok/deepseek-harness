# Agent Note: The product-console line on the 0.1.7-rc.2 base — the menu as Config, the shell on `main`/`rightbar`

Status: implemented

[English](2026-09-26-server-console-on-the-rc-2-base.md) | 中文

## Problem

0.1.7-rc.2 基座移除了控制台这条线赖以构建的三处接缝。settings 能力不再提供插件自有的命名空间：`settings.register`、`SettingsScope`、`settings/updated` 事件与 `settings.yaml` 文件 provider 都已删除，settings 服务现在编辑插件 `Config` 中声明为 `.volatile()` 的字段。出厂外壳的 root 子槽现在是 `sidebar`、`main`、`rightbar`、`shell.overlay` 与 `shell.leading`；`conversation`、`details`、`ILayout.openDetails/closeDetails` 以及 `SessionProvider` owner prop 都已删除。Session Controller 不再发布当前选择：`SessionListState.current`、`ISessions.open` 与 `SessionSummary.completed` 都已删除，Conversation 就是 `ui-workspace` 以 `mainView` 来源持有的那个会话。在这个基座上，侧边栏那一行加载即抛错，控制台没有侧边栏，外壳还声明着没有任何注册方会注册进去的槽。

## Decision

**工作台/工作流菜单是 server-sidebar 这一行自己 Config 里的三个 volatile 字段。** `workflows`、`groups` 与 `workbenchSessionId` 在这一行上声明为 `.volatile()`，server-menu 路由用 `ctx.settings.update(<entry id>, fields)` 写入补丁，与 `speech-to-text` 写自己偏好的方式相同。路由在写入前把每个被补丁的字段过一遍各自的 schema，并用 `validateServerMenu` 检查合并后的菜单；这一行在加载时再检查一次已提交的菜单。这一行注册 `configure({ auto: false })`，因为侧边栏就是这些字段的编辑器，自动生成的页面会成为第二个、未经校验的编辑器。条目 id 保持 `server-sidebar`：settings 服务会把早先版本 `settings.yaml` 的每个分区导入同名 id 的条目，因此存在该分区下的菜单无需产品自己的导入器就能到达这一行。invariant 伴生插件被移除——它监听的 `settings/updated` 已不存在，而已提交的值是 Loader Config，没有第二个能与之分歧的观察点。

**控制台是一个 bundle 层；它的 `permission` 行是叠在 profile 补丁之上的锁。** settings 服务把 volatile 字段保存进当前 profile 的 `cordis.patch.yml`，而当某行的有效配置来自该补丁之上的层——`--patch` overlay 或 home 补丁——时，config-editor 会拒绝写入。控制台原先以 `dsh --profile web --patch <overlay>` 组装，因此每一次菜单写入都失败。现在 `@deepseek-ai/dsh-experimental-console-profile` 把原来的 `server-sidebar/overlay/customer.patch.yml` 作为自己的 `dsh.bundle.patch` 携带，用 `dsh plugin --profile web add` 安装在 `dsh-base` 与 `dsh-web-app` 之后；部署自己的行（页面与视图目录、登录门、`trustedHosts`）放进部署自己的第二个本地 bundle。`permission` 行则反方向移动，进入该包的 `permission-lock.patch.yml`，由部署以 `--patch` 或 home 补丁应用：`permission.defaultPreset` 同样是 volatile，`remote.settings` 回应任何被放行的浏览器，放在 bundle 层里时一次写入就会压过钉住的 `workspace-write`。

**外壳声明出厂的子槽，并保留自己的 `content` 座位。** `server-layout` 仍然替换 `ui-layout` 的 root 注册。chat 栏按选中面板所指的 key 渲染 `main`（默认是 `conversation`）；右栏把 owner 份额交给 `rightbar`（`width` 是固定的 360px details 宽度），并在占用者通过 `openRightbar(true, …)` 报告占用轨道时预留 details 轨道；`shell.leading` 已声明但从不挂载，因为本外壳从不把 session 栏整个隐藏。root effect 创建框架渲染所用的那一个 panel store 实例，把 `ILayout` 面（`panelInfo`、`selectPanel`、`beginNavigation`、`toggleSidebar`、`openRightbar`、`closeRightbar`）绑到它的 actions 上，把 `usePanelInfo` 作为 root 标准 hook 提供，并在某个 `main` 条目注销时清掉指向它的选择——与 `ui-layout` 用的是同一套接线，因此 `ui-workspace`、`ui-conversation` 与 `ui-sidebar-right` 零改动注册。

**屏幕上的会话就是 `mainView` 那一行。** 原先每一处读 `current` 的地方，现在都读 `retainedBy.mainView` 计数为正的那一行，与上游自己的消费方用的是同一个表达式；每一处 `sessions.open(id)` 都换成 `ctx.uiWorkspace.openSession(id)`，它还会经 `ILayout.selectPanel` 中止一次挂起的导航。绿点读取 `useSessionStatus` 的 `completionUnread`。

**Vue 2 的全局 JSX 类型不进入 Client 聚合程序。** `vue/types/jsx.d.ts` 给全局 `JSX.IntrinsicAttributes` 加上了 Vue 的 `ref`，Vue 包的 spec 与聚合程序共处之后，上游四处 React `ref` prop 因此报错。会触及 Vue 2 声明的 spec（`component-kit` 与 `vue2-echarts-poc` 的全部、`component-surface` 的两个）在 `tsconfig.vue2-tests.json` 里做类型检查；这是一个按编译面划分的叶子配置，由 `tsconfig.client.json` 引用，后者把这些 spec 排除在外——与 `tsconfig.desktop-keyboard-tests.json` 的形态相同。

**三条内容命令声明 `engages: false`。** 基座的 Session 列表现在遇到任何未声明 `engages: false` 的 `command/run` 都会清掉 `blank`，而本线原来只在 `turn/start` 时清掉它。`show-content-page`、`content-navigated` 与 `show-content-view` 只安排内容栏、不增加回合，所以三者都声明 `engages: false`：只显示过页面或视图的工作台草稿仍是空白草稿，第二次点工作台会复用它，临时分组也不会列出它。

**控制台 bundle 声明自己的 `console` Agent 预设，由锁把它定为默认。** 在更早的基座上，控制台跑的是 `dsh-agent-presets` 从 `$DSH_HOME/.agent-presets` 读入的 `console` 预设；0.1.7-rc.2 删掉了那个包，预设改为 `@deepseek-ai/dsh-agent-preset` 行，控制台于是悄悄退回出厂 `standard` 预设，带着 shell、搜索、后台任务、目标、计划、委派与 web 工具。现在 bundle 层插入 `preset-console`，行与旧预设相同——persona（它的 `text` 即 rc.2 的 `prefix`）、`tool-fs`、`skill-filesystem`、`tool-skill`、压缩组、`tool-ask-user` 与 `tool-todo`——锁 overlay 带上 `agent-preset-registry` 行，`default: console`。registry 行放在锁里而不是 bundle 层，理由与 `permission` 相同：`selectedDefault` 是任何被放行的浏览器都能写的 volatile Config，而指向控制台未声明预设的值会让每个新会话以 `agent-preset/not-found` 失败。bundle 层还禁用 `preset-standard`、`preset-ptc`、`preset-minimal` 与 `preset-cordis`：控制台没有预设选择器，但 `session.create` 经 RPC 接受 `agentPreset`，所以 registry 列出的预设只有 `console`。

## Alternatives considered

**由产品自带导入器把菜单从 `settings.yaml` 复制到自己的存储里。** settings 服务已经会把每个分区导入同名 id 的条目；第二个导入器将拥有一个基座已经退役的文件，以及一条 settings README 明确告诉插件不要自己拥有的持久化路径。

**把菜单字段做成一个嵌套的 volatile 对象。** 单个 `menu` 字段可以让一个 schema transform 在解析时检查跨字段约束，但导入的 `settings.yaml` 分区把这三个字段放在顶层，导入会因此拒收它。

**在 `loader/volatile-update` 上保留 invariant 伴生插件。** 伴生插件是一个独立插件，拿不到这一行的 Config；而对路由刚刚校验过的值再跑一遍 `validateServerMenu`，正是包 invariant 规则拒收的那种检查。

**给 `ui-layout` 打补丁保留 `conversation`/`details`。** 基座为了 `main` 与 `rightbar` 移除了它们；在核心里恢复它们会成为一个与上游选定方向相悖的永久补丁，而外壳完全可以从自己的包里占用新的槽。

**让控制台保持为一份 `--patch` overlay。** settings 服务必须保存的每一行都会留在 profile 补丁之上，config-editor 会继续拒绝菜单写入。

**把控制台的每一行（包括 `permission`）都移进 bundle 层。** 菜单能保存了，经 `remote.settings` 发来的 `defaultPreset` 也同样能保存；2026-09-07 那条「终端用户不能改预设」的决策就不再成立。

**把 registry 默认值放在 bundle 层。** bundle 层的 `default: console` 让 `selectedDefault` 仍可经 `remote.settings` 写入，一次写入就会让会话无法启动。

**让 Vue spec 留在聚合程序里，改动上游那四个 spec。** 那四处 `ref` prop 是正确的 React 写法；问题出在一个 React 程序本不该看见的包所带来的全局声明。

## Consequences

控制台重新带着侧边栏启动，菜单在重启后存活于 profile 补丁中，而不是一个旁路文件里。部署启动 profile 时装好控制台 bundle 与自己的 bundle，并带上 `--patch permission-lock.patch.yml`；仍以旧 overlay 作 `--patch` 启动的部署能起来，但存不下菜单；不带锁启动的部署会让钉住的预设变得可写。被手工改进 profile 补丁、违反某条跨元素约束的菜单会让这一行在加载时失败，而不是等到下一次写入。`settings.yaml` 里以改版前 `navSnapshot` 字符串形式存下的分区会被导入拒收，留在 `settings.yaml.imported` 里；用 `convert-nav-snapshot` 转换该文件并改名回去，下次启动就会再导入一次，连同其中的其他所有分区。

右栏现在是 root scope，会话切换不再让它重挂；它的占用者自己绑定会话。旧基座上 `details` 装的是工具详情；`rightbar` 装的是 `ui-sidebar-right` 渲染的东西。

旧基座上重述的 `recentWorkspace` 仍留在 `session-resolution.ts` 里；原因由 [alpha-5 那篇 Note](2026-09-03-server-console-on-the-alpha-5-base.zh.md) 负责。
