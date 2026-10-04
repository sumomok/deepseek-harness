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

**锁钉住模型路由与默认模型。** `permission-lock.patch.yml` 加上带 `config: {}` 的 `llm-deepseek`，以及带 `provider: deepseek-official` 与 `model: deepseek-flash` 的 `agent-default-model`。组合后的配置与写入的值不同时，config-editor 拒绝这次设置写入，所以锁里的一行只有带着 `config` 键时才锁得住；`{}` 写明的正是 base bundle 的配置——base bundle 组合这一行时不带任何配置。锁组合进来后，`session.selectModel` 只切换那一个会话，并记一条默认值未保存的日志。在自己的层里配置了这两行之一的部署，要把那份配置移进锁里的这一行，因为它替换整份配置。

**`hmr` 保留。** 它没有 Remote 方法；磁盘上 profile 文件的改动由它在不重启的情况下生效。

## What stays reachable

下面这些 Remote 方法与路由仍回应每个被放行的访客，原因是某个控制台功能需要它们所在的行，或者只有改动上游拥有的包才能关掉它们：

- `/api/file` 提供 Host 文件系统 provider 能读的任何绝对路径，上限是 `attachments.imageLimits.maxImageBytes`；对话里的内联图片经它加载，挂载它的是 `session-controller`。
- `workspaceFiles.read`、`readBytes` 与 `stat` 读取工作区之外的路径。右侧栏的文档标签页经它们读取，文件链接、工具行里的路径或技能引用都会打开这个标签页。
- `credentials.set` 与 `credentials.unset` 写入受管凭据存储，不返回任何值。挂载它们的是 `settings-controller`，控制台显示的每个设置行都靠它；部署从进程环境提供的引用会以 `credential/rejected` 回应。
- `session.create` 接受任何绝对路径的 `cwd`，而 `fs-sandbox` 不限制读取，并把 `workspace-write` 的写入限制在那个目录与平台临时目录里。
- `session.*`、`workspace.*`、`job.*` 与 `subagents.*` 作用于每个会话；控制台是单租户的，所以每个访客都是同一个操作者。
- 挂着 `goal-round-driver` 时，`goals.*` 让会话以模型轮次继续进行，这会消耗模型 token，但够不着代码、凭据或文件。
- `fileReferences.list` 为输入框的 `@` 提及列出一个会话目录下的名字；`account.*` 让 Host 登录一个 DeepSeek 账号，`deepseek-account-platform` 只把该账号的 token 发往它的推理源。
- `agent-loop`、`subagent`、`subagent-model-selection-settings`、`llm-deepseek-account`、`auto-compact` 的 volatile 字段与 `ui-chat.busyCompaction` 接受设置写入；没有控制台预设会委派，也没有控制台预设跑账号路由。

## Testing

`packages/experimental/console-profile/tests/profile.spec.ts` 钉住每一组在控制台层里都是一条只有 id 的禁用行，而出厂 bundle 组合并启用它们；并对照 base bundle 的配置钉住锁里的两行。`apps/web/tests/server-sidebar.e2e.ts` 里的 server-sidebar 场景以锁作 home 补丁启动控制台，像页面自己的客户端那样带着登录 cookie 发送 `client-request` 信封。它要求 `pluginManager.listBundles`、`setBundleEnabled`、`installBundle`、`pluginInventory.list`、`pluginRegistryProbe.fastest`、`dynamicCordisRunner.runHostHalf`、`terminal.create` 与 `officeToPdf.render` 都回 404；`llm.discoverModels` 报告没有注册任何发现；对 `agent-default-model` 的一次 `settings.update` 被拒绝；每个被组合的 Loader 条目都处于激活状态；`session.list` 与 `settings.describe` 正常应答。去掉 `plugin-manager` 那一行后，这个用例在 `pluginManager.listBundles` 上失败。脚手架自己禁用 `directory-picker` 与 `open-in-app` 并插入 browse 选择器，所以这个场景覆盖不到这两行。

## Alternatives considered

**等待桌面线的扣下机制**，这是基座 Note 的选择。桌面 Host 服务的是本机的一个人；控制台 Host 把部署的每个访客都当作这个人来服务，所以那里的插件管理就是在装着部署凭据的容器里执行代码。没有控制台页面用到被禁用的服务，所以将来按调用方把关这些服务的机制，只需重新启用这些行就能采用，也不存在一个需要与它调和的控制台专属答案。

**在 connection 或 Gateway 里做按方法的允许名单。** 它能一次关掉控制台不调用的每个 Remote，包括上面列出的那些，但它要改 `dsh-client-connection` 与 `dsh-api-gateway` 这两个上游拥有的包，而这里禁用的每一行都不需要这种改动就能关掉。

**连 `workspace-files` 与文档标签页一起禁用。** `/api/file` 读的是同样的路径，默认上限 20 MiB，内联图片又离不开它，所以关掉 `workspaceFiles.read` 并不能去掉任何读取。`ui-sidebar-right` 的 `openResource` 遇到没有标签页类型认领的地址时会抛错，访客打开的每个文件链接、工具行路径与技能引用都会因此失败。

**只禁用页面。** 去掉 `ui-plugin-manager` 或右侧栏的终端标签页，去掉的是控制台里本来就够不着的控件，而 `pluginManager.*` 与 `terminal.*` 照样回应每个访客。

**让四个配置页保持组合。** 它们只往 `ui-plugin-manager` 的 `plugins.item` slot 里注册，而那一行被禁用后，没有任何东西声明这个 slot；「设置 → 插件」的清单行出于同样的理由被禁用。

## Consequences

被放行的访客都不能再安装或开关插件、运行动态 Cordis 包、打开终端、运行模型发现或添加 provider 路由、在会话工具之外浏览或创建目录、启动 Host 的应用、渲染 Office 文件，或改指模型路由与默认模型。控制台页面失去右侧栏的终端标签页与 Office 预览——文档标签页里会报错；`session.selectModel` 不把任何选择保存为默认值。想要回其中某个面的部署，要在自己的层里重新启用对应的行，并接受每个访客都够得着它；在自己的层里配置了 `llm-deepseek` 或 `agent-default-model` 的部署，要把那份配置移进锁里。上面的可达清单，就是 connection 里按调用方的把关或多租户控制台需要去关掉的东西。
