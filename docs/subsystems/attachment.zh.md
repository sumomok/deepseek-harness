# 持久附件

[English](attachment.md) | 中文

附件 seam 将二进制图片与文本文件的所有权与会话日志分离。生产方把经过校验的编码字节交给 [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam)；只有对象完成持久化后，该服务才会发布不可变的内容寻址引用。会话事件和模型可见的 `ImageBlock`/`FileBlock` 包含该引用及其元数据，绝不包含浏览器对象 URL、宿主临时路径、提供方 URL、base64 数据或内联文本。

未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储。宿主接受用户消息后，会先把消息中的图片与文件移到 `<DSH_HOME>/attachments/v1` 下，再追加用户事件——两种附件共享同一棵内容寻址对象树。结构化模型图片输出遵循同样的先持久化、后追加事件规则。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## 标识与经过校验的元数据

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable reference to one immutable normalized image. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}
```

```ts type-equiv
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}
```

本地后端每条消息最多准入 20 张图片，源图编码数据总量不超过 200 MiB。单张源图不得超过 20 MiB、64,000,000 像素和单边 8192 像素。这些源文件限制先于独立的规范化阶段执行；该阶段默认把长边限制为 2048 像素，把编码数据限制为 4 MiB。

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与经校验读取的数据

```ts type-equiv
/** Base64-encoded image upload accompanying one wire request. */
interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

```ts type-equiv
/** Deterministic request-image policy selected by one exact model route. */
interface ImageRequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte cap before base64 expansion or Files API upload. */
  maxBytes: number
}
```

```ts type-equiv
/** Cached request version derived from one provider-independent normalized attachment. */
interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}
```

`saveImage()` 准备并原子提交提供方无关的规范化附件，然后直接返回 `ImageAttachmentRef`。`saveImages()` 在发布批次前为每个成员各准备一次经过验证的附件，因此校验拒绝不会留下部分对象，发布也不会重复解码或选择质量。`admitEncodedImages()` 是面向 base64 上传的 wire 入口，把张数、聚合字节和有序批量准入交给 `saveImages()`。`readImage()` 校验来自已授权会话路径的规范化附件。`readImageRequest()` 按确切路由的像素和字节预算派生并缓存请求版本；新条目在发布前完整解码，缓存命中只做有界元数据探测。调用方需要有序批次时，对单数方法使用 `Promise.all`。本地实现按需编码首选候选、合并相同请求身份的并发任务、允许每个等待方单独取消、没有等待方时停止共享任务，并通过实例级限流器限制全部变换，默认同时执行两项。该服务不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，不与单个会话的删除绑定。

## 文本文件附件

`FileAttachmentRef.name` 始终存在，不同于图片可选的 `name`——文件卡片除此之外没有可展示的内容。没有媒体类型、宽度、高度，也没有请求投影方法：文件按原样存储（没有规范化，也没有派生的请求形式），只在请求时才被降级为纯文本，而且是由分发它的 LLM 适配器完成，绝非这个服务边界本身。

```ts type-equiv
/** Deployment-resolved limits used by text-file upload admission. */
interface FileAttachmentLimits {
  maxFilesPerMessage: number
  maxMessageFileBytes: number
  /** Maximum encoded UTF-8 bytes accepted for one submitted file. */
  maxFileBytes: number
}
```

```ts type-equiv
/** Durable, serializable reference to one immutable stored text file. */
interface FileAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Display name stripped of local path information; always present, unlike an image's optional name. */
  name: string
  /** Exact stored UTF-8 byte length. */
  bytes: number
}
```

```ts type-equiv
/** Wire-form text-file upload accompanying one wire request; plain text, never base64. */
interface EncodedFileAttachment {
  /** Display name; it is never interpreted as a path. */
  name: string
  /** Complete file content. */
  text: string
}
```

```ts type-equiv
/** Request to validate and durably commit one text file. */
interface SaveFileAttachment {
  data: Uint8Array
  /** Display name; it is never interpreted as a path. */
  name: string
}
```

```ts type-equiv
/** Stored file bytes returned after reference and digest verification. */
interface StoredFileAttachment {
  ref: FileAttachmentRef
  data: Uint8Array
}
```

`saveFile()` 校验后原子持久提交一个文本文件，以其自身的 SHA-256 摘要寻址，与图片已经占用的同一个 `objects/` 目录树共享。`saveFiles()` 在发布有序批次中的任何成员之前校验全部成员，与 `saveImages()` 相同的“先校验全部、再提交”纪律。`admitEncodedFiles()` 是面向纯文本上传的 wire 入口（重新编码为 UTF-8 字节），把准入工作交给 `saveFiles()`。`readFile()` 校验来自已授权会话路径的存储文件字节是否仍与记录的引用一致。文本校验——严格的 UTF-8 解码，拒绝 NUL 字节或非法字节序列——只发生一次，在具体后端的 `saveFile`/`saveFiles` 里完成，那里是提交内容的解析边界。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate bytes before publishing a reference.

```ts cordis-catalog
/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * Validate and durably commit one ordered image batch.
 * @param inputs - encoded images in owning-message order.
 * @returns durable normalized attachment references in the same order after every member succeeds.
 */
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>

/**
 * Validate and durably commit one image before its owning session event is appended.
 * The returned reference describes the persisted normalized image. When
 * normalization reduces the raster, its `originalDimensions` records the
 * orientation-applied input dimensions.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns the durable content-addressed normalized image reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and normalized attachment reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

/**
 * Generate or read one deterministic model-request version from the stored normalized image.
 * @param ref - durable provider-independent normalized attachment reference.
 * @param policy - exact route pixel and encoded-byte budget.
 * @param signal - optional cancellation.
 * @returns request bytes and the cache/upload identity covering every transform input.
 */
readImageRequest( ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal, ): Promise<RequestImageAttachment>

/**
 * Validate one text file without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes and display name.
 * @returns completion after the bytes have been proven valid UTF-8 text.
 */
abstract validateFile(input: SaveFileAttachment): Promise<void>

/**
 * Validate and durably commit one ordered file batch.
 * @param inputs - encoded files in owning-message order.
 * @returns durable file references in the same order after every member succeeds.
 */
async saveFiles(inputs: readonly SaveFileAttachment[]): Promise<readonly FileAttachmentRef[]>

/**
 * Validate and durably commit one text file before its owning session event is appended.
 * @param input - encoded bytes and display name.
 * @returns the durable content-addressed file reference.
 */
abstract saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>

/**
 * Read one text file and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and file reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxattachmentspill--attachmentspill"></a>

### `ctx.attachmentSpill` — `AttachmentSpill`

`ctx.attachmentSpill`: idempotent, session-scoped spill materialization for oversized text-file attachments. See the module doc for the full contract.

```ts cordis-catalog
/**
 * Resolve the spill artifact backing one oversized attachment's lowered
 * request text, materializing it at most once per (session, attachment id)
 * in this process.
 * @param attachment - the durable file attachment being lowered.
 * @param content - the attachment's already-decoded full UTF-8 text.
 * @returns the artifact's `SpillRef`, or `undefined` when there is no live
 *   initiating agent to own and log the spill against, `ctx.spillStore` is
 *   not loaded, or the backend rejected the write (best-effort: the caller
 *   keeps the file inline, truncated, on `undefined`).
 */
async resolveSpill(attachment: FileAttachmentRef, content: string): Promise<SpillRef | undefined>
```

Types: [SpillRef](spill.zh.md)

Source: [`packages/attachment/attachment-spill/src/index.ts`](../../packages/attachment/attachment-spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
