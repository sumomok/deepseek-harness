# 上下文生命周期夹具（CTX-B4）

[English](README.md) | 中文

五个语料 + 一个夹具生成器，供 B1/B3 的聚焦验收使用。设计依据：任务工作区里的 `.claude-tmp/context-redesign/evidence/dsh-test-harness.md`。

## 文件

| 路径 | 身份 | 规模 | 覆盖 |
|---|---|---|---|
| `fixtures/sample-small/` | derived | 154 KB / 515 事件 | 真实会话第 1 轮：压缩失败、工具调用、配对 |
| `fixtures/control-healthy/` | derived | 97 KB / 315 事件 | turn 15–17：一次**成功**压缩、零失败 |
| `fixtures/boundary-b-consecutive/` | derived | 7.1 KB / 24 事件 | 成功压缩后**紧接着**一次失败压缩 |
| `fixtures/boundary-c-midexit/` | derived + **authored 尾** | 1.1 KB / 13 事件 | `compaction/start` 未闭合 + `session/end-seed` 重启边界 |
| `boundaries.spec.ts` | 测试 | — | 23 条断言（见下） |
| `project.ts` | 工具 | — | 结构保留脱敏投影器 |

夹具 A（并行/延迟 tool_result）**不落文件**：样本里没有延迟结果，所以它在 `boundaries.spec.ts` 里以代码构造，明确标注 authored。

## 生成夹具

原始样本是 live 会话的只读副本（sha256 `2b455df98ad82a62a0f27bb58de78991829ece0e1cb2f6c4fd5c911c3545cf96`，4,998 事件）。**不要**从 live 文件直接生成，也不要改 live 文件。

```sh
W=<repo>/dsh-context-lifecycle
RAW=<work>/sample/live-copy.v4.jsonl          # the zstd -d read-only copy
FIX=$W/packages/test-support/session-snapshot/tests/context-lifecycle/fixtures

cd "$W"
# In this worktree `pnpm exec` runs an install first (it currently fails on a package under edit); call tsx directly.
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/sample-small"            --name sample-small            --seq-range 1:514
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/control-healthy"         --name control-healthy         --seq-range 2673:2986
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/boundary-b-consecutive"  --name boundary-b-consecutive  --seq-range 1568:1590
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/boundary-c-midexit"      --name boundary-c-midexit      --seq-range 1568:1573
# Fixture C's tail (session/end-seed plus one ordinary turn) is appended by hand, see below.
```

跑测试：

```sh
cd "$W" && node_modules/.bin/vitest run packages/test-support/session-snapshot/tests/context-lifecycle/boundaries.spec.ts
```

## 投影规则（`project.ts`）

- **结构保留**：事件类型、顺序、`turn`/`step`、`surfaceOp`、`sourceEventSeqs`、`shadowedSeqs`、`shadowedTokenCount`、`shadowedRange`、`contextWindow`、`maxTokens` 全部保留；`callId`/`jobId`/`compactionId` 等重编号成 `call-0001`… 且跨事件一致。
- **内容换成 `<redacted:类:字节数>`**：保留原文 UTF-8 **字节数**，因此夹具仍能验证 shrink 与预算算术。分类：`text` / `path` / `model` / `provider` / `arguments` / `error` / `summary` / `header`。`meta.json` 的 `redactedBytes` 按类汇总。
- **身份默认禁止**：`harvestIdentities()` 从输入里收集所有 `provider`/`model` 取值，投影后自检**禁止**它们在输出中出现（按整串值匹配，不是子串）。
- **体积上限**：单行 ≤ 4096 B；`request/header` 只留 `reason`/`startsSeries`；assistant 的 `stream` 截到首尾两段；消息 content 截到 1–2 块；`tool/result` 的 `meta` 数组逐层截到 3 项。
- **自检 6 条**（`assertSanitized`，任一条不过就抛错）：路径 0 命中、单行 ≤ 4096 B、禁止身份 0 命中、无未脱敏内容、无孤儿 call、无孤儿 result。

