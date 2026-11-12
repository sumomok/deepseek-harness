---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-context-source-metadata

[English](2026-11-13-context-source-metadata.md) | 中文

## 概述

保持 Session 格式 V4，新增可选的 user source references，以及 compaction-rehydration 和 memory-recall source 分支。这些新增项影响用户消息、开发者消息、收件箱插入项，以及标题请求中传递引用的 Message[] 声明。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-context-source-metadata
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "60131246b57c365269ddf04bbea7767b7a69882016c26186c6d268b5b9aa0647"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "6e0e5bb1b52e3eeade2262503f7ab33319eb095403d09840e34dfd2c073dbb7d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "b7513b6f33332679ef8fb039b0e255b595445a024a8196c209e0807b44f256b1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "d417e49b19afc351e8877aad429bb3c6a325981a5bad9c63279c6b6812f59737"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 references 的历史 user source 仍可读取，且不会补造元数据。可选 references 字段承载显示及所属组件的 JSON 数据，与消息内容独立；缺失时保留普通提示行为。旧版 V4 reader 原样保留额外的 source 字段。两个新生产者种类携带的上下文已经记录在消息内容中：compaction-rehydration 记录检查点身份、分节摘要和可选的 ContextFormed 元数据；memory-recall 记录查询摘要及选中事件的身份。原生 V4 准入无需安装这些生产者，即可接受非空的生产者 kind。用户和开发者 surface 消息在派生历史时保留内容和 source 元数据；收件箱插入项仍处于待处理状态。只有安装对应生产者时，其专用去重逻辑才消费已记录的元数据。既有 kind、角色、header 版本和信封规则保持不变。

标题请求的联合类型通过用户和开发者 source 分支发生传递变化；这不允许新增运行时标题表示。标题写入方仍记录一条 user 消息，其 source.kind 为 dsh-session-title-llm，且只有一个 text 块。旧版和当前 reader 都要求这个判别值以及指向更早人类消息的 messageSeqs。对于携带新 source 分支的标题请求，reader 在返回 handle 前拒绝，且不会改变或截断文件。普通历史标题请求仍可读取，也仍不进入对话历史。

兼容性回归执行了当前 reader、集成前 master 的 reader 源码，以及已发布 dsh-v0.2.0-rc.2 的 reader 源码。各 reader 在普通 JSONL 和 Zstandard 编码的读、写打开中，均保留有效记录并拒绝无效标题 source。历史运行复用了当前检出的已安装依赖；发布版插件的 default 导出通过仅用于测试的挂载适配器加载。没有修改历史 reader 实现或已接受的持久化记录。

<a id="verification"></a>
## 验证

运行 node node_modules/vitest/vitest.mjs run，选择 [merged-source-compatibility.spec.ts](../../packages/session/session-persistence-jsonl/tests/merged-source-compatibility.spec.ts)、[native-source-admission.spec.ts](../../packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts)、[message-sources.spec.ts](../../packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts)、[标题 llm.spec.ts](../../packages/session/session-title-llm/tests/llm.spec.ts) 和 [DeepSeek serialize.spec.ts](../../packages/llm/llm-deepseek/tests/serialize.spec.ts)：5 个文件、323 项测试通过。新增的 160 项回归在未安装生产者插件的情况下，检查完整事件、派生内容、历史 references 缺失、全部七种 rehydration form 分支、memory recall、规范标题、无效标题拒绝、原始字节不变及 generation 数量不变。

通过 Vitest 别名选择历史 Session、格式目录、四个版本化格式包、格式服务、持久化服务和 JSONL provider 源码，运行同一新增回归：集成基线通过 160 项，dsh-v0.2.0-rc.2 通过 160 项。

运行 node node_modules/vitest/vitest.mjs run，选择 [rehydration.spec.ts](../../packages/context/compaction-rehydration/tests/rehydration.spec.ts)、[memory-recall.spec.ts](../../packages/test-support/session-snapshot/tests/memory-recall/memory-recall.spec.ts)、[prompt-references.spec.ts](../../packages/attachment/attachment/tests/prompt-references.spec.ts) 和 [pi-ai convert.spec.ts](../../packages/llm/llm-pi-ai/tests/convert.spec.ts)：4 个文件、155 项测试通过，涵盖重启及 fork 去重和引用校验。

<a id="dev-note"></a>
## 开发备注

无。
