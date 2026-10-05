---
description: "把客户控制台作为一个 bundle 层组合到 Web profile 上，并附带一份由部署叠在 profile 补丁之上的权限锁。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-console-profile` 把一个 `web` profile 变成客户控制台。它的 bundle 层换上服务外壳与产品侧栏，禁用那些带有内部术语、开发者工具或 Host 管理内容的出厂界面与提示词段落，挂载库技能，在上下文窗口用到 60% 时压缩对话，声明 `console` Agent 预设，并禁用全部出厂 Agent 预设。它的第二个文件 `permission-lock.patch.yml` 在 profile 补丁之上的层里钉住访问预设、模型、默认 Agent 预设 `console`，以及所有访客共用的每一项偏好。拆成两份依据一条规则：侧栏菜单必须能由 settings 服务保存，而钉住的行不能被保存。

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
| `web-runtime` | 配置 `surfaceContext: false`，其余四个字段照抄 Web bundle 的值：模型请求里不再有 `harness:source` 段落（DeepSeek Harness 检出目录的路径）和 `app:web-surface` 段落（页面的本地 URL 与 `pnpm run dev:web`），shell 命令也拿不到 `DSH_WEB_URL`——只有 `bash` 与 `pwsh` 工具读它，而两个控制台预设都不提供这两个工具 |
| `ui-deliverables` | 禁用：它的提示词段落告诉模型何时调用 `present`，而两个控制台预设都不提供这个工具；这一段从此不进入任何模型请求，一起去掉的还有改动文件卡片（只在开启代码工作工具时绘制）、交付卡片、收尾回答里可点击的文件路径，以及它们打开的审阅标签页 |
| `system-prompt` | 配置 `includeHarnessIdentity: false`，`personaPrefix` 与 `personaSuffix` 照抄 Web bundle 的值：模型请求不再以 `You are an AI agent powered by DeepSeek Harness.` 开头；有这句话时，客户问助手由什么驱动，助手会照着说出 DeepSeek Harness |
| `ui-layout`、`ui-sidebar` | 禁用：它们的单一槽位由外壳与侧栏占用 |
| `ui-agent-preset`、`ui-brand-official`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`、`ui-settings-models`、`ui-permission`、`ui-settings-session-log` | 禁用：内部术语、官方品牌与开发者界面 |
| `ui-settings-plugins`、`ui-settings-plugin-inventory` | 禁用：「设置 → 插件」分区及其唯一的标签页（Loader 清单）。设置外壳 `ui-settings-general` 保留 |
| `plugin-manager`、`plugin-inventory`、`ui-plugin-manager`、`ui-settings-shell`、`ui-settings-agent-loop`、`ui-settings-subagent`、`ui-settings-web-search` | 禁用：插件管理。登录放行的每个访客都是 Host 的操作者，而 `pluginManager.installBundle`、`setBundleEnabled` 与 `setPluginEnabled` 会安装一个包，或开启一个 bundle，例如 Inspector——它的 CDP 目标在 Host 里执行代码。`plugin-inventory` 为两个插件页列出 Loader 的各行；`ui-plugin-manager` 是侧栏的插件页，控制台里没有任何东西打开它，它的 Host 一半会探测两个公共 npm 源；四个配置页只往这个页面里注册。会让这类改动实时生效的 `hmr` 行在下面被禁用 |
| `hmr` | 禁用：`hmr` 没有 Remote 方法，但它在不重启的情况下让磁盘上的 profile 改动生效。`tool-fs` 在 `workspace-write` 下，靠被放行的访客给出的那一次审批，就准许了对工作区之外的写入，于是一次对 profile 补丁或 home 补丁的写入会变成下一次 profile 重载就运行的实时代码。禁用这一行后，这类改动只在下次 Host 重启时才生效；没有它，`config-editor` 仍自行保存并对账每次设置写入。这收窄了磁盘写入这条链，而不是写入本身 |
| `goal`、`goal-round-driver`、`ui-goal` | 禁用：目标，两半加上会话驱动。`goals.create`、`edit`、`resume` 等都在根 realm 上回应每个被放行的访客，一旦目标被设上，`goal-round-driver` 就用 Host 的 key 跑模型轮次，直到目标的轮次上限。没有控制台预设挂载 `tool-goal`，Web bundle 禁用了 `command-goal` 与 `tool-goal`，`ui-goal` 又是没有任何东西导航到的浏览器一半，所以没有控制台功能设得上目标，也没有被组合的行等待 `goals` 服务 |
| `cordis-host-runner`、`cordis-inspect-providers`、`cordis-client-runner` | 禁用：动态 Cordis 包，两半都禁用。`dynamicCordisRunner.runHostHalf` 激活一个由调用方提供的包，它的 Host 一半在 Host 进程里的 `node:vm` realm 中运行；没有控制台预设挂载 `tool-cordis`，检查 provider 也只往这个 runner 里注册 |
| `terminal-controller`、`ui-sidebar-terminal` | 禁用：`terminal.create` 以 Host 用户的权限启动一个 shell，不受 Agent 沙箱约束，也没有审批这一步；右侧栏的终端标签页画出它 |
| `ui-sidebar-files` | 禁用：右侧栏的文件标签页（一棵以工作目录在 Host 上的绝对路径为标题的文件树）及其「工作区文件」快捷键。组合进来时，它是引导页唯一提供的标签页类型，右栏空着打开时会显示它；禁用后引导页没有可打开的内容，`server-sidebar` 又隐去了右栏的切换快捷键和对话页眉的展开按钮，所以右栏只在访客点开一个文件时打开，显示该文件的文档标签页。右栏本身与文档标签页照常组合。文档标签页经由 `workspace-files` Remote 读取文件，这个 Remote 的目录列表和变更观察（change observations）限定在工作目录之内，读文件则按组合的文件系统读权限进行，包括工作目录之外的路径 |
| `llm-pi-ai` | 禁用：唯一的模型发现——`llm.discoverModels` 让 Host 去请求调用方给出的 URL——以及一个 volatile 的 `providers` 字段，其中的路由各自带着自己的端点与凭据引用。控制台里这一行没有任何 provider，控制台的模型跑在 `llm-deepseek` 上 |
| `web`、`web-search-deepseek`、`web-fetch-http` | 禁用：没有控制台预设提供 `web_search` 或 `web_fetch`，而搜索行的 `apiKey`、`apiKeyEnv` 与 `baseURL` 是设置写入够得着的 volatile Config |
| `directory-picker`、`open-in-app`、`ui-open-in-app`、`office-to-pdf` | 禁用：`directoryPicker.list` 与 `directoryPicker.createDirectory` 在 Host 文件系统的任何位置列出并创建目录，「打开方式」在一个路径上启动 Host 的应用，`officeToPdf.render` 在 Host 里用 LibreOffice 转换调用方点名的 Office 文件。控制台侧栏不提供添加工作区的流程、「打开方式」按钮或 Office 预览 |
| `schedule`、`ui-schedule` | 禁用：定时的两半——带 `schedule.*` Remote 方法的 Host 任务存储，以及「自动化任务」页面与创建提醒后画出的卡片。所有已登录的访客共用控制台的同一个 Host：`schedule.catalog` 返回每个会话的任务，四个 `schedule_*` 工具改动任务时没有审批这一步。这些工具与 `time-context` 时钟行属于出厂的 `standard`、`ptc`、`cordis` 预设，它们都已禁用；两个控制台预设都不声明它们，所以不会有预设带着一个停在等待那个缺失服务上的 `tool-schedule` |
| `auto-compact` | 从 vendored 的 `vendor/haoran-dsh-auto-compact-0.5.1.tgz` 插入，不带配置；锁把它钉在 `enabled: true` 与 `thresholdPercent: 60`：一轮里的每一次模型请求之前（包括第一次），只要已记录的历史占用上下文窗口的 60% 以上，就先压缩对话；一轮的第一次请求之前，这段历史止于刚发出的那条消息之前，那条消息不计入。插件能找到 `console` 预设及其 `standard` 孪生预设里的压缩引擎。它在设置 → 通用设置里的行由 `server-sidebar` 隐去；压缩在对话里画出什么，列在「已知限制」里 |
| `preset-console` | 插入：`console` Agent 预设——persona、`tool-fs`、`skill-filesystem`、`tool-skill`、不含 `command-compact` 的压缩组、`tool-ask-user` 与 `tool-todo`；没有 shell、搜索、后台任务、目标、计划、委派、web 与 `present` 行 |
| `preset-standard-as-console` | 插入：一个插件与 `console` 完全相同的 `standard` Agent 预设；会话按创建时记下的预设 id 恢复，控制台部署在 `console` 出现之前建的会话记的是 `standard` |
| `preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis` | 禁用：它们带着 shell 与其他开发者行，`cordis` 还挂载 `tool-cordis` 以及一份列出全部工作区包的技能，而 `session.create` 经 RPC 接受 `agentPreset`，只隐藏选择器不够；每个会话运行的都是 `console` 的插件，id 为 `console` 或 `standard` |

锁 overlay 重述十六行。其中六行钉住访问预设、Agent 预设、Session log 上传与模型。`permission` 行带三个面向客户名字的预设、`defaultPreset: workspace-write`，以及 `isolate: { commands: true }`——正是它让 `/permission` 保持未注册。`agent-preset-registry` 行带 `default: console`、不带 `selectedDefault`，所以每个新会话都跑 `console` 预设。`session-log-deepseek` 行带 `enabled: false`，所以没有会话会把 Session log 上传到官方模型 API。`llm-deepseek` 行带一份空配置，也就是 base bundle 的配置，所以任何设置写入都不能把模型路由指向别的端点或凭据引用。`llm-deepseek-account` 行带同样的空配置，所以设置写入也不能改指账号路由的 `baseURL` 或模型目录。`agent-default-model` 行带 base bundle 的 `deepseek-official` 与 `deepseek-flash`，所以 `session.selectModel` 只切换那一个会话，并记一条默认值未保存的日志。在自己的层里配置了后三行之一的部署，要把那份配置移进锁里的这一行，因为它替换整份配置。

锁的另外十行钉住的，是设置写入原本会替每位访客改掉的东西：在控制台上，设置页持久化到 Host（`dsh-experimental-server-base` 的 `ownsHost`），所以连浏览器侧的偏好也保存进所有访客共用的那一份 profile 补丁。每一行都重述下层组合出的配置，并把其余 volatile 字段写成控制台原本就在用的值；每个值的出处写在文件里：

| 行 | 钉住的值 |
|---|---|
| `bash-sandbox` | `timeoutMs: 60000`，base bundle 的值；其余限额保持默认。两个控制台预设都不提供 shell 工具 |
| `agent-loop` | `agents: []`，base bundle 的值，以及 `maxParallelToolCalls: 10` |
| `subagent` | `maxDepth: 1`、`maxActiveSubagents: 8`。两个控制台预设都不委派 |
| `subagent-model-selection-settings` | `enabled: false`、`allowedModels: []` |
| `auto-compact` | `enabled: true`、`thresholdPercent: 60` |
| `locale` | `{}`：每个浏览器显示它自己的语言 |
| `ui-theme` | `preference: system`、`fontSize: 14`：每个浏览器跟随它自己系统的浅色或深色模式 |
| `ui-chat` | `performanceUsage: compact`（已完成的回答下不显示每轮 token 用量）、`linkOpening: sidebar`、`busyCompaction: turn-end`；不设 `transcriptView`，于是用浏览器的默认值 `detailed` |
| `ui-conversation` | `busyEnter: queue` |
| `ui-settings` | `enabled: false`：开发者工具偏好关闭，右侧栏的 HTML 预览画出经过净化的静态页面副本，不运行脚本，也不读取相关文件。它的默认值是开，所以只有这一行的值改变了控制台页面原先的行为 |

这些命名空间画出的每一个 Settings → General 行都由 `server-sidebar` 隐去，所以 Settings → General 只显示每个浏览器各自保存的快捷键，以及当前版本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

层的顺序决定每一行放进哪个文件。bundle 层组合在 profile 补丁之下，而 `dsh-config-editor` 只有在写入后的有效配置等于它写入的值时，才把一行的配置写进那份 profile 补丁。由 `--patch` overlay 或 home 补丁插入或配置的行会压过这次写入，编辑器因此拒绝它。侧栏的 `workflows`、`groups` 与 `workbenchSessionId` 是侧栏要保存的 volatile Config，所以这一行必须位于 bundle 层。`permission.defaultPreset`、`agent-preset-registry.selectedDefault`、`session-log-deepseek.enabled`，`llm-deepseek`、`llm-deepseek-account` 与 `agent-default-model` 的各字段，以及锁的另外十行里的偏好与可调参数，同样是 volatile Config，而 `remote.settings` 方法会回应部署放行的任何浏览器，所以这十六行必须位于 profile 补丁之上。锁里的一行会替换这一行的整份配置，所以它要重述下层设置过的每个字段；锁配置的行在 bundle 层里只能以不带配置的插入出现，`tests/profile.spec.ts` 检查这一点，并检查组合进锁之后没有任何警告。这份测试还用各插件自己的 Config schema 读这十行，并和同一 schema 对下层组合的读取结果比对；比对前，先在下层组合上叠加锁从 bundle 层拿走的两份配置（`auto-compact` 的配置，以及 `ui-chat` 的 `performanceUsage`）。唯一不同的值是被关掉的 `ui-settings.enabled`。存下的 `selectedDefault` 若指向控制台没有声明的预设，每个新会话都会以 `agent-preset/not-found` 失败。

禁用行只按 id 指向出厂条目。bundle 的插件行通过 bundle 自己的 `dependencies` 解析，这一点由 `scripts/verify-cordis-config.ts` 强制；禁用行不加载任何东西。

vendored 的 tarball 把它用到的 harness 包声明为可选 peer，而 pnpm 11.7.0 不会自己去取可选 peer：只有本 manifest 声明了的 peer 才会被链接到插件旁边，指向工作区里的那一份。`@deepseek-ai/schemastery` 是插件运行时导入的包，所以放在 `dependencies`；只用于类型的 peer 放在 `devDependencies`。不声明的话，插件运行时导入的 `@deepseek-ai/schemastery` 就没有链接到任何工作区副本。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 层：外壳、侧栏、页面构建检查、MCP 能力、库技能、自动压缩、`console` Agent 预设，以及全部禁用行 |
| `vendor/haoran-dsh-auto-compact-0.5.1.tgz` | 仓外插件仓库的 `@haoran/dsh-auto-compact` 0.5.1，由其已推送的 `main` 构建后打包，声明为 `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"` |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | `permission`、`agent-preset-registry`、`session-log-deepseek`、`llm-deepseek`、`llm-deepseek-account` 与 `agent-default-model` 六行，以及页面偏好与 Host 可调参数的十行，叠在 profile 补丁之上应用 |
| [`src/index.ts`](src/index.ts) | 空模块入口；两个补丁文件才是运行时内容 |

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

