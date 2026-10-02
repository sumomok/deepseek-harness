---
description: "把客户控制台作为一个 bundle 层组合到 Web profile 上，并附带一份由部署叠在 profile 补丁之上的权限锁。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-console-profile` 把一个 `web` profile 变成客户控制台。它的 bundle 层换上服务外壳与产品侧栏，禁用那些会显示内部术语或开发者工具的出厂界面，挂载库技能，在上下文窗口用到 60% 时压缩对话，声明 `console` Agent 预设，并禁用全部出厂 Agent 预设。它的第二个文件 `permission-lock.patch.yml` 在 profile 补丁之上的层里钉住控制台的访问预设，并把 `console` 定为默认 Agent 预设。拆成两份依据一条规则：侧栏菜单必须能由 settings 服务保存，而钉住的预设不能被保存。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

在本仓库检出目录里，把 bundle 加进 `web` profile，再带着锁 overlay 启动这个 profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/console-profile
pnpm dsh --profile web --patch ./packages/experimental/console-profile/permission-lock.patch.yml
```

`dsh plugin add` 链接本包，并把它追加到 `dsh.profile.bundles` 里 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后。锁也可以作为 home 补丁 `$DSH_HOME/cordis.patch.yml`；这两层都组合在 profile 补丁之上。

### 加上部署自己的行

本 bundle 不组合页面目录（`content-frame`）、视图目录（`component-surface`）和登录门（`auth-gate`）；它们各自带着部署专属的配置。把这些行放进部署自己的本地 bundle——一个目录，里面有 `cordis.patch.yml`，以及一份声明 `"dsh": { "bundle": { "patch": "cordis.patch.yml" } }`、并在 `dependencies` 里列出每个被插入包的 `package.json`——再用 `dsh plugin --profile web add <dir>` 加入，让它叠在本 bundle 之后。设置页会保存的行不得由 `--patch` 或 home 补丁插入或配置；任何人都不能改的行才放在那里。

### 获得的功能

控制台 bundle 在出厂 Web profile 之上组合这些改动：

| 行 | 改动 |
|---|---|
| `server-layout`、`content-surface`、`content-column` | 插入：四轨服务外壳及其内容栏 |
| `server-sidebar` | 带 `displayNameClaim: login_uname` 插入；它的菜单保存进 profile 补丁 |
| `console-mcp` | 带 `servers: []` 插入：MCP 能力，在部署点名服务器之前不做任何事 |
| `library-skills` | 插入：一个以 `@deepseek-ai/dsh-experimental-library-skills` 为根的隔离 `skill-filesystem` provider |
| `page-refresh` | 插入，并写明它的默认配置：服务端换了构建后，已打开的页面重连时刷新一次，横幅提示连接断开；见 [`dsh-experimental-page-refresh`](../page-refresh/README.zh.md) |
| `client-hmr` | 禁用：已打开的页面不再把新的插件包换进它正在运行的外壳。`pnpm run dev:web` 重新构建的插件包在宿主重启之前不会到达任何控制台页面，无论是已打开的还是新加载的；重新构建的外壳在下一次加载时就会服务出去，已打开的页面在下一次构建检查时刷新到这个外壳上，配的仍是旧插件包 |
| `ui-layout`、`ui-sidebar` | 禁用：它们的单一槽位由外壳与侧栏占用 |
| `ui-agent-preset`、`ui-brand-official`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`、`ui-settings-models`、`ui-permission`、`ui-settings-session-log` | 禁用：内部术语、官方品牌与开发者界面 |
| `ui-settings-plugins`、`ui-settings-plugin-inventory` | 禁用：设置 → 插件的两个标签页；设置外壳 `ui-settings-general` 保留 |
| `ui-chat` | 配置 `performanceUsage: compact`：设置 → 通用设置 → 性能与用量初始为「简洁」，已完成的回答下不显示每轮 token 用量；用户自己的选择保存进 profile 补丁，并覆盖这个默认值。它的「繁忙时的压缩行为」行由 `server-sidebar` 隐去，`busyCompaction` 保持默认值 `turn-end` |
| `auto-compact` | 从 vendored 的 `vendor/haoran-dsh-auto-compact-0.5.1.tgz` 插入，带 `enabled: true` 与 `thresholdPercent: 60`：一轮里的每一次模型请求之前（包括第一次），只要这次请求会占用上下文窗口的 60% 以上，就先压缩对话。插件能找到 `console` 预设及其 `standard` 孪生预设里的压缩引擎。它在设置 → 通用设置里的行由 `server-sidebar` 隐去；压缩在对话里画出的行属于 `ui-chat`，列在「已知限制」里 |
| `preset-console` | 插入：`console` Agent 预设——persona、`tool-fs`、`skill-filesystem`、`tool-skill`、压缩组、`tool-ask-user` 与 `tool-todo`；没有 shell、搜索、后台任务、目标、计划、委派、web 与 `present` 行 |
| `preset-standard-as-console` | 插入：一个插件与 `console` 完全相同的 `standard` Agent 预设；会话按创建时记下的预设 id 恢复，控制台部署在 `console` 出现之前建的会话记的是 `standard` |
| `preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis` | 禁用：它们带着 shell 与其他开发者行，`cordis` 还挂载 `tool-cordis` 以及一份列出全部工作区包的技能，而 `session.create` 经 RPC 接受 `agentPreset`，只隐藏选择器不够；每个会话运行的都是 `console` 的插件，id 为 `console` 或 `standard` |