## 断言（`boundaries.spec.ts`，23 条）

**投影器 6 条**：字节数保留、路径标记、默认禁止身份（含 `harvestIdentities` 负例）、`assertSanitized` 拒绝残留身份、拒绝未脱敏内容、拒绝孤儿 call。

**夹具 A 3 条**（authored）：跨步延迟结果仍配对；在 call 与其迟到 result 之间切是**不**平衡的；迟到结果落地后配对闭合。

**夹具 B 5 条**：成功压缩紧接失败压缩（`前.end + 1 === 后.start`）；失败尝试**不改写表面**（其后没有 `replace`）；失败后**不每步重试**（失败 start 只有 1 个）；两次尝试都在时配对完整；每个 bracket 都闭合。

**夹具 C 4 条**：截断点只有一个未闭合 bracket；`session/end-seed` 在未闭合 start **之后**；被放弃的尝试没有任何 `replace`；重启边界之后有正常 `turn/start`…`turn/end`。

**录制语料 5 条**：`sample-small` 与 `control-healthy` 各自通过 6 条自检、配对完整；`control-healthy` 有成功压缩且**无**失败压缩。

## 已知边界

- 夹具 C 的 `session/end-seed` 与后续 turn 是**构造**的：真实样本的 25 次压缩全部闭合、且无一跨重启。这一点在 `meta.json` 的 `authoredTail` 里写明。
- 这些是**包级**夹具：驱动脚本化 adapter，不经过 `dsh` profile。要升格成 committed 快照场景，需另走 `scripts/session-snapshot-corpus-policy.ts`。
- 夹具只覆盖本样本出现的事件类型（约 30 种），不做通用脱敏。

## 引擎驱动测量（task-31）

| 文件 | 断言 | 状态 |
|---|---|---|
| `measurements.spec.ts` | 11 条：录制语料上的 reclaimed、surface 区间、失败不回收、固定前缀起点、保留尾、连续压缩 lineage、摘要 route | 全过 |
| `engine.spec.ts` | 13 条：固定前缀预检、回收不足抑制、语义尾部、连续压缩 bracket、**stale route（真实 adapter 观察 GenerateOptions）**、**熔断重启 seed**、**三个中断点的 durable lock** | 全过 |

运行：

```sh
node_modules/.bin/vitest run packages/test-support/session-snapshot/tests/context-lifecycle
```

`engine.spec.ts` 直接驱动真实 `BasicCompactionEngine.compactIfNeeded(agent,'pressure',signal)`，不桩被测代码；`RecordingEngine` 只覆盖 `summarize()` 以记录调用。

`resume.spec.ts` 覆盖**进程级 resume**：用真实 `JsonlSessionPersistence` 播种，`fiber.dispose()`，起新 Context，再 `agents.resume({ resumeSessionId })`。其中五条覆盖各中断点的 durable lock，断言没有半应用的替换、日志仍是 append-only、且陈旧 start 不阻塞。另一条把 todo 列表与未结算 job 播进**压缩区间之内**，挂上 `dsh-compaction-rehydration`，断言 checkpoint 确实遮蔽了它们，而 resume 后的第一次 pre-step 恰好写一条重建消息、下一次不再追加。

JSONL 后端加锁依赖 `native/system/packages/<platform>-<arch>/bin/system.node`，这是该包的**预编译产物**。工作树里已带该产物，所以用例正常运行；`resume.spec.ts` 顶部保留 `skipIf`，缺产物时自解释地跳过而不是失败。

三个中断点的**引擎级**用例仍在 `engine.spec.ts` 里，不依赖该产物，始终运行。

**给 B2（task-26）的口径**：仍标 `it.fails` 的用例表示尚未实现的目标行为；实现落地后把它改成 `it` 即验收翻转。
