# Agent Note: 控制台组合去掉 Host 管理面，因为每个被放行的访客都是操作者

Status: implemented

[English](2026-10-04-console-drops-host-administration-surfaces.md) | 中文

## Problem

客户控制台把每个通过部署登录、通过 Host 与 Origin 围栏的访客都当作 Host 唯一的操作者放行。`dsh-client-connection` 校验浏览器会话，但不按方法检查（`packages/client/connection/src/rpc-host.ts`）；API Gateway 认领根 realm 上注册的每个 Typert Remote 服务，并把它派发给这个 Peer（`packages/api/gateway/src/index.ts`）。所以，没有任何控制台页面调用的方法，仍是每个已登录访客都能调用的方法。被组合的 Web bundle 挂载着管理 Host 本身的 Host 服务。`pluginManager.installBundle` 用调用方选定的 spec 运行 `pnpm add`，`setBundleEnabled` 能开启 Inspector 组合包，而它的 CDP 目标在 Host 里执行代码。`dynamicCordisRunner.runHostHalf` 在 Host 进程里的 `node:vm` realm 中激活调用方提供的代码。`terminal.create` 启动一个不受 Agent 沙箱约束、也没有审批这一步的 shell。`llm.discoverModels` 去请求调用方给出的 URL，`llm-pi-ai` 的 volatile `providers` 字段添加一条自带端点与凭据引用的路由。`directoryPicker.list` 与 `createDirectory` 从文件系统根开始浏览并创建目录。`llm-deepseek` 的 volatile 字段（其中有 `baseURL` 与 `apiKeyEnv`）和 `agent-default-model` 的 volatile 字段，让一次设置写入就能改指每个会话的模型请求（连同某个引用点名的任意已存凭据），或改掉每个新会话的默认模型。装着这些服务的容器里，同时装着 DeepSeek key 与客户的 MCP 凭据。[0.2.1-alpha.1 基座 Note](2026-10-04-server-console-on-the-0-2-1-alpha-1-base.zh.md) 记录了经插件管理的这条路径，并把扣下它的事留给桌面线正在设计的机制。

## Decision

**控制台组合只保留控制台功能用到的 Host 服务。** 控制台的终端用户不管理插件、模型、凭据、预设或 Host；这些由部署在自己的层里定死。bundle 层 `packages/experimental/console-profile/cordis.patch.yml` 按 id 禁用下面这些行，每组都带一段注释，写明它向被放行的访客暴露了什么：

- 插件管理：`plugin-manager`、`plugin-inventory`、`ui-plugin-manager`，以及只往 `ui-plugin-manager` 的页面里注册的四个配置页 `ui-settings-shell`、`ui-settings-agent-loop`、`ui-settings-subagent` 与 `ui-settings-web-search`。
- 动态 Cordis 包：`cordis-host-runner`、往这个 runner 里注册的 `cordis-inspect-providers`，以及在每个页面上调用这个 runner 的 `cordis-client-runner`。
- 交互式终端：`terminal-controller` 与 `ui-sidebar-terminal`。
- provider 发现：`llm-pi-ai`，唯一的发现注册方，挂载时没有任何 provider。
- 网页搜索与抓取：`web`、`web-search-deepseek` 与 `web-fetch-http`，它们不为任何控制台预设的工具服务，却保有 volatile 的端点与凭据引用。
- 会话工具之外的 Host 路径：`directory-picker`、`open-in-app`、`ui-open-in-app` 与 `office-to-pdf`。
- 目标（goals），两半加上会话驱动：`goal`、`goal-round-driver` 与 `ui-goal`。`goals.create`、`edit`、`resume` 等都在根 realm 上应答，一旦目标被设上，`goal-round-driver` 就用 Host 的 key 持续跑模型轮次，直到目标的轮次上限。没有控制台预设挂载 `tool-goal`，Web bundle 禁用了 `command-goal` 与 `tool-goal`，所以没有任何被组合的行注入 `goals` 服务。

**锁钉住模型路由与默认模型。** `permission-lock.patch.yml` 加上带 `config: {}` 的 `llm-deepseek`、带 `config: {}` 的 `llm-deepseek-account`，以及带 `provider: deepseek-official` 与 `model: deepseek-flash` 的 `agent-default-model`。组合后的配置与写入的值不同时，config-editor 拒绝这次设置写入，所以锁里的一行只有带着 `config` 键时才锁得住；`{}` 写明的正是 base bundle 的配置——base bundle 组合每一行时都不带任何配置。锁组合进来后，`session.selectModel` 只切换那一个会话，并记一条默认值未保存的日志，账号路由的 `baseURL` 与模型目录也不再能被改指。在自己的层里配置了这几行之一的部署，要把那份配置移进锁里的这一行，因为它替换整份配置。

