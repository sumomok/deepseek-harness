# Agent Note: repair a build-purity gap and stale assembled-snapshot copy from the composer file-intake commit

Status: implemented

English | [中文](2026-08-28-file-attachment-build-purity-and-stale-copy.zh.md)

## Problem

Verifying the bubble/referent-seam commit end to end (over the real built client graph, per `docs/testing.md`'s assembled-snapshot requirement) required a full `pnpm run build`, which the composer-intake commit's own checks — `tsc -b`, oxlint, jscpd, package-scoped vitest, `pnpm run doc-sync` — never exercise: none of them run the tsdown bundler's cross-plugin purity gate or the built `apps/web` snapshot suite. `pnpm run build` failed outright: `packages/client/ui-attachment/src/client/ComposerAttachments.tsx` value-imports `attachmentSizeText`/`partitionDroppedFiles` from `@deepseek-ai/dsh-client-ui-conversation/client` without the package declaring that specifier in `dsh.client.external`, so the bundler's purity gate (`packages/client/tsdown.client.ts`) rejected the import as an undeclared cross-plugin value import — a defect present since that commit, undetected because no full build had run since. Once fixed, running the existing `apps/web/tests/image-display.snapshot.ts` suite against the real build surfaced two further gaps from the same commit: its overlay-copy assertions still expected the pre-existing image-only text (`'Drag images here to add them'`, `'Up to 20 images, 5MB each'`) after that commit changed the shipped copy to mention text files, and its "unsupported paste" scenario pasted a single-byte `text/plain` file that the commit's own new content sniff now correctly routes to the file-intake path instead of the image path's rejection toast, so the scenario no longer exercised what its assertion named.

## Decision

**Declare the cross-plugin request.** `packages/client/ui-attachment/package.json`'s `dsh.client` gains `"external": ["@deepseek-ai/dsh-client-ui-conversation/client"]`, matching the specifier `ComposerAttachments.tsx` already imports verbatim (`requestedExternals` matches exact specifiers, never normalized). `ui-attachment` already declares `inject: ["@deepseek-ai/dsh-client-ui-conversation"]`, so the producer is already guaranteed loaded first; only the bundler-side allow-list entry was missing. This is the first package in the repository to use `dsh.client.external` for a real cross-plugin value import — the mechanism existed but had zero prior precedent to follow.

**Update the two stale assertions, not the scenarios' intent.** The overlay-copy test now asserts the shipped `'Drag images or text files here to add them'` / `'Up to 20 images, 5MB each; text content is sent as-is'` text. The "unsupported paste" scenario keeps testing "a paste that is neither an image nor sniffable text still shows the image-format rejection toast" — but its fixture payload changes from a text-sniffable single byte to a NUL-led binary (`Uint8Array([0, 1, 2, 3])`, `application/octet-stream`), which fails the client sniff regardless of declared MIME type and so still reaches the path the assertion actually names.

**Add the file-attachment counterpart of `image-display.snapshot.ts`.** `apps/web/tests/file-display.snapshot.ts` is new: paste a real text file into a live fixture session, send it, and confirm the bubble's `FileCard` default click resolves the exact sent text through the authorized `session.file` route (proving the fixture's session log holds a ref the prompt handler minted, never the inline text) and that a second collapse/expand does not lose the resolved text. This is the assembled-application-transcript evidence `docs/testing.md` requires for a product-user-visible behavior change (the bubble/referent-seam commit shipped without it, since `apps/web` snapshots were not run there either).

## Alternatives considered

**Leave the "unsupported paste" scenario on a text payload and change only its expected outcome to the file chip row.** Rejected: that scenario's whole purpose is covering the image-format rejection toast, which every OTHER assertion in this file never exercises; repointing it at the file path would leave the toast path with no assembled-level coverage at all instead of fixing the fixture to keep testing what it always meant to.

## Consequences

`pnpm run build` (both `tsc -b tsconfig.client.json` and the tsdown client bundle) is clean; `apps/web/tests/*.snapshot.ts` passes except `built-boot.snapshot.ts`'s official-branding assertion, which needs a `--profile` build invocation this fix does not attempt to supply (unrelated to file attachments — confirmed by reproducing it in isolation with an unbranded `pnpm run build`). `scripts/verify-client-packages.ts` and its own spec confirm the new `external` declaration is the only one in the repository and resolves cleanly. No other package was found importing a value from `dsh-client-ui-conversation/client` without either a type-only import (erased before the gate runs) or this same declaration.

## Retirement

Same retirement condition as the commit these fixes correct (`.agents/notes/implemented/feature/2026-08-28-file-attachment-composer-intake.md`): upstream's own composer generalizing to non-image attachments retires that overlay and this fix along with it.