锁 overlay 重述三行。`permission` 行带三个面向客户名字的预设、`defaultPreset: workspace-write`，以及 `isolate: { commands: true }`——正是它让 `/permission` 保持未注册。`agent-preset-registry` 行带 `default: console`、不带 `selectedDefault`，所以每个新会话都跑 `console` 预设。`session-log-deepseek` 行带 `enabled: false`，所以没有会话会把 Session log 上传到官方模型 API。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

层的顺序决定每一行放进哪个文件。bundle 层组合在 profile 补丁之下，而 `dsh-config-editor` 只有在写入后的有效配置等于它写入的值时，才把一行的配置写进那份 profile 补丁。由 `--patch` overlay 或 home 补丁插入或配置的行会压过这次写入，编辑器因此拒绝它。侧栏的 `workflows`、`groups` 与 `workbenchSessionId` 是侧栏要保存的 volatile Config，所以这一行必须位于 bundle 层。`permission.defaultPreset`、`agent-preset-registry.selectedDefault` 与 `session-log-deepseek.enabled` 同样是 volatile Config，而 `remote.settings` 方法会回应部署放行的任何浏览器，所以这三行必须位于 profile 补丁之上。存下的 `selectedDefault` 若指向控制台没有声明的预设，每个新会话都会以 `agent-preset/not-found` 失败。

禁用行只按 id 指向出厂条目。bundle 的插件行通过 bundle 自己的 `dependencies` 解析，这一点由 `scripts/verify-cordis-config.ts` 强制；禁用行不加载任何东西。

vendored 的 tarball 把它用到的 harness 包声明为可选 peer。`@deepseek-ai/schemastery` 是插件运行时导入的包，所以放在 `dependencies`；只用于类型的 peer 放在 `devDependencies`。声明了它们，工作区安装就把每个 peer 链接到工作区里的那一份；不声明，pnpm 会从 registry 解析缺少的 peer，装进第二套 harness 包。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 层：外壳、侧栏、页面构建检查、MCP 能力、库技能、自动压缩、`console` Agent 预设，以及全部禁用行 |
| `vendor/haoran-dsh-auto-compact-0.5.1.tgz` | 仓外插件仓库的 `@haoran/dsh-auto-compact` 0.5.1，由其已推送的 `main` 构建后打包，声明为 `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"` |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | `permission`、`agent-preset-registry` 与 `session-log-deepseek` 三行，叠在 profile 补丁之上应用 |
| [`src/index.ts`](src/index.ts) | 空模块入口；两个补丁文件才是运行时内容 |
| — | 不发布运行时 invariant 伴生插件；本包不拥有任何可变关系。组合由 Loader 与 profile 的补丁文件拥有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [产品控制台侧栏](../server-sidebar/README.zh.md)——本 bundle 插入的侧栏、它的菜单字段与去术语化规则。
- [页面刷新](../page-refresh/README.zh.md)——本 bundle 插入的构建检查与连接横幅，以及为什么关掉插件热替换。
- [Profile bundle](../../bundle/README.zh.md)——`dsh --profile` 如何叠放可安装的层。
- [Config editor](../../boot/config-editor/README.zh.md)——一次设置写入落在哪一层，以及何时被拒绝。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由它组合的行。`console` Agent 预设决定会话自己的工具：`read`、`write`、`edit`、`read_image`、`skill`、`ask_user_question` 与 `todo_write`，另有 host 平面的内容栏工具，它的 persona 前缀是客户助手的指令：用户问到的数据通过组件展示，不描述工作目录、工具或内部实现，提到表、字段、图层、条目和分类时用它们的中文显示名称，而不是表名、条目 id、编码或枚举值；用户看得到的一切都用中文书写，开场第一句话与思考过程也不例外，因为对话的过程行会显示思考过程。`auto-compact` 行决定模型历史何时被压缩：从一次会占用上下文窗口 60% 以上的模型请求起（一轮的第一次请求也算），模型读到的是截成首尾两段的过长工具结果，不够时还有一段更早历史的摘要。`console-mcp` 行把每个已配置服务器的工具以 `mcp__<服务器 id>__<工具>` 提供出来，列表为空时什么都不提供。`library-skills` 行把随包出厂的技能加入技能目录，禁用四个出厂预设去掉了会话本可以运行其下的其他全部工具集，其余每个被组合的插件各自拥有自己对模型可见的内容。