间接地，经由它组合的行。`console` Agent 预设决定会话自己的工具：`read`、`write`、`edit`、`read_image`、`skill`、`ask_user_question` 与 `todo_write`，另有 host 平面的内容栏工具，它的 persona 前缀是客户助手的指令：用户问到的数据通过组件展示，不描述工作目录、工具或内部实现，提到表、字段、图层、条目和分类时用它们的中文显示名称，而不是表名、条目 id、编码或枚举值；用户看得到的一切都用中文书写，开场第一句话与思考过程也不例外，因为对话的过程行会显示思考过程。`auto-compact` 行决定模型历史何时被压缩：从第一次在请求之前已记录的历史就占用上下文窗口 60% 以上的模型请求起（一轮的第一次请求也算，它的检查不计入刚发出的消息），模型读到的是截成首尾两段的过长工具结果，不够时还有一段更早历史的摘要。`web-runtime` 行的 `surfaceContext: false` 与被禁用的 `ui-deliverables` 行让三段 Web bundle 内容不进入提示词：DeepSeek Harness 检出目录的路径、Web GUI 的本地 URL 及其重新构建说明，以及如何展示结果、何时调用 `present` 的指引；`system-prompt` 行的 `includeHarnessIdentity: false` 去掉点名 DeepSeek Harness 的固定句子，提示词由 persona 前缀开头。`console-mcp` 行把每个已配置服务器的工具以 `mcp__<服务器 id>__<工具>` 提供出来，列表为空时什么都不提供。`library-skills` 行把随包出厂的技能加入技能目录，禁用四个出厂预设去掉了会话本可以运行其下的其他全部工具集，其余每个被组合的插件各自拥有自己对模型可见的内容。