**锁钉住设置写入会替每位访客改掉的每一项偏好与可调参数。** `dsh-experimental-server-base` 的 `ownsHost` 让设置页持久化到 Host，所以在控制台上，浏览器侧的偏好和 Host 的可调参数一样，保存进所有访客共用的那一份 profile 补丁。因此 `permission-lock.patch.yml` 还重述 `bash-sandbox`、`agent-loop`、`subagent`、`subagent-model-selection-settings`、`auto-compact`、`locale`、`ui-theme`、`ui-chat`、`ui-conversation` 与 `ui-settings`，每一行都写成控制台原本就在用的值（先取下层的值，再取 schema 默认值），只有 `ui-settings.enabled` 被钉在关闭。`auto-compact` 的配置移出了 bundle 层，bundle 层现在插入这一行时不带配置。`locale` 是 `{}`，所以每个浏览器显示它自己的语言。这些命名空间画出的每一个 Settings → General 行都由 `server-sidebar` 隐去，只留每个浏览器各自保存的快捷键与当前版本：每次写入都会被锁拒绝的控件什么也改不了。

**`hmr` 被禁用。** 它没有 Remote 方法，但它在不重启的情况下让磁盘上的 profile 改动生效，于是把一次对 profile 补丁或 home 补丁的写入变成下一次 profile 重载就运行的实时代码。`tool-fs` 在 `workspace-write` 下，靠被放行的访客给出的那一次超出工作区的审批，就准许了这次写入。禁用这一行后，这类改动只在下次 Host 重启时才生效；没有 `hmr`，`config-editor` 仍自行保存并对账每次设置写入（`config-editor/src/index.ts` 在 `hmr` 缺席时直接运行它的写入）。这收窄了磁盘写入这条链，但收窄不了写入本身——只有在上游包里约束 `tool-fs` 或会话 `cwd` 才能关掉它。

## What stays reachable

下面这些 Remote 方法与路由仍回应每个被放行的访客，原因是某个控制台功能需要它们所在的行，或者只有改动上游拥有的包才能关掉它们：

- `/api/file` 提供 Host 文件系统 provider 能读的任何绝对路径，上限是 `attachments.imageLimits.maxImageBytes`；对话里的内联图片经它加载，挂载它的是 `session-controller`。
- `workspaceFiles.read`、`readBytes` 与 `stat` 读取工作区之外的路径。右侧栏的文档标签页经它们读取，文件链接、工具行里的路径或技能引用都会打开这个标签页。
- `credentials.set` 与 `credentials.unset` 写入受管凭据存储，不返回任何值。挂载它们的是 `settings-controller`，控制台显示的每个设置行都靠它；部署从进程环境提供的引用会以 `credential/rejected` 回应。
- `session.create` 接受任何绝对路径的 `cwd`，而 `fs-sandbox` 不限制读取，并把 `workspace-write` 的写入限制在那个目录与平台临时目录里。对 profile 补丁或 home 补丁的写入，需要被放行的访客给出那一次超出工作区的审批；`hmr` 被禁用后，它只在下次 Host 重启时才生效。
- `session.*`、`workspace.*`、`job.*` 与 `subagents.*` 作用于每个会话；控制台是单租户的，所以每个访客都是同一个操作者。
- `fileReferences.list` 为输入框的 `@` 提及列出一个会话目录下的名字；`account.*` 让 Host 登录一个 DeepSeek 账号，`deepseek-account-platform` 只把该账号的 token 发往它的推理源。
- 对任何 volatile 字段的设置写入都会被重新序列化进 profile 补丁并当场生效。新增或改动 `{ __jsExpr: … }` 节点的写入在校验之前就被拒绝：`config-editor` 的 `edit()` 抛出 `ConfigExpressionRejectedError`，设置 RPC 回应 `settings/rejected`，补丁文件不变（核心补丁 `settings-expression-write-guard`）。行里已有的表达式（例如锁层的 `!!js` 值）原样写回。锁关掉了 `llm-deepseek`、`llm-deepseek-account`、`agent-default-model`、`session-log-deepseek`、权限预设，以及上面那些偏好与可调参数的行；控制台保持可写的 volatile 字段（`server-sidebar` 的菜单、`ui-settings-general.welcomeNoticeVersion` 与 `ui-settings-account` 的引导字段）只接受普通值。

## Testing

