/**
 * `content_read_image` — the agent looks at one picture the page draws.
 *
 * The four text reads answer what a page is written as; this one answers what
 * it shows, for the elements whose whole content is pixels: a QR code, a
 * captcha, a chart, an icon drawn as a shape. The body writes nothing and
 * renders nothing — it registers a wait on the channel the text reads already
 * use, a browser seat exports the element's own rendered pixels, and the host
 * commits them to the attachment store before the call settles. What comes back
 * to the model is one line of facts and the picture itself.
 *
 * Two gates run before the wait opens, in this order and for the same reason:
 * a stored picture is permanent, so the call has to fail before anything is
 * exported rather than after. The ref is checked for shape, and the session's
 * own route is put through `access/model-switch.ts`, which decides whether a
 * picture can reach the model on it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/image-tool
 */

import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  CONTENT_READ_IMAGE_DESCRIPTION, ELEMENT_REF_REFUSAL, failureRefusal, IMAGE_REF_DESCRIPTION, imageHeaderText,
  markupHeaderText, MISREPORTED_REFUSAL,
} from './text.ts'
import { routeGate, type ModelRouteServices } from './model-switch.ts'
import { awaitRead, PAGE_VALUE_SCHEMA, pathOf, readResultView, type ReadWait } from './read-value.ts'
import {
  CAPTURE_MEDIA_TYPES, CONTENT_READ_IMAGE_TOOL_NAME, REF_PATTERN, type ImageAnswer, type ImageSize,
  type ReadOutcome,
} from './wire.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Read one picture in the content column'

/** The canonical outcome declared by the `content_read_image` output schema. */
export interface ContentImageValue {
  /** Discriminant; every other ending rejects. */
  status: 'ok'
  /** The page the column had in front, as the deployment names it. */
  page: { id: string; title: string }
  /** The path the frame is at, origin dropped. */
  url: string
  /** The ref this read named. */
  ref: string
  /** That element's tag, as the document spells it. */
  tag: string
  /** The element's own pixel size, before the export scaled it. */
  natural: ImageSize
  /** False when the page was still changing when the export ran. */
  settled: boolean
  /** The stored picture, which the result's image block references. */
  image: ImageAnswer
}

/** The stored picture, as both the value and the model-facing block name it. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  description: 'The stored picture the result\'s image block shows.',
  properties: {
    attachmentId: { type: 'string', required: true, description: 'The store\'s own id for these pixels.' },
    mediaType: {
      type: 'string',
      enum: [...CAPTURE_MEDIA_TYPES],
      required: true,
      description: 'The format the stored pixels are encoded in.',
    },
    bytes: { type: 'integer', required: true, description: 'How large the stored picture is.' },
    width: { type: 'integer', required: true, description: 'The stored picture\'s width in pixels.' },
    height: { type: 'integer', required: true, description: 'The stored picture\'s height in pixels.' },
    name: { type: 'string', description: 'The store\'s display name for it.' },
  },
} as const

/** One pixel size, as the value states the element's own. */
const SIZE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  description: 'The element\'s own pixel size, before the export scaled it.',
  properties: {
    width: { type: 'integer', required: true, description: 'Width in pixels.' },
    height: { type: 'integer', required: true, description: 'Height in pixels.' },
  },
} as const

/** The value this read answers with. */
const IMAGE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'], required: true, description: 'Always "ok"; every other ending rejects.' },
    page: PAGE_VALUE_SCHEMA,
    url: { type: 'string', required: true, description: 'The path inside the application the frame is at.' },
    ref: { type: 'string', required: true, description: 'The ref this read named.' },
    tag: { type: 'string', required: true, description: 'That element\'s tag, as the document spells it.' },
    natural: SIZE_VALUE_SCHEMA,
    settled: { type: 'boolean', required: true, description: 'Whether the page had stopped changing when it was read.' },
    image: IMAGE_VALUE_SCHEMA,
  },
} as const

/**
 * Turn one settled call into this read's answer.
 * @param outcome - what the call settled as.
 * @returns the canonical value.
 * @throws {Error} for every ending that is not this read's own picture.
 */
function imageValue(outcome: ReadOutcome): ContentImageValue {
  if (outcome.status === 'error') throw new Error(failureRefusal(outcome))
  // One channel carries six tools' answers, so a listing arriving here answers
  // a call this one did not make.
  if (outcome.status !== 'image') throw new Error(MISREPORTED_REFUSAL)
  return {
    status: 'ok',
    page: outcome.page,
    url: pathOf(outcome.url),
    ref: outcome.ref,
    tag: outcome.tag,
    natural: outcome.natural,
    settled: outcome.settled,
    image: outcome.image,
  }
}

/**
 * Re-brand the stored picture into the durable reference an image block carries.
 *
 * The block type itself is spelled structurally, the way every other result of
 * this package spells one: this package depends on the tool runtime, not on the
 * LLM vocabulary that type belongs to. The reference inside it is not spelled
 * structurally, because its id is branded and a plain string is not one.
 * @param image - the stored picture as the value carries it.
 * @returns the attachment reference.
 */
function attachmentRef(image: ImageAnswer): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * The two model-facing blocks one picture read answers with: what was exported,
 * and the picture itself.
 * @param _args - the call's arguments, which the body does not repeat.
 * @param value - the canonical value.
 * @returns the text block and the image block, in that order.
 */
function renderImage(
  _args: unknown,
  value: ContentImageValue,
): ({ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef })[] {
  const header = markupHeaderText({ page: value.page.title, url: value.url, settled: value.settled })
  const line = imageHeaderText({
    ref: value.ref,
    tag: value.tag,
    natural: value.natural,
    exported: { width: value.image.width, height: value.image.height },
    mediaType: value.image.mediaType,
    bytes: value.image.bytes,
  })
  return [
    { type: 'text', text: `${header}\n${line}` },
    { type: 'image', attachment: attachmentRef(value.image) },
  ]
}

/**
 * Build the `content_read_image` tool for one deployment.
 * @param wait - the channel this tool waits on.
 * @param routes - the mounted services the route gate reads.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentReadImageTool(wait: ReadWait, routes: ModelRouteServices): ToolDefinition {
  return defineTool({
    name: CONTENT_READ_IMAGE_TOOL_NAME,
    description: CONTENT_READ_IMAGE_DESCRIPTION,
    parameters: {
      ref: { type: 'string', required: true, description: IMAGE_REF_DESCRIPTION },
    },
    output: {
      schema: IMAGE_OUTPUT,
      render: renderImage,
      // The transcript row names the page it looked at; the picture itself is
      // in the result's own image block.
      presentationMeta: (_args, value) => ({ page: value.page.title }),
    },
    // The read writes nothing to the page and only waits on a browser, and
    // storing pixels is content-addressed, so two of them in one step are
    // answered by the same seat one after the other.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ContentImageValue> {
      if (!REF_PATTERN.test(args.ref)) throw new Error(ELEMENT_REF_REFUSAL)
      const refusal = await routeGate(routes, exec)
      if (refusal !== undefined) throw new Error(refusal)
      return await awaitRead(wait, exec, imageValue)
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: CALL_TITLE,
      kind: 'other',
      rawInput: `ref ${args.ref}`,
    }),
    presentResult: (_args, result): GenericResultView => readResultView(result, CALL_TITLE),
  })
}