#### KV Cache 影响

除被组合插件自身的影响外没有别的；只要出厂技能集合不变，技能目录的前缀就是稳定的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **锁是一个启动参数。** 启动 profile 时既没带 `--patch permission-lock.patch.yml`、也没有 home 补丁的部署，会得到出厂的预设名字、斜杠菜单里的 `/permission`，一个任何设置写入都能改的 `defaultPreset`，一次设置写入就能打开的 Session log 上传，任何设置写入都能改指的模型路由与默认模型，以及一位访客的一次设置写入就会替每位访客改掉的页面偏好与 Host 可调参数；`auto-compact` 这时按插件自己的默认值运行，也是 60%；`ui-chat` 的「性能与用量」回到 schema 默认值 `detailed`，每个完成的回答下面显示每回合的 token 用量。它的默认 Agent 预设是 Web bundle 的 `standard`，而本 bundle 禁用了它，所以每个新会话都会以 `agent-preset/not-found` 失败。
- **MCP 服务器列表是部署 Config，不是设置。** `console-mcp.servers` 和侧栏菜单一样位于 bundle 层，但它不是 `.volatile()` 字段：设置服务不为它投影表单，写入时以 `Plugin entry "console-mcp" has no volatile fields` 拒绝，所以部署放行的任何浏览器都加不了服务器。部署在自己的层里给这一行打 `config` 补丁来点名服务器，改过的列表在这一行重新加载时生效。桥接进来的 MCP 工具不声明审批闸门，所以在每个访问预设下都会直接运行，用的是这一行 `auth` 点名的凭据。
- **客户看不到压缩摘要。** 压缩进行时，对话里显示 `ui-chat` 的「正在压缩…」（Compacting context…）。压缩落定后，这一轮的过程行里出现 `server-sidebar` 的「已压缩较早的对话」（Earlier conversation compacted），一次失败的尝试会单独显示一行「较早的对话压缩失败」（Couldn’t compact the earlier conversation）；两行都不显示计数或 token 数。一轮第一次请求之前的压缩，进行中与失败的行出现在客户刚发出的那条消息上方，因为那条消息要等压缩结束后才进入对话。没有哪一行能打开 `compaction-basic` 写下的摘要（它的摘要提示词要求用英文写），所以客户读不到模型用来代替较早对话的那段内容。两个预设都不组合 `command-compact`，所以斜杠菜单里没有 `/compact`；它的卡片会显示条数和 token 数，并能打开那段摘要。
- **一轮开头的压缩进行时按停止，会丢掉刚发出的消息。** 一轮第一次请求之前的压缩，运行在 harness 把开启这一轮的那条消息从队列里取出之后、把它加进对话之前。压缩进行时按停止会取消摘要并结束这一轮，那条消息就此丢掉：它不会进入对话，也不会得到回答。这是 harness 自己的行为；在 60% 处压缩比后端自己的触发点更常碰到它。
- **访客选不了语言、主题或任何其他偏好。** 锁把 Settings → General 原先提供的每一项偏好钉成整个部署一个值，页面只显示快捷键与当前版本。访客看到的是自己浏览器的语言与系统外观，访客选的任何东西都不会替别人保存。部署在自己的层里组合的、带 volatile 字段的行，在部署把它重述进锁之前，每位访客都能写。
- **每个被放行的访客都是 Host 的操作者。** 连接层把每个带着登录 cookie 的 `/api` 请求都当作 Host 唯一的操作者放行，不按方法区分，所以组合提供的每个 Remote 方法都回应每个已登录访客。本 bundle 禁用了上表列出的 Host 管理行，所以插件管理、动态 Cordis 包、终端、provider 发现、目录浏览、「打开方式」、Office 渲染与目标都不回应任何访客，`hmr` 行也不再让磁盘上的 profile 改动实时生效；这一决定记录在 [Host 管理 Note](../../../.agents/notes/implemented/architecture/2026-10-04-console-drops-host-administration-surfaces.zh.md)。下面这些仍然够得着：
  - `/api/file` 提供 Host 文件系统 provider 能读的任何绝对路径，上限是 `attachments.imageLimits.maxImageBytes`（默认 20 MiB）；对话里的内联图片经它加载。
  - `workspaceFiles.read`、`readBytes` 与 `stat` 读取工作区之外的路径；右侧栏的文档标签页经它们读取，文件链接、工具行里的路径或技能引用都会打开这个标签页。
  - `credentials.set` 与 `credentials.unset` 写入受管凭据存储，不返回任何值；部署从进程环境提供的引用会以 `credential/rejected` 回应。
  - `session.create` 接受任何绝对路径的 `cwd`，而 `workspace-write` 把这个会话的文件写入限制在那个目录与平台临时目录里；对 profile 补丁或 home 补丁的写入，需要被放行的访客给出那一次超出工作区的审批，而 `hmr` 被禁用后，它只在下次 Host 重启时才生效。
  - `session.*`、`workspace.*`、`job.*` 与 `subagents.*` 作用于 Host 服务的每个会话。
  - `fileReferences.list` 列出一个会话目录下的名字；`account.*` 让 Host 登录一个 DeepSeek 账号，其 token 只发往该账号的推理源。
  - 对锁没有钉住的 volatile 字段的设置写入，会被重新序列化进 profile 补丁并当场生效；新增或改动 `{ __jsExpr: … }` 节点的写入会被拒绝（核心补丁 `settings-expression-write-guard`）。仍可写的字段是侧栏保存的菜单、没有任何已组合的行会写的 `ui-settings-general.welcomeNoticeVersion`，以及 Web 上没有页面读取的 `ui-settings-account` 引导字段。