`packages/experimental/console-profile/tests/profile.spec.ts` 钉住每一组在控制台层里都是一条只有 id 的禁用行，而出厂 bundle 组合并启用它们；并对照 base bundle 的配置钉住锁里的三行（`llm-deepseek`、`llm-deepseek-account`、`agent-default-model`）。它还把锁组合到控制台层之上并要求没有任何警告，于是锁里每一行的 `name` 都与它修补的那一行一致；并钉住每一个偏好与可调参数行的配置，要求它重述下层设置过的每个字段。同一个 e2e 场景要求对这十个命名空间的每一次设置写入都被拒绝，并要求打开的 Settings → General 页面不画出它们的任何一行。`apps/web/tests/server-sidebar.e2e.ts` 里的 server-sidebar 场景以锁作 home 补丁启动控制台，像页面自己的客户端那样带着登录 cookie 发送 `client-request` 信封。它要求 `pluginManager.listBundles`、`setBundleEnabled`、`installBundle`、`pluginInventory.list`、`pluginRegistryProbe.fastest`、`dynamicCordisRunner.runHostHalf`、`terminal.create`、`officeToPdf.render`、`goals.create` 与 `goals.resume` 都回 404；`llm.discoverModels` 报告没有注册任何发现；对 `agent-default-model` 的一次 `settings.update` 被拒绝；每个被组合的 Loader 条目都处于激活状态；`session.list` 与 `settings.describe` 正常应答。去掉 `plugin-manager` 那一行后，这个用例在 `pluginManager.listBundles` 上失败。脚手架自己禁用 `directory-picker` 与 `open-in-app` 并插入 browse 选择器，所以这个场景覆盖不到这两行。另有几行只由 `tests/profile.spec.ts` 钉住：`llm-deepseek` 锁行（replay 脚手架禁用了 `llm-deepseek`，所以没有 e2e 设置写入会到达它）、`ui-open-in-app`，以及只在客户端的禁用行 `ui-sidebar-terminal`、`cordis-client-runner`、`ui-settings-shell`、`ui-settings-agent-loop`、`ui-settings-subagent` 与 `ui-settings-web-search`——它们的 Host Loader 条目无论如何都会激活，所以激活检查看不到它们。

## Alternatives considered

**等待桌面线的扣下机制**，这是基座 Note 的选择。桌面 Host 服务的是本机的一个人；控制台 Host 把部署的每个访客都当作这个人来服务，所以那里的插件管理就是在装着部署凭据的容器里执行代码。没有控制台页面用到被禁用的服务，所以将来按调用方把关这些服务的机制，只需重新启用这些行就能采用，也不存在一个需要与它调和的控制台专属答案。

**在 connection 或 Gateway 里做按方法的允许名单。** 它能一次关掉控制台不调用的每个 Remote，包括上面列出的那些，但它要改 `dsh-client-connection` 与 `dsh-api-gateway` 这两个上游拥有的包，而这里禁用的每一行都不需要这种改动就能关掉。

**连 `workspace-files` 与文档标签页一起禁用。** `/api/file` 读的是同样的路径，默认上限 20 MiB，内联图片又离不开它，所以关掉 `workspaceFiles.read` 并不能去掉任何读取。`ui-sidebar-right` 的 `openResource` 遇到没有标签页类型认领的地址时会抛错，访客打开的每个文件链接、工具行路径与技能引用都会因此失败。

**只禁用页面。** 去掉 `ui-plugin-manager` 或右侧栏的终端标签页，去掉的是控制台里本来就够不着的控件，而 `pluginManager.*` 与 `terminal.*` 照样回应每个访客。

**只隐去偏好行而不锁，或只锁而不隐去这些行。** 不锁的话，`remote.settings` 仍替每位访客写下其中每一项，早先某位访客存进 profile 补丁的值也继续生效。不隐去的话，这些行留在页面上，而它们发出的每一次写入都被拒绝。

**让四个配置页保持组合。** 它们只往 `ui-plugin-manager` 的 `plugins.item` slot 里注册，而那一行被禁用后，没有任何东西声明这个 slot；「设置 → 插件」的清单行出于同样的理由被禁用。

## Consequences

被放行的访客都不能再安装或开关插件、运行动态 Cordis 包、打开终端、运行模型发现或添加 provider 路由、在会话工具之外浏览或创建目录、启动 Host 的应用、渲染 Office 文件、设上一个用 Host 的 key 跑模型轮次的目标，或改指模型路由、账号路由与默认模型；磁盘上的 profile 改动不再不重启就生效。控制台页面失去右侧栏的终端标签页与 Office 预览——文档标签页里会报错；`session.selectModel` 不把任何选择保存为默认值。想要回其中某个面的部署，要在自己的层里重新启用对应的行，并接受每个访客都够得着它；在自己的层里配置了 `llm-deepseek`、`llm-deepseek-account` 或 `agent-default-model` 的部署，要把那份配置移进锁里。上面的可达清单，就是 connection 里按调用方的把关或多租户控制台需要去关掉的东西。
