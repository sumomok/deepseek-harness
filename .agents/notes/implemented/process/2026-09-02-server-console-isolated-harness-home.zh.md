# Agent Note: The server console runs in its own harness home

Status: implemented

[English](2026-09-02-server-console-isolated-harness-home.md) | 中文

## Problem

本线组合出的网页控制台与桌面版默认共用同一个 harness home：[`resolveDshHome`](../../../../packages/util/home-paths/README.zh.md) 对每一个面都回答 `$DSH_HOME` 或 `~/.dsh`，而两个构建都跑在这个默认值上。控制台的插件会追加桌面版没有声明的会话事件——`content/shown` 就是其中之一——而 `SessionEventMap` 成员默认必读：无法为某个事件定型的构建会拒绝整份日志，而不是跳过该事件（[机制](../architecture/2026-08-10-session-log-version-mechanism.zh.md)）。于是在控制台里进行的每一段对话，在同一台机器的桌面应用里都加载失败，而承担这次失败的是什么都没做错的读取方。

## Decision

本线经 [`scripts/dsh-web.sh`](../../../../scripts/dsh-web.sh) 启动：调用方未提供非空值时，它导出 `DSH_HOME=~/.dsh-web`，切换到仓库根目录以便 `pnpm dsh` 解析到根脚本，然后用 `pnpm dsh web` 替换自身并原样携带每一个参数——组合出控制台的那些 `--patch` overlay 也在内。harness 本身分毫未动：`home-paths` 对每一个面仍以 `~/.dsh` 为默认值，`apps/cli` 也仍旧读它。隔离只落在本线自己的启动面上。

因此两个构建各自持有独立的 `profiles/`、`sessions/`、`settings.yaml` 与 `.credentials.yaml` 树。控制台专用的密钥放进 `~/.dsh-web/.credentials.yaml`，或者把 `DEEPSEEK_API_KEY` 留在启动环境里——它的解析顺序排在受管文档之前。脚本不创建任何目录：harness home 归 `dsh` 所有，其中的 `web` profile 由它在首次使用时初始化，因此隔离出来的 home 会到达与默认 home 完全相同的状态。

## Alternatives considered

**改掉默认 home，无论是改 `home-paths` 还是改 `apps/cli`。**两者都是本 fork 要反复同步的上游代码，改掉默认值会在每次同步时冲突，会迁走每一个既有部署的数据，也会把桌面版一并改道——它读的是同一个解析器。

**把 `content/shown` 以及本线的其他事件标为 `ignorable: true`。**读取方已经认这个信封字段，但 `Session.append()` 只接受 `type`、`data` 和一个 surface intent，插件根本无从设置它；这需要上游先在 append 签名上开口。它同时也只对了一半：对没有内容列的构建而言该事件是纯信息性的，对拥有内容列的构建而言它承重，一个静态标志说不了两件事。无论那个开口是否到来，隔离都成立。

**要求操作者手工 export `DSH_HOME`。**没有产物的约定，在有人直接跑 `pnpm dsh web` 的第一次就会失效，而它造成的损害——一份再也加载不出来的桌面会话日志——浮现的位置离这次遗漏很远。

**给启动器加一个 `--home` 标志。**启动器没有这样的标志，加一个就是对 `apps/cli` 的上游改动，而它要喂的那个环境变量本就存在。

## Consequences

- 两个构建都读不到对方的历史：在控制台里开始的对话对桌面应用不可见，在桌面应用里开始的对话对控制台同样不可见。跨构建的连续性是隔离付出的代价，各自的日志始终可加载是它换来的东西。
- 更早的控制台运行已经写进 `~/.dsh` 的会话仍留在那里。脚本不搬运任何东西，本就拒绝那些日志的桌面版也会继续拒绝。
- `pnpm dsh web` 依然存在，也依然解析到 `~/.dsh`，因此隔离只对经由该脚本的启动成立。
- 若上游开口允许生产方标记自己的事件为可忽略，两个 home 会重新彼此可读；但那不会把它们变成一个 home，因为控制台的设置与凭据仍然因部署而异。