- **`console` 预设保留文件工具。** `tool-fs` 让 agent 能把它提炼的技能写进 `<workspace>/.dsh/skills`，也让它能写 `permission` 预设沙箱放行的任何其他文件。
- **远程面的 e2e 只探测 loopback 上的 HTTP 路径。** `server-sidebar.e2e.ts` 的 `remoteCall` 带登录 cookie 向 loopback 上的 `/api/<ns>/<method>` 发 POST，走过连接放行与 Gateway，但不经过 auth-gate 的 ownsHost 传输，也不打开 WebSocket 流路径；`workspaceFiles.changes` 与终端流这类流方法没有被探测，`directory-picker`、`open-in-app` 与 `llm-deepseek` 锁行只由 `tests/profile.spec.ts` 证明。Gateway 派发只取决于服务是否存在，所以被禁用的行在每条路径上都是关闭的；缺的是证明，不是关闭。
- **锁的预设表保留 `danger-full-access`。** 它重述这个预设，带 `approval: never`。控制台里没有任何被组合的东西调用 `PermissionPresetService.set`——`/permission` 在 `permission` 行上被隔离，唯二的其他调用方（auto-review、webhook）都没被组合——所以今天没有会话够得着它。保留而不删除，是因为在它之下创建的某个已存会话，面对一张不再带它的表会解析失败，而是否存在这样的会话无法从本包核实；将来某个被组合的、调用 `set()` 的行可能把会话切到它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`permission-lock.patch.yml` 通过 `scripts/check-workspace-constraints.ts` 里的 `packageFileExtras` 表发布。

