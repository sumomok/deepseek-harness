# Agent Note: The v0 identity edge accepts three legacy shapes this fork's Sessions carry

Status: implemented

[English](2026-09-07-v0-migration-legacy-shapes.md) | 中文

## Problem

已发布的 v0→v1 恒等迁移边会拒绝冻结清单之外的任何事件类型，以及某个类型处置之外的任何 payload 成员。正是这条策略保证迁移后的会话精确无误，而它假定清单点名了任何已发货构建曾写下的每一种形状。本 fork 发过的构建写下了三种它没有点名的形状，于是那些构建写下的会话再也打不开。

一次拒绝并不止于携带它的那份会话。`SqliteSessionQuery._reconcile` 会冷读每一份尚未建索引的持久化会话，一次被拒的读取就中止整次观测：[`session-query-sqlite/src/index.ts`](../../../../packages/session-query/session-query-sqlite/src/index.ts) 的 `_observeStable` 把它包成 `SESSION_QUERY_PERSISTENCE_FAILED`，搜索退回按名称匹配，工作区浏览器对库里每一份会话都显示 `内容搜索暂不可用，仅显示名称匹配。`。因此一份旧日志除了赔上自己的历史，还赔上整个内容搜索。

测量方式是用 `JsonlSessionPersistence.open(id, 'read').read()`（reconcile 调用的同一条路径）对两个库做冷读回放。在已经带过仓外事件类型的 0.1.5-rc.1 基座上，`~/.dsh` 的 139 份中 9 份被拒，rc.27 前备份的 121 份中 22 份被拒。因为迁移边在一份会话的第一处故障就停下，这些拒绝点名了四种不同的原因：下面三种形状，外加一种由下一条迁移边拒绝的仓外消息来源种类，那一种由它自己的姊妹补丁点名。

`permission/preset N data has unexpected member "origin"` —— 备份库 11 份，`~/.dsh` 2 份，后者的 v0 日志正是 rc.31 构建尚未迁移过的那些。2026-08 中旬的一个构建在 preset 名旁边记下了这个名字的来处：`{"type":"permission/preset","seq":0,"time":1787322888043,"data":{"preset":"workspace-write","origin":"default"}}` 与 `{"type":"permission/preset","seq":4,"time":1787322901591,"data":{"preset":"yolo-access","origin":"selection"}}`。落盘的取值只有这两个，而 `@deepseek-ai/dsh-permission-presets` 现在只追加 `{ preset }`。

`subagent/descriptor N uses unsupported descriptor version 2` —— 备份库 4 份，例如 `{"type":"subagent/descriptor","seq":0,"time":1787709640297,"data":{"version":2,"mode":"continuable","provider":"spawn","label":"调研黄金类资产与矿股PE","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash-vision-exp"}}`。上游在 2026-08-24 的 `f76a225a7d` 把 `SUBAGENT_DESCRIPTOR_VERSION` 从 2 提到 3；payload 校验器只接受版本 3。

`format v0 contains unknown historical event type "content/shown"` —— 备份库 6 份，例如 `{"type":"content/shown","seq":209,"time":1788074166009,"data":{"page":"reports","by":"user"}}`。它由本 fork `product/server-console` 线的内容面写下，当时桌面构建挂载着那个控制台。

## Decision

[`migration.ts`](../../../../packages/session/session-format-v0-to-v1/src/migration.ts) 在每个 v0 事件本就要走一遍、且先于 payload 校验的规范化链上新增两个规范化器。`normalizeLegacyPermissionPreset` 移除 `origin` 成员，别的一概不动。`normalizeLegacySubagentDescriptor` 把 `version: 2` 改写为 `version: 3`，不碰任何其它成员。[`dispositions.ts`](../../../../packages/session/session-format-v0-to-v1/src/dispositions.ts) 在 `LEGACY_UNINTERPRETED_EVENT_TYPES` 里点名 `product/server-console` 线写下的全部六种内容事件——`content/shown`、`content/navigated`、`content-surface/selected`、`content-surface/dismissed`、`content-component/shown`、`content-component/resolved`——它们因此被原样携带，到达 v2 时带上 `ignorable: true` 供安装态还原器识别。`session-format-v1-to-v2` 读的是同一个集合，所以点名一次即覆盖两条边。

descriptor 选择改写版本号而不是原样放行，因为这次升格是完全的。`f76a225a7d` 的差异只给 continuable descriptor 加了一个可选成员 `agentReasoningEffort`，别的一律未改，所以版本 2 的 payload 恰好等于一份不声明子 Agent 推理力度的版本 3 payload——不需要猜任何字段，也不丢任何字段。像 `assertReleasedEventPayload` 的 v1 分支那样把版本 2 原样带过去，会话根本打不开：`session-format-v1-to-v2` 没有这条豁免，它的 v2 目标校验走到 `subagentDescriptorValue` 并以 `subagent/descriptor N version must be one of 3` 拒绝。改写版本号是让会话得以迁移的那一步，同时也把 payload 留在 `@deepseek-ai/dsh-subagent` 的 `parseSubagentDescriptor` 唯一能识别的那一代。

