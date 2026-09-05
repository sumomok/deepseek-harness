# core-patches 补丁登记

core-patches 分支上的每一个补丁在此登记；新增、修改、退役补丁时必须同步更新本文档。

**当前补丁线**：`core-patches-v7`，基座 `upstream/master` = `d347e70390`（0.1.3-alpha.1）。上一条线 `core-patches-v6` = `473b700a53`，基座 `76fda72979`（0.1.2-rc.1）。v7 **不是 v6 的变基**，而是在新基座上**重新移植**——上游本轮 229 提交合入了 #2984 generic file upload 与会话格式 v0→v1→v2 迁移系列，把补丁线整个「文件附件族」同功能重新实现了一遍且架构不同，逐条退役判定见下方「重新移植：rc.1 → 0.1.3-alpha.1」。

## patch(session-format-v0-to-v1,session-format-v1-to-v2): 把已落盘的仓外历史事件带过迁移边 — 本线新增

- **改了什么**：`packages/session/session-format-v0-to-v1/src/dispositions.ts` 新增导出 `LEGACY_UNINTERPRETED_EVENT_TYPES`（`attachment/materialized`、`permissionRules/decision`）；`validation.ts` 的 `assertArtifactCoordinates` 把这两类算作可接受词汇，`assertNormalizedReleasedV0Artifact` 的逐事件 payload 校验改成与 `assertReleasedV1Artifact` 同款的 `disposition !== undefined` 守卫；`migration.ts` 同样守卫该 payload 校验，并新增 `markLegacyUninterpreted()` 在 v0→v1 边上给这两类事件盖 `ignorable: true`；`session-format-v1-to-v2` 的 `migration.ts` 未知类型拒收与 `validation.ts` 的 v2 目标校验各自放行这两类。两个包各加一正一反单测。
- **为什么**：v0→v1 迁移对不在冻结清单里的事件类型一律拒迁，且明确不认 `ignorable: true`（错误原文：`migration refuses unknown historical events even when ignorable`）。这类会话在列表里可见、点开才炸。本机 `~/.dsh` 全部 128 份日志实测：36 种事件类型，只有 `permissionRules/decision`（3 份实验会话，旧版仓外插件 `llm-permission-gateway` 写的）落在清单外；`attachment/materialized` 是 fork 自有包 `dsh-attachment-spill` 写的事件，随 rc.29/rc.30 桌面发出去过，一旦触发过溢出附件就会中招。已落盘的会话改不了，只能让读侧认它们。
- **要达到的效果**：含这两类事件的 v0 日志能迁移并读回，事件本身原样保留（payload 不解释），到达 v2 时带 `ignorable: true` 供安装态还原器识别；原 v0 文件逐字节不动；其它未命名的未知类型仍在 `decodeArtifact` 阶段被拒。
- **实证**：本机 3 份含 `permissionRules/decision` 的实验会话只读副本，补丁前 `OPEN FAILED`，补丁后三份全部 `OPEN ok`（37 / 47 / 133 事件，seq 密集无洞，`permissionRules/decision` 各留存 1 条，用户消息正文可读回）；4 份原始 `session.jsonl.zstd` 的 sha256 前后一致，只新增 `session.v2.jsonl.zstd`；迁移后事件的 `ignorable` 实测为 `true`，envelope 键为 `['data','ignorable','seq','time','type']`。
- **退役条件**：上游把这两类事件纳入清单，或为迁移边提供自定义词汇扩展点。
- **状态**：在役

## 重新移植：rc.1 → 0.1.3-alpha.1（`core-patches-v6` 473b700a53 → `core-patches-v7`，229 个上游提交）

镜像快进 `master` 到 `upstream/master`（`76fda72979..d347e70390`，先验 `git merge-base --is-ancestor` 双向为祖先，纯快进无 force），`git push origin master` 成功。`core-patches-v7` 从 `upstream/master` 重建（该分支从未推过 origin，本地 `reset --hard` 不是 force）。

