# Agent Note: server-sidebar — naming the signed-in person in the footer, and the one control that undoes it

Status: implemented

English | [中文](2026-09-04-server-sidebar-identity-and-sign-out.zh.md)

## Problem

[`@deepseek-ai/dsh-experimental-auth-gate`](2026-09-04-auth-gate-bearer-scheme-and-sign-out-route.md) carries a visitor's access token to the two places dsh needs it, and leaves for the login page whenever that token is gone or expired. What it has no surface for is a person deciding to leave: the product console's footer showed a grey circle and the literal word "用户", and nothing anywhere signed a visitor out on purpose. On a shared machine that is the whole gap — the only way to stop being the signed-in person was to close the tab and hope the token expired.

Two further constraints shaped the answer rather than the problem.

- The sidebar must also work in a composition that never composes auth-gate. It is the product console's load-bearing shell; a footer that could not read a name, or a button with no login page to return to, must not take it down.
- Everything here is a person's identity. None of it may become model-visible: not the name, not the token it is decoded from, not a session event recording either.

## Decision

**The name is a display copy, decoded in the browser from an unverified token, and authority for nothing.** `client/identity.ts` reads `localStorage.accessToken`, drops the login page's `Bearer` scheme, decodes the payload without checking a signature, and takes the claim `Config.displayNameClaim` names. Verifying it here would be checking claims we were handed against a key we were handed; the party that can verify is the reverse proxy in front of this process, which has already routed the request by that token. What a forged token buys is therefore a wrong name in a footer — no surface is gated on the value, and it reaches no request. It is also not model-visible in any sense the repo-wide rule tracks: no session event carries it, nothing appends one, and the README's Model Experience stays `None`.

**The claim name is `Config`, served over a second read-only route.** A browser half receives no cordis config — the boot manifest carries plugin names, not their `config` blocks — so `GET /server-menu/identity` answers `{ displayNameClaim }` the way auth-gate's own settings route answers its three values. The field is required and rejected blank at load, because the failure it prevents is silent: a deployment whose claim name is wrong shows every signed-in person as anonymous with nothing on the page or in the log to say why. The route needs only `ctx.webServer`, not `ctx.settings`: naming the signed-in person is not durable state, and a composition without the settings capability still gets a footer.

