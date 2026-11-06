---
description: "实验性决策账本：已记录的决定成为模型无法改写的常量，最终交付由宿主组装。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-decision-state

[English](README.md) | 中文

## 概述

把工作范围内当前有效的决定以实验性插件记录的形式持久化，折叠成按范围的状态，注入有界运行时上下文视图，用该状态校验模型提交，并把决定与已接受的开放处置组装成最终交付。

一条决定落在若干单元上。已决定的单元是常量：改写它、或把它再次派进任务的提交，都会被结构化错误拒绝。提交必须携带当前 revision、处置每一个开放单元、并让每个 `new` 单元至少进入一个任务。被接受的提案由宿主组装，已定部分从不经过模型之手。

工具 schema 是静态的，所以已定单元仍然写得到；宿主在提交时拒绝它。保证落在提交与交付边界上，而不是 schema 里。

## 使用本包

```yaml
- name: '@deepseek-ai/dsh-experimental-decision-state'
  config:
    scopes:
      demo:
        units: [a, b, c, d]
```

宿主在观察到决定时记录，例如用户采纳方案之后：

```ts
ctx.decisionState.record(agent, {
  scope: 'demo',
  decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [42] }],
  supersedes: [],
})
```

此后 `propose_open_work` 是模型写入该范围的唯一通道：携带当前 revision、剩余单元的处置和任务分组。被接受的提案结束本轮；被拒绝的提案返回模型必须修正的错误码。

## 模型体验

### 模型看到什么

每个配置范围一个运行时上下文段落：当前 revision、每条有效决定一行（有界）、以及开放单元 id（每范围最多 200 个）。该段落是必需项、不做 prompt 变量插值，并在压缩后重新生成。

### Token 影响

`viewLimit` 限制决定行数，`viewBudget` 限制段落字符数，两者都是配置项；省略数量显式给出。

## 已知限制与后续工作

- 交付物中已定部分的正确性，取决于宿主写入的那条记录。记录发生在决定发生时；本包自身不识别决定。
- 范围目录是静态配置，运行期不能新增单元；最新记录校验失败的范围会阻止提交，直到宿主用 `repair()` 或以一条后续有效记录恢复；服务在追加前先折叠校验每次变更，因此自身写入不会制造该阻断。
- 每个范围最多列出 200 个开放单元 id；更大的目录需要本包尚未提供的读取通道。单次提交最多 100 条，标识符最长 200 字符。
- 强制只覆盖受控提交及其渲染结果；自由正文与旁路操作不在边界内。
- 测试中已验证 surface 替换与真实自动压力压缩后记录和视图仍然有效，`cordis.yml` 的 Loader 启动通过源码 shim 验证；已构建的 `lib/` 入口与隔离 profile 运行尚未验证。

## 开发说明

- `src/types.ts` —— 决定与记录类型，以及 `plugin:decision-state/record` 声明。
- `src/state.ts` —— 完整记录的折叠、开放/已定集合、按 id 替换。
- `src/projection.ts` —— 按范围折叠记录；不可读或自相矛盾的记录把范围标为损坏，而不是重新开放单元。
- `src/service.ts` — 宿主即时记录、有界视图与范围目录。
- `src/tool.ts` —— `propose_open_work` 的校验、组装与渲染结果。
- `tests/` — 折叠、校验、视图、投影、包入口契约、Loader 启动、真实 Agent 循环集成测试、surface 替换与自动压力压缩测试；运行 `pnpm exec vitest run packages/experimental/decision-state`。