`origin` 成员选择移除而不是纳入清单。`RELEASED_V0_EVENT_DISPOSITIONS` 声明它列出的每个成员都由恒等迁移边保留，而 `session-format-v1-to-v2` 的 v2 清单又派生自它，所以把一个会被丢弃的成员列进去，在一个包里是假话，并且会把这个成员放进两个后续世代——那里没有任何写入方会写它。在规范化器里移除，正是迁移边对已停用的 `request/header.header.messagePrefix` 的既有做法。

这里没有任何一处扩成通用规则。允许名单仍然是一份落盘实证过的类型清单，`origin` 以外的意外 payload 成员仍被拒绝，2 以外的 descriptor 版本仍被拒绝，没人点名过、只带 `ignorable: true` 的事件类型仍被拒绝。

## 两个库现在的读数

改动之后的同一次回放：`~/.dsh` 的 139 份中 131 份、备份的 121 份中 113 份打得开，三种形状没有一种再拒绝。两个库里仍被拒的各八份是同样那八份会话，它们停在下一代迁移边 V2→V3 上，原因是一种仓外的 `user/message` 来源种类；点名那种来源的姊妹补丁把两个库都做到零拒绝。`session-c5f7ab97-7485-4955-9ee0-f07c98a05d85` 曾在更早的基座上因 `origin` 成员不再先行拒绝后暴露出一处未关闭的 turn 而被拒，在本基座上它能打开：V1→V2 迁移边自己会关闭被打断的 turn。

`content-surface/dismissed` 是同一条路上找出来的——只有当排在它前面的形状不再先行拒绝，它才变得可达。对两个库逐行扫描界定了这两个库持有的集合：在冻结清单与打包物理行标记之外，它们恰好只有 `content/shown`、`content-surface/dismissed` 与已被点名的 `permissionRules/decision`；`permission/preset` 除 `preset` 与 `origin` 外没有别的成员；落盘的 `subagent/descriptor` 没有 2 以外的版本。也就是说六种内容事件里只有两种出现在这两个库中。六种仍然全部点名，因为写它们的是同一条产品线，别人的库里任何一种都会撞上同一次拒绝；清单取自 `git diff HEAD product/server-console -- packages/core/session/src/known-event-types.ts`。

## Alternatives considered

**把 `origin`作为冻结 `permission/preset` 处置的可选成员纳入清单，并在迁移后的会话里保留它。** 这是更小的改动，也保住了旧构建记下的一个事实。它同时让清单与自己写明的含义相矛盾，把该成员传播进 `session-format-v1-to-v2` 由它派生的 v2 清单，并让 v1 或 v2 产物携带一个任何已发布写入方都不写的成员，而下游没有任何东西读它。

**把版本 2 的 `subagent/descriptor` 原样带过去。** payload 校验的 v1 分支对非 3 的版本本就直接返回，把这条扩到 v0 是两行改动、不需要任何升格逻辑。它什么也恢复不了：v1→v2 边用同一套已发布语义校验目标，以 `subagent/descriptor N version must be one of 3` 拒绝，会话只前进一代就停住。对两条边的探针实证了这一点——版本 2 被拒、版本 3 迁移通过。

**让任何带 `ignorable: true` 标记的历史事件通过迁移边。** 这一下就能覆盖 `content/shown` 与 `content-surface/dismissed`，而且以后每一种仓外事件类型都不必再打补丁。迁移边的拒绝文案明确写着 `ignorable: true` 不为历史事件豁免，而这一立场正是阻止任意第三方 payload 未经检视进入冻结世代的东西。点名清单的代价是每种实证出现过的类型一行。

**直接修被拒的落盘会话。** 重写被拒的日志根本不需要改迁移边的代码。它改的是 fork 并不拥有的持久历史，够不着用户的机器，而且每一个仍存有这些构建产物的库都得再做一遍。

## Consequences

带上述三种形状之一的会话能打开、能迁移、能建索引，内容搜索不再因它整库失败。落盘的 v0 文件逐字节不动——迁移把 `session.v3.jsonl.zstd` 写在它旁边——所以删掉迁移世代即可回到此前的拒绝状态。迁移后的 `permission/preset` 不再记录 preset 的来处；当前构建没有任何东西读这个事实，preset 名本身则被保留。迁移后的 `subagent/descriptor` 报版本 3，其 `agentReasoningEffort` 缺席，这正是版本 2 payload 的含义。

两个库各自仍被拒的八份会话停在下一条迁移边上，而不是这一条；清空它们靠的是那种消息来源种类的姊妹补丁。在一个库同时拿到两个补丁之前，reconcile 仍会在第一次被拒的读取上中止，那个库里的内容搜索仍不可用。

## Testing

`session-format-v0-to-v1` 的 `legacy.spec.ts` 钉住每一种形状（两种来自语料的 payload 逐字照录），并钉住证明这次放行足够窄的拒绝：同时带 `origin` 与 `foo` 成员的 `permission/preset` payload、版本 1 的 descriptor，以及没被点名的 `content-surface/whatever` 事件。`session-format-v1-to-v2` 的 `migration.spec.ts` 让六种内容事件走完那条边，并在那里钉住 descriptor 的两个版本。包内覆盖率保持逐文件 100%。

语料回放不是仓内测试。它读的是两个真实库的私有副本，因此活在仓外，数字记录在上文。