**The six agreements with auth-gate are literal copies, not imports.** The `Bearer` strip, the JWT payload decode, `/auth-gate/settings`, `/auth-gate/logout`, the removal cookie line, and the rule that strips the login page's credential parameters out of a return address are written out again in this package. A cross-package value import is not this repository's sanctioned way to couple two client-adjacent plugins (`packages/client/AGENTS.md`'s export-discipline section), and this package already holds one such copy for the same reason — `client/pages.ts` copies content-frame's settings route rather than importing it. Inventing a shared seam instead (a third package, or a `ctx` service one plugin registers and the other consumes) would make auth-gate a hard dependency of the sidebar in every composition, including the ones that gate nothing, to save six short literals that two fork-owned packages change together anyway. The copies are named as copies at each site and in both READMEs, which is what keeps them findable when auth-gate moves. Two of them are addressed rather than merely spelled: both routes are requested through `clientUrl`, and the removal line carries the deployment prefix auth-gate wrote the mirror under, each package resolving that prefix from the same page fact.

**Signing out runs five steps in one fixed order, and every step runs whatever the one before it did.** Stop the work in progress; `POST /auth-gate/logout`; remove the login page's stored keys; clear the mirror cookie; navigate to the login page. The order is the argument:

- Stopping first is the only step whose subject is still alive. A turn left running goes on spending the deployment's credentials as a person who has just left, and every later step makes it harder to reach — the token it runs on is dropped two steps later.
- Stopping first is also the only step given a deadline. The four steps after it are what actually drop the token, and they run on this browser alone; the stop is the one step that waits on a host, so it waits for three seconds and no longer. Leaving it unbounded would let a single cancel that never answers — a disconnected socket, a host wedged mid-turn — hold the visitor on the page with their token still in storage, which is the outcome the whole sequence exists to prevent.
- The token goes before the cookie, because the sign-out request is routed to this process by that very cookie; a browser attaches cookies when a fetch is initiated, which is what makes the order hold (the same reasoning auth-gate's `leaveForLogin` records).
- The sign-out request is sent, not waited on. `keepalive` is what carries it across the navigation, and it is also what makes waiting on it both pointless and harmful: a route held open until a proxy's read timeout would strand the visitor on a page whose turn is already stopped, with the token still in storage and nothing on screen to say why.
- Storage and cookie both go before the navigation, because a page that has left cannot clear anything.
- A refusal at any step is a `console.warn` and no more, and each of the three leaving steps carries its own guard for that reason: a browser told to block this origin's site data throws from a storage removal and from a cookie write, and neither may cost the visitor the navigation. The visitor is leaving; a step that could not run is not a reason to abandon the rest.

**Storage is cleared by an enumerated key list, never `localStorage.clear()`.** The keys are the login page's own — token, its clock, its encryption flag, its renewal clock, two profile copies, an application-permission table, the alternate credential it accepts in a query parameter, and each in the `…Auth` spelling that page also writes. A blanket clear would take the shell's private keys with them, and in a deployment that serves other applications from the same origin, theirs — signing the visitor out of things this button never promised to touch. Enumerating costs a list that has to keep step with the login page; the failure that list produces is a leftover key, while the failure a blanket clear produces is somebody else's session.

**The stop sweep asks the session list who is running, and always stops the open conversation.** `SessionSummary.running` is the host-pushed bit tied to actual execution, so it is the judgement for every conversation the visitor is not looking at. The open one is stopped whether or not it carries that bit: an idle stop is a no-op the host answers, while trusting a pushed bit for the one conversation on screen would make signing out depend on a frame arriving first. Each stop goes through the same session-scoped `conversation.cancel()` the shipped stop button calls, resolved by a copy of `dsh-client-ui-conversation`'s own `scopedConversation` (that package exports no such helper).

**Nothing is told to the deployment's own sign-on.** This package knows no revocation endpoint, and the token stays valid on the issuer's side until it expires — recorded as a Known Limitation rather than left implicit, with the one place a deployment that has such an endpoint would call it (step 2).

**The reactive name goes through the inject `hooks` compartment.** The footer's name changes when another tab writes the token, so it is a registrant-private reactive fact; `packages/client/AGENTS.md` gives exactly one channel for that, and it is not `useState` over a storage subscription inside the component. `createDisplayNameSource` is a bare `HostObservable`, the renderer binds it to `useDisplayName`, and the component contains no subscription machinery. The source keeps no copy of the name either: `getSnapshot` re-reads storage and every storage change notifies every subscriber. A copy needs a refresh path, the only refresh path is a subscription, and that leaves the name stale for as long as nothing is subscribed — before the first mount, and between an unmount and the next — while letting whichever subscriber the refresh runs under swallow the notification the others were owed. The name is a string, which `useSyncExternalStore` compares by value, so re-reading costs a render only when the name has actually moved.

## Alternatives considered

**A shared identity service both plugins consume.** Rejected: it makes auth-gate a hard dependency of the console shell, and the shell's own composition (`overlay/sidebar-menu.patch.yml`) deliberately does not compose it. The seam would also carry a credential across a package boundary for no reader other than a footer.

**Show `sub`, or whatever claim looks name-like, instead of a configured claim.** Rejected: `sub` is a subject id, not a name, and a heuristic over claim names would be a guess this package cannot fail loud about. One required `Config` field states the deployment's answer once, at load.

**`localStorage.clear()`.** Rejected above: it signs the visitor out of every application on the origin, including this shell's own remembered state.

**Ask for confirmation first.** Rejected for this slice: `cancel` preserves the conversation and its pending inbox work, so a mis-click costs a login round trip and nothing durable. Recorded as a Known Limitation so a product decision to add one has the current behavior stated.

**Reuse auth-gate's own `leaveForLogin` by having the sidebar remove the token and let that package's storage watch do the rest.** Rejected: it would work only in a composition that composes auth-gate, it would make the sequence depend on a `storage` event this tab does not receive for its own writes, and the steps that matter most on a deliberate sign-out — stopping the work in progress, removing the login page's other keys — are not that function's job.

**Cancel only the current conversation.** Rejected: the console creates sessions on the visitor's behalf (the workbench, every workflow), so "the one I am looking at" is not the set of turns running as this person. Sweeping the list is one snapshot read and one extra `cancel` per running conversation.

**Put the name in the sidebar's existing workflow store.** Rejected: the store carries the server-menu document, and every existing assertion over its snapshot would have to grow a field that has nothing to do with workflows. The hooks compartment is the channel the client rules already name for a registrant-private reactive fact.

## Consequences

`@deepseek-ai/dsh-experimental-server-sidebar` now takes a required `Config`, so every composition that inserts it names `displayNameClaim`: both package overlays, both `apps/web` scenario overlays, and the two test compositions in `workflow-route.client.spec.ts`. A row composed without it fails at load, which is the intended reading of "misconfiguration fails loud" for a field with no defensible default.

The button has no browser-level evidence. This package's Playwright scenario composes no auth-gate row — that package gates the whole page on a token, which every other assertion in the scenario would then have to carry — so the sequence is proved by unit coverage over the injected `SignOutBrowser` and the real session tree's cancel face instead, and the gap is stated in the README.

The footer is now the second surface in this composition that reads a claim out of the deployment's token. If a third appears, the copy count in `client/identity.ts` is the thing to consolidate — at that point the case for a seam is about three readers rather than about coupling two packages that already ship together.
