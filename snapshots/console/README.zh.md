# console

[English](README.md) | 中文

控制台后端主干在 ACP 自动化传输下的组合：录制出来的会话记录能观察到的控制台行全在这里，只负责绘制浏览器界面的行一个都不在。

[`cordis.yml`](cordis.yml) 是打在发行 `acp` 剖面上的补丁。在这里写明的有：DeepSeek 适配器、原始 JSONL 持久化、控制台人设、[`content-surface`](../../packages/experimental/content-surface/README.zh.md)（把内容列表达成每会话一条条目流，并贡献一段系统提示词）、监听系统分配端口的 [`host-webserver`](../../packages/host/webserver/README.zh.md)、持有访客访问令牌并指明它能花在哪个后端上的 [`auth-gate`](../../packages/experimental/auth-gate/README.zh.md)，以及会往这一列里摆条目的两把工具——[`show_chart`](../../packages/experimental/vue2-echarts-tool-poc/README.zh.md) 与 [`show_component`](../../packages/experimental/component-surface/README.zh.md)。投影注册表，以及 `show_component` 描述里承诺按下会经其回来的命令注册表，base 捆绑包里已经有了。

按设计缺席的是 `server-layout`、`content-column`、`server-sidebar`、Vue 图表行，以及把摆好的块画出来的组件行：它们不注册工具、不贡献提示词段落、不写会话事件，会话记录无法把它们和它们的缺席区分开；它们的证据在 [`apps/web/tests`](../../apps/web/tests) 的 Playwright 泳道。base 捆绑包提供的其余每一族工具都逐行关掉，理由正好相反——bash、文件系统、技能、目标、后台作业、子智能体、工作流、待办、Web、计划都真实存在，但不属于控制台，留着只会让上游改动它们的描述时冲刷本泳道的表头基线。模型在这里被提供的，恰好就是 `show_chart` 与 `show_component`。

ACP 进程里没有浏览器接入，两把工具也都不需要浏览器才能结算。`show_chart` 会等满渲染回执期限，最后以未经确认作答——这正是被测行为，因为该期限会逐字出现在模型可见的结果文本里，而本组合把它设为一秒，因为泳道每次调用都要真实等待这段时间。`show_component` 对着目录判定这次调用后立即作答；摆好的块长什么样是浏览器泳道的问题，模型被提供了什么、被告知了什么才是这条泳道的问题。

`show_component` 这一行还带了一条 `views` 条目——一块由本部署自己写下、而非模型摆上去的视图。它的任何部分都到不了会话记录：`show-content-view` 是命令，而这条传输没有调用命令的方法。它在这里是为了启动这件事。配置的视图在加载期由判定调用的同一道判定过关，所以一份由人写下、工具却会拒绝的 spec，会让整个组合根本起不来；下面每一个场景，都是这道检查已经通过的结果。

## 快照场景

[`console.snapshot.ts`](console.snapshot.ts) 是交给 [`dsh-session-snapshot`](../../packages/test-support/session-snapshot/README.zh.md) 套件工厂的场景表，外加数据源场景要读的那个假后端。十一个场景组合的是同一个 `cordis.yml`，因此同属一个表头类，由 `show-chart-turn` 替全体钉住：

| 场景 | 它验的是什么 |
|---|---|
| `show-chart-turn` | 一张柱状图，以及替整个类钉住的表头 |
| `show-component-turn` | 会提问的那个组件 |
| `show-record-turn` | 只作展示的那个组件 |
| `show-table-turn` | 属性里把列表嵌在配置对象内部的那个组件 |
| `show-filter-turn` | 属性是一张属性表加一份收窄的匹配策略清单的那个组件 |
| `show-view-turn` | 由 `layout` 排布的两个块，后者用 `$from` 绑到前者 |
| `reject-view-turn` | 布局引用了本次调用没摆过的块，以及那句点明该改哪条路径的话 |
| `show-datasource-turn` | 读一次本部署自己的数据：问题、行，以及计数的结果行 |
| `refuse-datasource-turn` | 同一个问题答 `reject_once`：没有事件、没有条目、没有读 |
| `show-default-columns-turn` | 一次没点名任何列的调用，按本部署默认查询方案选出的列来画 |
| `empty-datasource-turn` | 一次什么都没匹配上的筛选读，结果是零行而不是联系不上的数据源 |

每个场景各自持有这些基线文件：

| 基线文件 | 内容 |
|---|---|
| `snapshot.yml` | 语料门禁要读的剖面、组合、表头类与录制策略 |
| `input.json` | ACP 协议脚本：initialize/newSession/prompt 各步，以及可能有的审批答复 |
| `session.jsonl` | 持久化日志——同时是回放输入与预期输出，含本次调用记下的参数与模型读回的结果文本 |
| `stdout.expected.jsonl` | 客户端看到的 ACP JSON-RPC |
| `tool-schemas.expected.json` | 两把工具的完整 schema——各自的工具描述、描述里引用的部署上限与组件目录、每个参数的描述。归 `show-chart-turn` 所有，供整个类读取 |
| `system-prompt.expected.md` | 装配后的系统提示词，含 `content-surface` 的「已展示内容」段落。归 `show-chart-turn` 所有 |

每个场景都是手写（`authored`）而非实录（`live`）：没有浏览器能回应这套组合，真实 API 只会改变模型画哪张图、写哪句话，不会改变基线走到哪条代码路径。

## 运行方式

| 命令 | 作用 |
|---|---|
| `pnpm run test:snapshot -t show-chart-turn` | 回放单个场景。不需要密钥 |
| `pnpm run test:snapshot snapshots/console` | 回放整条泳道及其基线守卫。不需要密钥 |
| `pnpm run test:snapshot:refresh snapshots/console` | 回放已提交的模型脚本，并重写 stdout、会话日志与两份自有边车。不需要密钥；每一处 diff 都要过目 |
| `pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts` | 覆盖各条泳道清单、归属关系与归一化不动点的语料门禁 |

这条泳道没有录制这一步，因为没有任何场景是 `live`。持有密钥的人若想要一份实录转录，把某个 `snapshot.yml` 改成 `recording: live` 再跑 `pnpm run test:snapshot:record -t <name>`；那是唯一会读 `DEEPSEEK_API_KEY` 的路径。

## 运行时环境

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 适配器的凭据；仅录制模式需要 |
| `DEEPSEEK_BASE_URL` | `dsh-llm-deepseek` 使用的服务端点 |
| `DSH_SNAPSHOT` | `replay`、`record` 或 `refresh`；同时决定持久化是否用原始 JSONL |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | 快照工具收割的会话目录 |
| `DSH_CONSOLE_BIZ_UPSTREAM` | 令牌可花在其上的数据后端基址；测试套件把它指向自己起的假后端 |
| `DSH_CONSOLE_HTTP_PORT` | 本组合 HTTP 宿主绑定的端口，供自行向网关投递令牌的那些场景使用 |