**为什么不是变基**：上一轮尝试 `git rebase --onto upstream/master 76fda72979` 在第 7 条补丁处中止。上游本轮合入了 **#2984 generic file upload**（`packages/client/file-upload` HTTP 上传通道 + 后台上传 runtime + 重试、`AttachmentStore.saveFile/saveFileStream/readFileStream/fileHostPath/admitEncodedFile`、`FileAttachmentRef`/`EncodedFileAttachment`/`SaveFileAttachment`/`AttachmentAdmissionPart`/`AdmittedPromptContentPart`、`ContentBlockMap['file']`、`ComposerAttachments.onAddFiles` + `FileCard` + 混合附件呈现、`apps/web/tests/file-upload-round.e2e.ts`）与 **会话格式 v0→v1→v2 迁移系列**（`SESSION_FORMAT_VERSION` 0→2，新包 `session-format{,-catalog,-v0-to-v1,-v1-to-v2}`）。文件面交集从上一轮的 13 个（全是生成物）涨到 **126 个**。郝然 2026-09-05 拍板：文件附件族整体退役，改用上游通用文件交互。

**上游对应物**：文件存储服务边界 = `AttachmentStore.saveFile/saveFileStream/readFileStream/fileHostPath/admitEncodedFile`；prompt 准入 = `AttachmentStore.admitPromptContent()` 直接放行 `{type:'file', attachment}`；模型侧 = `projectFilesToText`/`LlmService.fileRequestText`/`fileReadPath`（文件降级成**可读路径句柄**交给模型自己读，而不是内联正文，因此"溢出"概念不存在）；上传通道 = `packages/client/file-upload`；composer = `ComposerAttachments` 的 `onAddFiles`/`FileCard`/`uploads`/`onRetryFile`。`FileAttachmentRef` 与我方**逐字段相同**（`attachmentId`/`name`/`bytes`），`FileBlock` 结构相同，因此 rc.29/rc.30 写下的含文件块会话日志与上游形状兼容。

**逐条处理**（旧线 73 条，按变基顺序；施工计划见 `scratchpad/roll7/plan.md`）：

### 保留（可直接 apply）

| 旧提交 | 标题 | 冲突与解法 |
|---|---|---|
| `6e7fe50a04` | fix(scripts): let the workspace gate see apps that never publish | `check-workspace-constraints.ts` 与上游新增的 `checkDshFamilyVersion` 并集 |
| `127dfecfeb` | feat(permission-presets): let a host-configured preset name its selector glyph | `docs/config-catalog.i18n.yaml` 走 `resolve-translation-pairing-conflicts` |
| `6256c16e75` | feat(ui-conversation): open a contribution seat on user messages | `slot-catalog.ts` 生成物重跑 `gen-cordis-catalog` |
| `a0e878ee21` | feat(ui-primitives): export the ANSI line parser | 自动合并 |
| `69054ce8ac` | fix(ui-primitives): stop silently discarding a disallowed link destination | 保留上游新增的 `anchorWrapsOnlyImages` 与 `renderSafeLink(..., glyph = true)`，只叠加回退分支；README 中英按上游新句尾为底插入我方小句后 `verify-translation-pairing --write` |
| `97ddd81032` | fix(session-controller): a distinguishable not-found error from openWorkspacePath | 自动合并 |
| `8c93debb77` | feat(session-controller): a batch path-existence probe (probeTargets) | 自动合并；另加一条 `test(api-session-controller)` 把 `probeTargets` 补进客户端 fake 的 session 命名空间（Remote 命名空间类型要求成员齐全，v6 里这一处由已退役的 Family A 提交带入） |
| `73ee25a733` | fix(ui-primitives): re-render a settled message on a referents verification tick | `tests/markdown.client.spec.tsx` 导入行冲突：取我方 `act`/`vi`，丢掉已退役的 `MessageText` 导入 |
| `f4daa9ca2b` | test(ui-primitives): cover every linkPlainText branch | 自动合并 |
| `bc36c748b0` | test(ui-primitives): confirm a space-containing link destination survives real CommonMark parsing | 自动合并 |
| `be57190d6e` | fix(ui-chat): degrade a prose referent's not-found race to the composer's own notice | `locale.ts` 冲突：只保留 `referent.notFound` 两语言，丢掉随文件卡退役的三条 `file.*` 文案 |
| `f54bdfacc8` `5c78d3bdf5` `495195aed4` | fix(agent-presets): 遗留 `code`→`ptc` 别名三连 | 三条都只冲突在台账文件，取新台账；上游 `agent-presets/src` 下 `legacy`/`alias` 仍零命中 |