#### KV Cache 影响

除被组合插件自身的影响外没有别的；只要出厂技能集合不变，技能目录的前缀就是稳定的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **锁是一个启动参数。** 启动 profile 时既没带 `--patch permission-lock.patch.yml`、也没有 home 补丁的部署，会得到出厂的预设名字、斜杠菜单里的 `/permission`，一个任何设置写入都能改的 `defaultPreset`，以及一次设置写入就能打开的 Session log 上传。它的默认 Agent 预设是 Web bundle 的 `standard`，而本 bundle 禁用了它，所以每个新会话都会以 `agent-preset/not-found` 失败。
- **MCP 服务器列表是部署 Config，不是设置。** `console-mcp.servers` 和侧栏菜单一样位于 bundle 层，但它不是 `.volatile()` 字段：设置服务不为它投影表单，写入时以 `Plugin entry "console-mcp" has no volatile fields` 拒绝，所以部署放行的任何浏览器都加不了服务器。部署在自己的层里给这一行打 `config` 补丁来点名服务器，改过的列表在这一行重新加载时生效。桥接进来的 MCP 工具不声明审批闸门，所以在每个访问预设下都会直接运行，用的是这一行 `auth` 点名的凭据。
- **压缩会显示 token 数和一段英文摘要。** 压缩进行时，对话里显示 `ui-chat` 的「正在压缩…」（Compacting context…）。压缩落定后，这一轮的过程行里出现标记「上下文已压缩 · 已压缩 N 条历史记录（约 N tokens）」，点开它会展开 `compaction-basic` 写下的摘要，而它的摘要提示词要求用英文写。一次失败的尝试会单独显示一行「上下文压缩失败」。控制台没有替换这些行中的任何一行，所以 persona 里只用中文的那句话管不到这段摘要，`performanceUsage: compact` 也去不掉标记里的 token 数。
- **隐去的压缩设置仍可写入。** `auto-compact.enabled`、`auto-compact.thresholdPercent` 与 `ui-chat.busyCompaction` 是 bundle 层里的 volatile Config，所以页面上没有控件，而 `remote.settings` 方法仍接受部署放行的任何浏览器的写入。
- **`console` 预设保留文件工具。** `tool-fs` 让 agent 能把它提炼的技能写进 `<workspace>/.dsh/skills`，也让它能写 `permission` 预设沙箱放行的任何其他文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`permission-lock.patch.yml` 通过 `scripts/check-workspace-constraints.ts` 里的 `packageFileExtras` 表发布。

要替换 vendored 的 `@haoran/dsh-auto-compact`，从插件仓库某个已推送提交的干净副本构建，而不是从 `lib/` 可能比源码旧的工作检出构建，运行 `pnpm pack`，把 tarball 放到 `vendor/` 下，更新 `file:` 说明符、`tests/profile.spec.ts` 与 `scripts/gen-third-party-notices.ts` 的 `OVERRIDES` 里的归档路径，再运行 `pnpm install`。e2e 脚手架把解包在 `node_modules/@haoran/dsh-auto-compact` 下的那一份链接进它的 profile（`apps/web/tests/server-sidebar.e2e.ts`）。

Web 快照 `console-auto-compact`（`snapshots/web/console-auto-compact`，由 `apps/web/tests/server-sidebar.e2e.ts` 驱动）经由本 bundle、作为 home 补丁的锁与一个部署层，在一条模型报告 200,000 token 窗口的回放路由上重放一段编写好的对话。它钉住这个组合的系统提示词与工具 schema、第二次回复报告占用窗口 62.5% 之后在第三轮第一次请求之前发生的那次压缩，以及压缩落定后的 Chat 栏；同一个 describe 里另有两次无 key 的运行，检查 57.5% 时什么都不压缩、`standard` 孪生预设在 62.5% 时同样压缩。改动 persona、技能目录或任何被组合的工具都会改变这个钉子：用 `DSH_SNAPSHOT=refresh` 重跑那个 describe，并审阅这些附属文件。

</details>
