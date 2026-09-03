# Agent Note: 给持久附件服务边界新增文本文件这一种类

Status: implemented

[English](2026-08-27-file-attachment-storage-seam.md) | 中文

## 问题

如今拖入输入区的文件要么被直接拒绝——标准 harness 没有非图片的附件通路——要么通过正在退役的第三方插件 `@sumomok/dsh-text-drop`，被当作原始文本直接拼接进草稿。拼接绕过了图片早已使用的、持久且内容寻址的附件服务边界：会话日志中拼接进去的文本没有任何引用可供重新获取、校验或去重，这个文件也只是作为普通草稿文本挤占上下文预算，而不是拥有自己限额的一等公民部分。这是一组提交序列中的第一个，目标是通过逐一镜像既有图片附件流水线，恢复文件的一等公民支持。

## 决策

`packages/attachment` 新增一套与图片平行的类型家族：`FileAttachmentLimits`/`FileAttachmentRef`/`SaveFileAttachment`/`StoredFileAttachment`/`EncodedFileAttachment`，以及 `AttachmentStore.validateFile`/`saveFile`/`saveFiles`/`readFile`（镜像 `validateImage`/`saveImage`/`saveImages`/`readImage`，包括“先校验全部、再提交”的批次纪律）和 `admitEncodedFiles`（镜像 `admitEncodedImages`）。与图片的两处差异是刻意为之，不是疏漏：`FileAttachmentRef.name` 始终存在（文件卡片除此之外没有可展示的内容，不像图片的名称是可选的），也没有媒体类型、宽度、高度，也没有请求投影方法（`readImageRequest` 的对应物）——文件在请求时（后续提交）会降级为纯文本，而不需要提供方相关的派生形式。

`EncodedFileAttachment` 的 wire 形式携带纯 UTF-8 文本而非 base64：与光栅图片不同，这里不存在需要规范化的二进制传输歧义。`admitEncodedFiles` 会把这段文本重新编码为字节，使 `saveFiles` 无论传输方式如何都在字节层面校验每次上传，这与 `admitEncodedImages` 在自己的批量准入之前把 base64 解码为字节的做法对称。

`packages/attachment/attachment-local` 实现了具体的校验逻辑。`sniff.ts` 原样移植了正在退役的插件的 `core/sniff.ts`（`PROBE_BYTES`、`sniffProbe` 及其测试套件）：文件任意位置的 NUL 字节是决定性的，否则 `stream: true` 的 UTF-8 解码会容忍在探测窗口边缘被截断的多字节序列。`text.ts` 的 `detectText` 先对完整提交的字节整体调用一次该函数作为快速的第一轮分类，随后再执行一次不带 `stream: true` 的 `TextDecoder` 解码，权威地捕获 `stream: true` 本就设计要容忍的那一种情形——一个完整文件末尾真正被截断的序列。两种失败都会抛出 `NOT_TEXT_FILE`。与图片不同，文本文件按原样存储：没有规范化，也没有派生的请求形式。持久对象就是提交的原始字节，以其自身的 SHA-256 摘要寻址，与图片已经占用的同一个 `objects/` 目录树共享——两种附件都是按摘要寻址的二进制对象，因此存储层不需要为新种类引入任何新概念。发布路径（`commitPreparedTextFile`）与读取路径（`readTextFile`）通过这次改动做出的抽取，与图片共用持久写入与摘要校验读取的核心逻辑（`commitDurableObject`、`readVerifiedObject`），而不是把 fsync/硬链接/校验的流程再复制一遍。

## 备选方案

**给文件单独开一个对象命名空间，与图片分开。** 不予采纳：两种附件都是不可变、按摘要寻址的二进制对象；拆分它们需要一个图片的读写路径都不具备的理由，现有图片对象也不需要相应的拆分。

**让服务边界把 `SaveFileAttachment.data` 接收为 JS 字符串而非字节。** 不予采纳：抽象服务边界对图片本就接收原始字节，无论 wire 编码如何，因此对文件同样接收字节能保留唯一一个校验入口，无论调用方是 wire 准入路径、未来的 CLI，还是测试，行为都一致——这也是让 `NOT_TEXT_FILE` 的 NUL 字节与非法 UTF-8 检查真正有意义的唯一方式，因为 JS 字符串在存在的那一刻就已经被解码过了。

**服务端也只做窗口化的探测式嗅探，镜像客户端避免完整读取一个巨大 `File` 的需求。** 不予采纳：`maxFileBytes` 在任何内容被检查之前就已经限定了提交大小，且服务端在 `saveFile` 运行时已经把完整缓冲区持有在内存中，窗口化探测不会节省任何东西。`sniffProbe` 仍以不加窗口的形式导出，留给后续提交里客户端侧的预嗅探使用。

## 后果

每个组合 `LocalAttachmentStore` 的提供方都新增三项可按部署配置的限额（`maxFileBytes`、`maxFilesPerMessage`、`maxMessageFileBytes`，默认分别为 1MiB/10/10MiB），此外没有其他行为变化：目前还没有任何调用方使用 `saveFile` 或 `admitEncodedFiles`，因此本提交在后续把调用方接入该服务边界的 wire、会话与请求物化提交落地之前始终是惰性的。抽取出的共享核心（`commitDurableObject`、`readVerifiedObject`）由完整的既有图片测试套件覆盖，且未改变其行为。

**退役条件。** 本补丁是针对上游尚未具备能力的临时 overlay：若上游为 `@deepseek-ai/dsh-attachment` 添加了镜像图片的文本文件准入与存储服务边界，即退役该补丁，并让 fork 适配上游形式。