### 改写（对着新代码重做）

| 旧提交 | 标题 | 为什么要重做 |
|---|---|---|
| `e50c23f5fc` `26d9306242` | feat/fix(client-runtime): connection/state 粗粒度状态与三态修正 | 机制上游仍无（`packages/client/connection` 零命中）。两条都自动合并干净，生成器重跑后零改动 |
| `63bed0e718` + `dba41ca834` | feat(ui-chat,api-session-controller): file-part bubble card and the referent/open seam（+ 走 ctx.referent 的后续修正） | **拆分后合成一条新提交** `feat(api-session-controller): a referent/open interception seam for reference clicks`：直接落最终形态（`client/referent.ts` 的 `referent/open` waterfall + `ReferentRef`/`ReferentKindMap` + `dispatchReferentOpen` + `ClientReferent`/`ctx.referent`、client `index.ts` 注册与导出、`referent.client.spec.ts`、`test-support/client-runtime` 挂载真服务、`gen-cordis-catalog` 的服务/事件豁免行、session-controller README 双语段落）。`FileCard`、`{kind:'file'}` 内联渲染、`loadFile`/`ISession.readFile`、事件投影 file 分支、`ui-trajectory` 与 `attachment-labels` 的文件文案随文件族退役 |
| `6fea5900eb` `f4f82d0304` `5ab8af0857` | feat(ui-chat,ui-primitives): proseReferents 缝 + resolveLink/subscribe + 本地路径链接目标 | 上游零命中，机制保留。`6fea5900eb` 十处冲突：`slots.ts`/`ChatView`/`ChatNodeSeat`/`AssistantMarkdown`/`AssistantNodeView`/`ui-primitives/src/index.ts` 一律取我方侧再删掉 `loadFile`/`openReferent`/`FileAttachmentRef`/`MessageText` 这些文件族成员；`apply.ts` 取我方的 `buildProseReferents` 接线与 `openFile` 包裹，注释里删掉"file card below"一句；`slot-catalog.ts` 与 `workflow-run.client.spec.tsx` 走生成器重跑与 `referents: undefined` 一行。`5ab8af0857` 与上游的 `anchorWrapsOnlyImages`/`glyph` 同处：保留上游第四实参，只在前面插本地路径分支。`OpenReferent` 类型随其唯一消费者（文件卡）退役 |
| `0ab9760264` | test(ui-chat,session-query): cover the file-attachment and referent seams | **拆分**：保留 `dir` referent 与 composer 提示的 session-died 竞态两条；删掉 `loadFile`/`openReferent` 两条与 `session-query/search-helpers.spec.ts` 的 file 内容块断言（上游 `extraction.ts` 不索引文件名） |
| `f13efcd83b` `84676f680a` `fa7d5afc65` `4f3e1b462d` | feat/fix/patch(session-log-export): 页面内导出进度、两趟测量陈述、不可读媒体记录 | 上游把 `archive.ts` 改了 176 行（配合通用文件与格式代次），我方在同一文件改了 287 行，`archive.ts` **整体对着上游新版重写**：从上游的 `sessionLogZipEntries` 里抽出 `sessionLogTextEntries`，同时填 `media` 与 `files` 两张去重表（上游新增的通用文件），`sessionLogZipEntries` 变成"日志 → 图片 → 文件"三段；`measureSessionLogZip` 按 `ImageAttachmentRef.bytes` 与 `FileAttachmentRef.bytes` 计量两类附件，`wireRatio` 的"媒体"措辞改为"附件"；`mediaEntry`/`unreadableMediaEntry` 只覆盖图片（上游的通用文件走流式分块，失败仍会撕裂流——本轮不扩大范围）。测试断言里三处写死的 `session.jsonl` 改用 `exportLogName`/`subagentLogName`（上游 `SESSION_LOG_FILENAME` 现为 `session.v2.jsonl`）。`Dialog.tsx` 原先从 ui-primitives 取 `attachmentSizeText`，该文件随 composer 族退役，改为包内自有的 `client/byte-size.ts::byteSizeText` 并带上单测与 `tsconfig.client.json` 文件登记 |

