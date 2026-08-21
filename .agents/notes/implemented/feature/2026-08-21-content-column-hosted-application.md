# Agent Note: A self-hosted web application in the shell's content column

Status: implemented

English | [中文](2026-08-21-content-column-hosted-application.zh.md)

## Problem

[`dsh-experimental-server-layout`](../../../../packages/experimental/server-layout/README.md) opened a `content` slot — a resident work surface between the session list and the chat column — and shipped it empty. The service-line product needs that column to show an application the deployment writes and deploys itself, next to a live agent session, without that application becoming part of the harness build.

Nothing in the harness serves an arbitrary directory. `dsh-host-frontend-static` owns the webserver fallback seat and answers every miss with the dsh SPA index at HTTP 200 — the opposite of what a hosted application needs, where a broken asset path must be visible as a 404.

## Decision

`@deepseek-ai/dsh-experimental-content-frame` is a dual-face package defined against one path, `/content-app`. The node half validates `root` and claims that path as a named webserver prefix route; the browser half registers an iframe over `/content-app/` into the `content` slot. Both halves import the constant from the package's own `src/route.ts`, so the two cannot drift.

`root` is a required `Config` field with no default — an absolute path to an existing directory, `realpath`-resolved once at load, and a relative, missing, or non-directory value fails the row at load. The route answers GET/HEAD only (405 with `Allow` otherwise), resolves a directory to its `index.html`, rejects a lexical or symlink escape with 403, answers a miss with a loud 404 rather than delegating to the fallback, carries a content-type table covering fonts and raster images, and sets `cache-control: no-cache`.

### The trust posture is same-origin, and it is the point

The iframe carries no `sandbox` attribute, so the hosted document is same-origin with the shell and reaches the dsh HTTP API with the shell's own authority. A first-party application in this column is expected to talk to the harness, and an opaque origin cannot: [the API request-trust check](../../../../packages/client/connection/src/api-request-trust.ts) rejects `null` origins, so `sandbox` without `allow-same-origin` would leave the frame unable to do anything while `sandbox` with it removes nothing. The package therefore states the boundary instead of pretending to enforce one: `root` must name a directory trusted as much as the harness. Untrusted content — agent-generated pages, third-party bundles — needs a separate sandboxed plugin, not a flag here.

### `session-maybe` occupants live by adoption

The column's lifetime is not this package's choice; it is `SessionMaybeEntry` in `dsh-client-ui-renderer`. The incarnation a page boots into adopts the first session that arrives — identity holds across that one transition — and every session change after it is a fresh incarnation. For an iframe that means the hosted application survives the user's first click and reloads on every session switch afterward, losing whatever state its page held. Anything that must survive belongs on the application's own side. A column that outlived sessions would need a `root`-scoped seat, which is the shell's declaration to change.

This corrects `server-layout`'s README, which claimed the occupant keeps its React identity across a session switch; the e2e pins the real rule in both directions.

## Alternatives considered

**Serve the directory through the existing `dsh-host-frontend-static` fallback seat.** Rejected because that seat has one owner and it is the dsh SPA, and because its semantics are wrong here: a miss becomes the shell at HTTP 200, and its seven-entry content-type table ships fonts and icons as `application/octet-stream`, which a browser silently drops.

**Sandbox the iframe and let the application ask the shell for what it needs over `postMessage`.** Rejected for the first version: it inverts the cost — a bridge has to be designed, versioned, and kept in step with the API for content the deployment already trusts — and `allow-same-origin` would make the sandbox decorative anyway. The sandboxed profile stays a named non-goal, to be a different plugin when untrusted content is real.

**Configure the URL in the browser half instead of deriving it from the route.** Rejected because the two halves must agree on one path and nothing outside the package addresses it; a second configuration point could only ever be wrong.

**Read `root` from the shell's workspace or infer it from the profile directory.** Rejected because the trust the route grants that directory makes an inferred location the wrong kind of convenience: which directory carries the shell's authority must be written down.

**Give the frame a fixed pixel height or absolute positioning.** Rejected because the shell solves the column's track width itself; the frame grows into it as a flex child, so a resize needs no coordination between the two packages.

## Consequences

The content column shows a real application beside a live session, and a deployment changes what it shows by editing one directory and one `cordis.yml` value. The dsh origin now serves bytes the harness did not build, under a documented trust boundary rather than an enforced one.

The hosted application reloads on every session switch after the first, which is the framework rule, not a package bug. There is no page switcher, no `postMessage` channel, and no agent-facing surface — what the column shows is not model-visible and not reconstructable from a session log; the second step is where a control channel belongs.

`overlay/content-column.patch.yml` composes the shell and this package together and reads `root` from `DSH_CONTENT_APP_ROOT`, so one file serves any application and the e2e serves its fixture through the shipped overlay.

## Testing

`tests/content-app-route.client.spec.ts` boots a test-only `cordis.yml` through the vendored Loader with the real webserver and asserts over HTTP: entry-document resolution for the bare prefix and for a subdirectory, the content types, the percent-escaped name, HEAD, the loud 404 against a live fallback that answers elsewhere, traversal and symlink-escape 403, 405 with `Allow`, and route release on fiber disposal. `browser-plugin.client.spec.ts` covers the slot wait, the registration and its injected URL, teardown removal, and the dictionaries; `content-frame.client.spec.tsx` pins the rendered `src`, the locale title, and the absent `sandbox` attribute.

`apps/web/tests/content-frame.e2e.ts` runs the shipped overlay against the real composition: the frame's geometry inside the content track, the hosted document and its own stylesheet (the browser's verdict on the route's content types), the adoption-then-remount rule across a switch and a new session, and a clean console.
