# Agent Note：修复 composer 文件准入提交遗留的构建纯净度缺口与过期断言文案

状态：已实现

[English](2026-08-28-file-attachment-build-purity-and-stale-copy.md) | 中文

## Problem

对气泡呈现/`referent/open` 缝隙那次提交做端到端验证（依据 `docs/testing.md` 对已装配快照证据的要求，跑在真实的 BUILT client 图上）需要一次完整的 `pnpm run build`，而 composer 文件准入那次提交自己的检查——`tsc -b`、oxlint、jscpd、按包限定范围的 vitest、`pnpm run doc-sync`——没有一项会跑到 tsdown 打包器的跨插件纯净度门，也没有一项会跑已构建的 `apps/web` 快照套件。`pnpm run build` 直接失败：`packages/client/ui-attachment/src/client/ComposerAttachments.tsx` 从 `@deepseek-ai/dsh-client-ui-conversation/client` 值导入 `attachmentSizeText`/`partitionDroppedFiles`，却没有在该包的 `dsh.client.external` 里声明这个说明符，于是打包器的纯净度门（`packages/client/tsdown.client.ts`）把它当作未声明的跨插件值导入拒绝——这个缺陷从那次提交起就存在，只是因为此后再没有跑过一次完整构建才一直没被发现。修完这一处之后，把既有的 `apps/web/tests/image-display.snapshot.ts` 套件跑在真实构建上，又暴露出同一次提交遗留的两个缺口：它的遮罩文案断言仍然停在那次提交改文案之前的纯图片版本（`'Drag images here to add them'`、`'Up to 20 images, 5MB each'`），而那次提交早已把文案改成会提及文本文件；它的"不支持的粘贴"场景粘贴的是一个单字节的 `text/plain` 文件，而那次提交新加的内容嗅探现在会把它正确地路由进文件准入通道而不是图片通道的拒绝提示，于是这个场景实际已经不再验证它断言里点名的那件事。

## Decision

**声明这次跨插件请求。** `packages/client/ui-attachment/package.json` 的 `dsh.client` 新增 `"external": ["@deepseek-ai/dsh-client-ui-conversation/client"]`，与 `ComposerAttachments.tsx` 已经在用的原样说明符对齐（`requestedExternals` 按精确说明符匹配，从不做归一化）。`ui-attachment` 早已声明 `inject: ["@deepseek-ai/dsh-client-ui-conversation"]`，因此生产方本就保证先加载；缺的只是打包器一侧的许可名单条目。这是本仓库第一个真正为跨插件值导入使用 `dsh.client.external` 的包——这个机制此前一直存在，却没有任何先例可循。

**修正这两处过期断言本身，而不是场景的意图。** 遮罩文案测试现在断言已发布的 `'Drag images or text files here to add them'` / `'Up to 20 images, 5MB each; text content is sent as-is'` 文案。"不支持的粘贴"场景仍然验证"一个既非图片、也非可嗅探文本的粘贴，依然会显示图片格式拒绝提示"——只是它的固件载荷从一个可嗅探为文本的单字节，改成一段以 NUL 开头的二进制（`Uint8Array([0, 1, 2, 3])`，`application/octet-stream`），无论声明的 MIME 类型是什么都会让客户端嗅探判定失败，因此依然会走到断言真正点名的那条路径上。

**补上 `image-display.snapshot.ts` 的文件版对偶。** 新增 `apps/web/tests/file-display.snapshot.ts`：把一个真正的文本文件粘贴进一个存活的 fixture 会话，发送它，确认气泡里 `FileCard` 的默认点击会经授权的 `session.file` 路由解析出恰好发送出去的原文（证明 fixture 的会话日志里存的是提示处理函数当场铸造的引用，而不是内联原文），并确认收起再展开一次不会丢失已解析出的文本。这正是 `docs/testing.md` 对一次产品用户可见行为改动所要求的已装配应用 transcript 证据——气泡呈现/referent 缝隙那次提交发布时并没有补上它，因为 `apps/web` 快照套件在那次提交上同样没有被跑过。

## Alternatives considered

**保留"不支持的粘贴"场景的文本载荷不变，只把预期结果改成断言它落进文件条。** 否决：这个场景存在的全部意义就是覆盖图片格式拒绝提示，本文件里没有任何其他断言覆盖这条路径；把它改成断言文件路径，只会让拒绝提示这条路径彻底失去已装配层的覆盖，而不是把固件修回它原本想验证的那件事。

## Consequences

`pnpm run build`（`tsc -b tsconfig.client.json` 与 tsdown 的 client 打包两者）均干净；`apps/web/tests/*.snapshot.ts` 全部通过，唯一例外是 `built-boot.snapshot.ts` 里那条官方品牌断言——它需要一次带 `--profile` 的构建调用，本次修复未去补这一项（与文件附件无关——用一次不带品牌的普通 `pnpm run build` 单独复现同样失败，已证实其无关性）。`scripts/verify-client-packages.ts` 及其自身的测试证实这条新增的 `external` 声明是本仓库唯一一条，且解析干净。逐一核查后未发现其他包存在从 `dsh-client-ui-conversation/client` 做值导入却既非仅类型导入（在纯净度门运行之前就被擦除）、也没有这条同类声明的情况。

## 退役条件

与这次修复所纠正的那次提交（`.agents/notes/implemented/feature/2026-08-28-file-attachment-composer-intake.md`）相同的退役条件：一旦上游自己的 composer 泛化为接受非图片附件，那层覆盖连同这次修复一并退役。