要替换 vendored 的 `@haoran/dsh-auto-compact`，从插件仓库某个已推送提交的干净副本构建，而不是从 `lib/` 可能比源码旧的工作检出构建，运行 `pnpm pack`，把 tarball 放到 `vendor/` 下，更新 `file:` 说明符、`tests/profile.spec.ts`、`scripts/gen-third-party-notices.ts` 的 `OVERRIDES` 里的归档路径，以及 `.claude/core-patches.md` 里点名这条路径的台账记录 `console-vendored-plugin-notice`，再运行 `pnpm install`。e2e 脚手架把解包在 `node_modules/@haoran/dsh-auto-compact` 下的那一份链接进它的 profile（`apps/web/tests/console-launch.ts` 的 `CONSOLE_ROWS`）。

Web 快照 `console-auto-compact`（`snapshots/web/console-auto-compact`，由 `apps/web/tests/server-sidebar.e2e.ts` 驱动）经由本 bundle、作为 home 补丁的锁与一个部署层，在一条模型报告 200,000 token 窗口的回放路由上重放一段编写好的对话。它钉住这个组合的系统提示词与工具 schema、第二次回复报告占用窗口 62.5% 之后在第三轮第一次请求之前发生的那次压缩，以及压缩落定后的 Chat 栏；同一个 describe 里另有两次无 key 的运行，检查 57.5% 时什么都不压缩、`standard` 孪生预设在 62.5% 时同样压缩。改动 persona、技能目录、任何被组合的工具或任何添加提示词段落的行都会改变这个钉子：用 `DSH_SNAPSHOT=refresh` 重跑那个 describe，并审阅这些附属文件。

</details>