### 退役（上游已实现同功能）

| 旧提交 | 原标题 | 上游对应实现 |
|---|---|---|
| `138d8f7f3e` | feat(attachment): a text-file kind for the durable attachment seam | `AttachmentStore.saveFile/saveFileStream/readFileStream/admitEncodedFile` + 同名类型族；上游不做文本嗅探、不设限额、按 verbatim 存任意字节 |
| `62abbac144` | fix(attachment): stub the file-attachment abstract members on every AttachmentStore test double | 上游文件方法是非抽象默认实现（默认拒绝），测试替身无需 stub |
| `8517003d3f` | feat(llm,session-query): declare the FileBlock content-block member | `ContentBlockMap['file'] = FileBlock`，结构相同 |
| `5e487ef0f5` | feat(session-controller,subagent): admit file parts on the prompt path | `AttachmentAdmissionPart` + `admitPromptContent()` |
| `c7aba4e885` | feat(session-controller): add a session.file readback RPC for durable text files | 只为文件气泡卡的内联展开服务；上游文件回读走 `readFileStream` / `file-upload` 通道 |
| `dc61064658` | feat(attachment,llm,llm-deepseek,llm-pi-ai): spill oversized file attachments instead of truncating them | `projectFilesToText` 走路径句柄，不内联正文，溢出概念不存在。**`packages/attachment/attachment-spill` 整包不带过来**；`bundle/base` 挂载行、`known-event-types.ts` 的 `attachment/materialized`、`llm/src/file-lowering.ts`、两个适配器降级调用点、`token-meter` 定价 case 一并不移植 |
| `2c050dae47` | feat(ui-conversation,ui-attachment): text files as composer draft attachments | `ComposerAttachments.onAddFiles` + `FileCard` + 后台上传服务 + 重试；连带 `ui-primitives/src/{byte-size,file-sniff}.ts` 不移植 |
| `50c612adeb` | fix(ui-attachment): re-record i18n pairing sidecar for README | 依赖上条 |
| `a6b0a2c876` | chore(core-patches): close the wrap-up doc-sync/hygiene gaps for Family B | 内容是给 `byte-size.ts` 的 `B`/`KB` 词元豁免与文件族 note 路径修正 |
| `7335c14a92` `a226cad615` `2ef436ec6e` `f62694e1ae` | fix(attachment-spill): 工作区 files 字段 / 版本约束 / 空 invariant 伴生 | 包不移植 |
| `03509d2477` | fix(fs-tool-fs,api-session-controller,ui-chat,ui-conversation): close file-attachment gaps exposed by the alpha.3 rebase | 全是文件族测试与 `read-image.spec.ts` 的 stub |
| `7a622f86a4` | fix(api-session-controller,attachment-spill,ui-attachment,ui-chat): close the gaps exposed by the alpha.4 rebase | `attachment-spill` 测试与 `FileChip`/`FileCard` CSS |
| `8b8308147d` | test(web): match the composer's own drop-overlay copy and text-file intake | 文件族 e2e 期望 |
| `97963ba271` | refactor(ui-conversation): drop the unreachable SUBAGENT_FILE_UNSUPPORTED reason | 该原因码本就随文件族进来 |
| `5635f8980d` | fix(ui-chat): drive the loadFile failure test with a declared remote error code | `loadFile` 随文件族退役 |
| `98e602162f` | fix(ui-conversation): sync the drop-overlay description to its settled copy | 文件族文案 |

