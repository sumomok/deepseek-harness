---
description: "实验性决策账本：已记录的决定成为模型无法改写的常量，最终交付由宿主组装。"
kind: "package-reference"
---

# @deepseek-ai/dsh-decision-state

[English](README.md) | 中文

## 概述

把一个范围内的决定按版本记录为持久的 Session 消息，折叠出当前有效状态，用该状态校验模型提交，并把决定与已接受的开放处置组装成最终交付。

一条决定落在若干单元上。已决定的单元是常量：改写它、或把它再次派进任务的提交，都会被结构化错误拒绝。提交必须携带当前 revision、处置每一个开放单元、并让每个 `new` 单元至少进入一个任务。`assemble()` 把有效决定合并回交付物，因此已定部分从不经过模型之手。

本包目前只包含纯折叠、校验、组装与有界视图；服务、投影、上下文提供者与工具注册随后在同一分支补齐。

## 使用本包

```ts
import { applyLedgerEntry, EMPTY_SCOPE, validateSubmission, assemble, renderView } from '@deepseek-ai/dsh-decision-state'

const state = applyLedgerEntry(EMPTY_SCOPE, entry)
const result = validateSubmission(submission, state, catalog)
if (result.ok) deliver(assemble(state, submission))
```

## 模型体验

### 模型看到什么

`renderView()` 每条有效决定一行，并给出剩余开放单元数量；行数达到调用方上限时附上明确的省略条数。该视图只用于可见性，强制发生在提交上，而不是文本上。

### Token 影响

视图受调用方行数上限约束；省略数量显式给出，而不是静默截断。

## 已知限制与后续工作

- 交付物中已定部分的正确性，取决于写入账本的那条记录。记录由宿主在决定发生时写入；本包自身不识别决定。
- 无法表达为单元处置的规则仍然只能靠上下文提醒。
- 强制只覆盖受控提交；自由正文与旁路操作不在边界内。
- 服务、投影、上下文提供者与工具注册尚未实现。

## 开发说明

- `src/state.ts` —— 确定性折叠；过期条目返回原状态引用。
- `src/validate.ts` —— 提交校验、宿主组装、有界视图。
- `src/types.ts` —— 决定与账本类型，以及 `decision-state` 消息来源。
- `tests/` —— 折叠、校验与视图行为；运行 `pnpm exec vitest run packages/experimental/decision-state`。
