# content-console

[English](README.md) | 中文

控制台后端主干在 ACP 自动化传输下的组合：录制出来的会话记录能观察到的控制台行全在这里，只负责绘制浏览器界面的行一个都不在。

组合内容：DeepSeek 适配器、ACP 自动化应用、投影注册表、[`content-surface`](../../packages/experimental/content-surface/README.zh.md)（把内容列表达成每会话一条条目流，并贡献一段系统提示词）、监听系统分配端口的 [`host-webserver`](../../packages/host/webserver/README.zh.md)、`show_component` 描述里承诺按下会经其回来的命令注册表，以及会往这一列里摆条目的两把工具——[`show_chart`](../../packages/experimental/vue2-echarts-tool-poc/README.zh.md) 与 [`show_component`](../../packages/experimental/component-surface/README.zh.md)。

按设计缺席的是 `server-layout`、`content-column`、`server-sidebar`、Vue 图表行，以及把摆好的块画出来的组件行：它们不注册工具、不贡献提示词段落、不写会话事件，会话记录无法把它们和它们的缺席区分开；它们的证据在 [`apps/web/tests`](../../apps/web/tests) 的 Playwright 泳道。主干自带的技能、目标、后台作业工具出于相反的理由关掉——它们真实存在，但不属于控制台，留着只会让上游改动它们的描述时冲刷本例的表头基线。

ACP 进程里没有浏览器接入，两把工具也都不需要浏览器才能结算。`show_chart` 会等满渲染回执期限，最后以未经确认作答——这正是被测行为，因为该期限会逐字出现在模型可见的结果文本里，而本组合把它设为一秒，因为泳道每次调用都要真实等待这段时间。`show_component` 对着目录判定这次调用后立即作答；摆好的块长什么样是浏览器泳道的问题，模型被提供了什么、被告知了什么才是这条泳道的问题。

`show_component` 这一行还带了一条 `views` 条目——一块由本部署自己写下、而非模型摆上去的视图。它的任何部分都到不了会话记录：`show-content-view` 是命令，而这条传输没有调用命令的方法。它在这里是为了启动这件事。配置的视图在加载期由判定调用的同一道判定过关，所以一份由人写下、工具却会拒绝的 spec，会让整个组合根本起不来；下面每一个场景，都是这道检查已经通过的结果。

## 快照场景

[`tests/content-console.snapshot.ts`](tests/content-console.snapshot.ts) 是交给 [`dsh-session-snapshot`](../../packages/test-support/session-snapshot/README.zh.md) 套件工厂的场景表。`show-chart-turn` 请求画一张柱状图，`show-component-turn` 请求摆一条确认条；两者组合的是同一个文件，因此同属一个表头类，由前者替两者钉住：

| 基线文件 | 内容 |
|---|---|
| `tool-schemas.expected.json` | 两把工具的完整 schema——各自的工具描述、描述里引用的部署上限与组件目录、每个参数的描述。归 `show-chart-turn` 所有，两个场景共读 |
| `system-prompt.expected.md` | 装配后的系统提示词，含 `content-surface` 的「已展示内容」段落 |
| `stdout.expected.jsonl` | 客户端看到的 ACP JSON-RPC |
| `session.jsonl` | 每个场景各自的持久化日志，含本次调用记下的参数与模型读回的结果文本 |

两个场景都是手写（`authored`）而非录制（`recorded`）：没有浏览器能回应这套组合，真实 API 只会改变模型画哪张图、写哪句话，不会改变基线走到哪条代码路径。

**在当前基座上，这里没有任何东西会跑起来。** `examples/` 落在 `pnpm-workspace.yaml` 的所有 glob 之外，所以这个目录不是工作区成员，它 `package.json` 里那五个 `workspace:*` 依赖从来没被解析过。`vitest.snapshot.config.ts` 的 include 只有 `scripts/session-snapshot-corpus.corpus.ts` 与 `snapshots/**/*.snapshot.ts`，没有任何 `examples/` 下的路径，其余 vitest 配置也都没点名它；因此 `pnpm run test:snapshot` 不含本套件，而把 vitest 指向本目录会匹配到零个文件、什么都没跑就退出。这套组合本身也起不来：`cordis.yml` 点名的 `@deepseek-ai/dsh-acp-demo` 所在的 `packages/examples/` 在当前基座上已不存在。

这棵树是带着而不是跑着。它该住在哪里——挪到 `snapshots/` 下与其余套件为伍，还是哪儿都不去——是一个尚未拍板的决定，所以它还留在原地，而不是被删掉。

## 运行时环境

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 适配器的凭据；仅录制模式需要 |
| `DEEPSEEK_BASE_URL` | `dsh-llm-deepseek` 使用的服务端点 |
| `DSH_SNAPSHOT` | `replay`、`record` 或 `refresh`；同时决定持久化是否用原始 JSONL |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | 快照工具收割的会话目录 |