### 待重做（第二片，产品功能）

| 旧提交 | 原标题 | 为什么押后 |
|---|---|---|
| `a3e160e584` `d7bd506c9c` `d1e6f255e5` | feat/fix: 发送前确认位于已知密钥容器的文件（含从发送时移到添加时、以及其 Config 断言修正） | 上游无对应物，产品价值仍在；但整个挂载点（composer 文件草稿）已退役，需对着上游 `file-upload` 通道与 `ComposerAttachments` 重新设计挂载位置 |

### 台账类提交

旧线 21 条 `docs(core-patches)` / `docs:` 提交（`12a3e9a743`、`90c959b72f`、`350236ab92`、`3df2465407`、`f345d3b855`、`c8eb00a94e`、`7d31ff32cd`、`dd5b3b5906`、`1ccd7bf27b`、`91c19cfa60`、`9e33c783dd`、`60e69f151e`、`3ef327c5ac`、`109b32737d`、`80e9f1531e`、`720a9362da`、`fa9a0678c2`、`bc7f1eac31`、`80d93816ef`、`6aa98ad955`、`c939aad00b`、`cdb74fb249`、`4f01454e9a`、`72d966ed10`、`473b700a53`）不逐条移植，由本节统一重写。

**旧会话可读性预审（在纯 `upstream/master` 树上做，先于任何移植）**：
- 真实会话 `session-9ca7767d-…`（v0，`agentPreset:"code"`）与 `session-a6d7c058-…`（v0，`agentPreset:"ptc"`）只读拷贝后用新树读回：两者 `header.version` 读作 `2`，事件 29 / 906 条、seq 密集无洞；原 `session.jsonl.zstd` 逐字节未变，只在同目录新增 `session.v2.jsonl.zstd`；同目录未打开的两个会话零新增文件（`list()` 只读头、不迁移）。
- 事件数对账：旧线 `core-patches-v6` 读同一份拷贝得 608 / 219417 条（含 579 / 218511 条 `assistant/chunk`），减去 chunk 后恰为 29 / 906，与新线读回数逐一相等，非 chunk 事件逐类型计数两边完全相同。
- 服务端：`DSH_HOME` 指向 `~/.dsh.backup-2026-09-02-before-rc27` 的 scratch 副本（121 份 v0 日志），新树 `dsh web --no-open --port 0` 起服务后 `POST /api/session/list` 返回 67 条；旧线同一份副本另起服务端同为 67 条且 sessionId 集合完全相同（缺席的 54 个全在 `_no-cwd` 下，是既有的列表策略）。新线额外为 21 个会话填出了标题。服务端跑完 121 个文件 sha256 全部未变、零新增。

**本轮新增的两条适配提交**：
1. `test(api-session-controller): bind probeTargets on the client fake's session namespace` —— `probeTargets` 在 v6 里由已退役的 Family A 提交补进 `tests/fake-api.client.ts`；Remote 命名空间类型要求成员齐全，缺它客户端面不编译。
2. `fix(ui-chat): reach referent/open through ctx.referent and stamp the v2 stream on a fixture` —— 客户端 bundle purity 禁止 `packages/client/*` 直接值导入别的插件运行时导出，`dispatchReferentOpen` 是真正的跨插件调用，改走注入的 `ctx.referent`（等价于 v6 的 `dba41ca834`，本轮在构建门禁上复现）；同一提交给 `apps/web/tests/navigation-panes.e2e.ts` 的 `assistant/message` 夹具补上 format v2 要求的 `stream` 成员。

**分支 HEAD 登记**：起点 `upstream/master` = `d347e70390`（`core-patches-v7` 由 `reset --hard` 从此重建，该分支从未推过 origin）。
