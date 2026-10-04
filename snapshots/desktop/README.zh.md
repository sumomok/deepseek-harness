# desktop

[English](README.md) | 中文

桌面应用组合层在 ACP 自动化传输下的样子。[`apps/desktop-app/cordis.patch.yml`](../../apps/desktop-app/cordis.patch.yml) 给组合加上的行里，本泳道钉住的是 `tool-session-query` 行：它的五个 `session_*` 工具 schema 和先前历史提示词段按模型请求实际携带的样子被钉住，一次 `session_event_read` 调用及其结果按会话日志记录的样子被钉住。补丁的其他行没有被钉住。没有哪个场景调用 `session_search`，所以 `session-query-sqlite` 行的搜索索引从未被用到，改动那一行不会改变回放结果。

桌面自己的 profile `desktop-shell` 由 Electron 外壳现种进用户的 harness 主目录，组合的是 web 捆绑包加若干 vendored 第三方插件，没有哪个发行 profile 能复现它。所以 [`desktop.snapshot.ts`](desktop.snapshot.ts) 启动发行的 `acp` profile，把桌面应用的补丁文件原样作为基础补丁，再在其后叠本泳道的 [`cordis.yml`](cordis.yml)。桌面在那个文件里新增或改动的行，不用抄到这里就会作用于本泳道。补丁里指向 `acp` profile 没有组合的 id 的行，例如 `vision-switch`、`llm-permission-gateway` 和两个产品分析行，会被 loader 跳过。

[`cordis.yml`](cordis.yml) 只写明一份无 key、可复现的会话记录在基础补丁之上还需要的东西：

| 行 | 本泳道设的是什么 |
|---|---|
| `llm-deepseek` | 重述桌面的 `retryPolicy`，并给出列有 `deepseek-v4-flash` 的目录，那是发行 `acp` 行选用的模型 |
| `session-persistence-jsonl` | harness 的会话根目录，以及 `DSH_SNAPSHOT` 下的原始 JSONL，供采集读取 |
| `system-prompt` | 固定的人设 |
| base 捆绑包的每一族工具，以及 `agent-instructions` | 停用，于是模型被提供的恰好是五个 `session_*` 工具，上游改动别的工具描述也不会改变本泳道的基线 |
| `desktop-brand` | 停用：它的提示词行引用 harness 主目录，每次运行都是新的临时目录；它的模块是源码树里没有安装的构建产物 |
| `desktop-server-log` | 停用，免得开发者环境里的 `DSH_DESKTOP_SERVER_LOG` 把它挂载起来 |

回放时 launcher 应用的是基础补丁和 [`cordis.snapshot.yml`](cordis.snapshot.yml)，不应用 `cordis.yml`，所以 `cordis.snapshot.yml` 按同样的顺序重述 `cordis.yml` 的每一行，停用 DeepSeek 适配器，并插入 `llm-replay`，由它在没有 key、不走网络的情况下供给提交在库的模型脚本。

## 快照场景

[`desktop.snapshot.ts`](desktop.snapshot.ts) 是交给 [`dsh-session-snapshot`](../../packages/test-support/session-snapshot/README.zh.md) 套件工厂的场景表。每个场景组合的都是同样两层补丁，因此同属一个表头类 `desktop`。

| 场景 | 它验的是什么 |
|---|---|
| `session-query-turn` | 对本会话自己的 `permission/preset` 事件调用一次 `session_event_read`，然后回 `DONE`；同时替整个类钉住表头 |

每个场景拥有这些固定文件：

| 固定文件 | 里面是什么 |
|---|---|
| `snapshot.yml` | corpus 闸门读取的 profile、组合、表头类与录制策略 |
| `input.json` | ACP 协议脚本：initialize、newSession、prompt 三步 |
| `replay.override.json` | 手写的模型脚本，替换从会话日志推导出的脚本 |
| `session.vN.jsonl` | 持久化日志，既是回放输入也是期望输出，含 `tool/call` 以及模型读回的 `tool/result` 文本 |
| `stdout.expected.jsonl` | 客户端看到的 ACP JSON-RPC |
| `tool-schemas.expected.json` | 五个 `session_*` 工具的完整定义，按模型请求携带的样子。归 `session-query-turn` 所有 |
| `system-prompt.expected.md` | 组装好的提示词，含 session-query 的历史会话段落。归 `session-query-turn` 所有 |

`session-query-turn` 是 `authored` 而不是 `live`：它的模型脚本就是提交在库的 `replay.override.json`，换成真实模型只会改个措辞。它读的是每个会话的第一个事件，不带任何 id 或路径；结果文本里的事件时间由快照规范化器替换。

## 运行

| 命令 | 作用 |
|---|---|
| `pnpm run test:snapshot snapshots/desktop` | 回放本泳道及其固定文件守卫。无需 key |
| `pnpm run test:snapshot:refresh snapshots/desktop` | 回放提交在库的模型脚本，重写 stdout、会话日志和两个自有旁注文件。无需 key；每处 diff 都要审 |
| `pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts` | 对所有泳道的清单、归属与规范化不动点跑 corpus 闸门 |

本泳道没有录制这一步，因为没有场景是 `live`。持有 key 的人若要一份真实会话记录，把某个 `snapshot.yml` 改成 `recording: live`，删掉它的 `replay.override.json` 和清单里的 `replay.override`，再运行 `pnpm run test:snapshot:record -t <name>`；只有这条路径会读 `DEEPSEEK_API_KEY`。

## 运行环境

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 适配器的凭据；仅录制模式使用 |
| `DSH_SNAPSHOT` | `replay`、`record` 或 `refresh`；同时选用原始 JSONL 持久化 |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | 快照 harness 采集的会话目录 |
| `DSH_SNAPSHOT_FILE`、`DSH_SNAPSHOT_OVERRIDE` | `llm-replay` 读取的选定会话固定文件和模型脚本覆盖文件；由 harness 设置 |
