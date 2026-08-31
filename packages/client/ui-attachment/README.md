# @deepseek-ai/dsh-client-ui-attachment

English | [中文](README.zh.md)

Dynamic attachment presentation plugin for the conversation UI. It waits for the conversation package's `conversation.input.attachments` and `conversation.message.images` declarations through `ctx.slots.inject`, then registers the composer draft-image rail, draft-file chip row, document drop target, chat-history image gallery, and original-image lightbox. The conversation slot owner supplies attachment data, image loading, callbacks, and its namespace translator; presentation components remain pure props and are not exported from the package entry.

## Attachment rail

`AttachmentRail` renders pending draft images as fixed 64px thumbnails (16px radius) in one horizontally scrolling row whose scrollbar stays hidden. Overflow is announced by circular edge arrows instead: each pages one viewport (minus one card of context, floored at 200px) with smooth scrolling (instant under `prefers-reduced-motion: reduce`), and arrow visibility is recomputed from scroll geometry on scroll, item-count changes, and rail size changes (a ResizeObserver on the rail element, so sidebar and panel resizes count, not only window resizes). The rail scrolls horizontally only: a non-passive listener consumes every wheel tick with a vertical component — nothing scrolls the conversation behind the composer — converting a pure vertical wheel to a horizontal step (LINE/PAGE deltas normalized to pixels, per-tick travel clamped to 60px) and keeping a diagonal pan's horizontal intent, while purely horizontal pans stay native. A newly added item is revealed at the rail's end; removal keeps the scroll position, and a rail that mounts over an already-populated draft keeps its start position. Each thumbnail opens its original through `onOpen` on a single click, and its remove control sits inside the card's top-right corner, hidden until the card is hovered or the control keyboard-focused; coarse-pointer (touch) surfaces show it permanently because they have no hover. The owner decides mounting and renders the rail only while items exist.

## File chip row

`FileChipRow` renders pending draft text files as chips in a wrapping row beside the image rail, aligned to the same left inset and sitting 6px under it when both are present — a file has nothing to thumbnail, so it gets its own shape rather than reusing the rail's fixed 64px item. Each chip shows a small document glyph, the display name (truncated with an ellipsis, full name in `title`), and a byte-size label, with an inline remove control — no absolute positioning or reserved dead space — that occupies its own place in the row and reveals on hover/focus like a rail thumbnail (always visible on coarse-pointer surfaces). A chip has no open affordance of its own: a sent file's default open action is the referent/open seam's inline expand/collapse viewer on the message bubble, not a draft-time preview. A chip whose draft matched the secret-container heuristic (`secretContainerHitIds`) also renders an outline, a warning dot, and a short inline label — copy that never implies the content was read, only that files like it commonly hold secrets — and while any chip warns, the row renders one notice line beneath it naming the first matched file with its own remove control. The owner decides mounting and renders the row only while file drafts exist.

## Message images and the lightbox

`MessageImage` renders one durable history image, loading a session-authorized URL through the owner's `ImageLoader`; a failed load renders an explicit retry control, and a settled load answers a single click by opening `ImageLightbox` (clicks during loading are ignored). Sizing follows DeepSeek Chat: a message's lone image (`variant="single"`) renders at 240px on its longer edge with the displayed aspect ratio clamped to [0.25, 4] — the overflow is cropped by `object-fit: cover`, anchored to the top of very tall images and the left of very wide ones — and never upscales past its natural size; an image among several (`variant="tile"`) is a fixed 64px square. `ImageGallery` wraps a message's images in one aligned wrapping flex group (`end` for user messages, `start` for assistant messages), picks the variant from the image count, and renders nothing for an empty list. `ImageLightbox` is a document-level modal preview over the shared dialog mask (`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`, painted on its own layer so the blur never touches the previewed image) that closes on Escape, a mask press, or its close control, and restores focus to its opener on unmount.

## Drop overlay

`DropOverlay` is the full-viewport invitation shown while a file drag is over the page: illustration, title, and a limits line while drops are accepted (`disabled` swaps the blocked illustration and hides the limits line). The layer is pointer-inert — the owner's document-level drag listeners keep the enter/leave count and decide accept/reject; the overlay only shows state. It portals to the body like the lightbox.

## Model Experience

None, as the plugin only renders attachment state supplied by the conversation UI and contributes no model-visible input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No sent-file history renderer yet** — `MessageImage`/`ImageGallery` render a sent image through `conversation.message.images`; a sent file's card and inline expand/collapse viewer live directly on the conversation message bubble instead of a slot this package fills, and are not yet implemented.
- **No zoom or download in the lightbox** — the preview renders the original at fit-to-viewport size only.
- **The lightbox does not trap focus** — it sets `aria-modal` and restores focus on close, but Tab can reach the page behind it.
