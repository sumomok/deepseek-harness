# Agent Note: Console members enter the Host as a signed assertion, and the sign-on gate holds one customer token per member

Status: implemented

English | [中文](2026-10-05-console-members-hold-customer-tokens.zh.md)

## Problem

The console line runs one dsh process that serves every visitor of a deployment. `@deepseek-ai/dsh-experimental-auth-gate` was written for one process per signed-in person ([browser single sign-on note](2026-08-28-browser-single-sign-on-and-mcp-token-injection.md)): its node half holds one customer token, the newest any browser posted, and every data-backend read and MCP forward spends it. In a process several people reach, the last visitor to load a page decides whose credential every session's reads spend; a check on the console deployment on 2026-09-10 showed every visitor's sessions spending the token of whoever loaded a page last. The package also promised that nothing else in the process reads the token, which a console that joins an organization cannot keep: the organization credential source has to read a member's customer token to exchange it for an organization token.

Two things were missing. The process had no trustworthy answer to which member sent a request: the dsh browser cookie is an HMAC over a fixed payload and names nobody, and every visitor of a deployment holds a valid one. And the token store had one slot.

## Decision

**A member's id enters the Host as a signed assertion, and only the member directory reads it.** The deployment's login gate verifies each visitor's token with the deployment's authentication service, removes any member header the client sent, and injects a freshly signed member assertion carrying the verified `login_uid` into every request it passes to dsh. The `consoleMembers` service of `@deepseek-ai/dsh-experimental-console-members` verifies that assertion with the deployment's public key during the connection's admission, and answers `principalOfRequest(req)` for a webserver route and `principalOfSession(sessionId)` for a session, where a child session belongs to whoever its top-level session belongs to. A route in this fork asks `principalOfRequest` and nothing else: it reads no identity header and calls no `connection.admit`.

**The sign-on gate holds one customer token per member.** With `perMember`, auth-gate's node half keeps a `Map<PrincipalKey, string>` in memory. The token route places the sender through `consoleMembers` before it reads the body — 503 while no directory is running, 401 for nobody — and holds the posted token only when its `principalClaim` claim, `login_uid` for toy-core, names that member, answering 409 otherwise. The claim is read by the signing proxy's rule, so a 19-digit numeric id is compared by its digits. The sign-out route of the [sign-out route note](2026-09-04-auth-gate-bearer-scheme-and-sign-out-route.md) drops the sender's own token. `ctx.bizBackend` resolves each read's subject through the same directory, and a subject the directory places with nobody resolves to no slot, never to another member's or to one held for the whole process. MCP forwarding is refused at load under `perMember`, because a forwarded request comes from the in-process MCP client and names no member. The default, `perMember: false`, keeps one token for the process.

**The member directory may read the tokens, by an explicit Config choice.** `shareWithMemberDirectory` lends the `consoleMembers` service a reader through its `attachCustomerCredentials`, once per start of that service. The reader reads one member's token, reports `set` and `dropped` changes, and lists nobody. The service holds one reader at a time and throws on another, and takes a new one once the previous one is released, which is what lets this row restart under a running directory; a refusal shuts the token route with 503. The reader is revoked when the service stops or the row is disposed, before the service's own release runs, so a release that throws does not keep it live, and whoever read a token through it treats every member's token as dropped. It is registered on no context, because a service on the context is readable by every plugin in the process.

This replaces two rules of the [browser single sign-on note](2026-08-28-browser-single-sign-on-and-mcp-token-injection.md) for a per-member process: that the process serves one signed-in person, and that nothing else in the process reads the token. The directory, and whatever it hands a token to — the organization credential source that exchanges it — read every member's token.

The three fields are not volatile, so no settings write reaches them; a deployment sets them in its own layer.

## Alternatives considered

**One process per member.** Each signed-in person gets a process, a home directory, and an overlay of their own, picked by the proxy from the token — the shape the single-token gate was written for. It keeps "nothing else reads the token" without any rule, but every member costs a full Host, ports and process lifecycles move into the deployment, and members share no state. The console line chose one process serving several members.

**Read the identity from a header in each route.** Every fork route would verify the assertion itself, or trust a plain header. A plain header is forgeable by anything that reaches the dsh port, and verifying in each route repeats the key and the expiry rule in every package. The directory verifies once, during the connection's admission.

**Treat the dsh browser cookie as the identity.** It is an HMAC over a fixed payload, and the deployment's proxy exchanges one launch token for a cookie on behalf of every visitor, so every visitor's cookie is valid and none names anybody.

**Register the reader as a Cordis service.** Every plugin in the process could then read every member's token, and this fork's audit found that third-party plugins declare no approval gates by default. Lending it to the one service that takes it limits the readers to that service and what it hands a token on to.

**A reader that lists the members it holds tokens for.** Listing turns "read this member's token" into "read everyone's at once", and no consumer needs it: the organization credential source asks for the member a request is for.

**Fall back to one token for the process when the directory is missing.** A misconfigured per-member process would then spend one visitor's token for everyone, which is the failure this decision closes, so a missing directory answers 503 and every read answers `unauthenticated` instead.

**Keep MCP forwarding per member.** `dsh-mcp-client` fixes its request headers when its row loads, so a forward cannot tell which member's session issued it. Carrying a member per request needs a change to that package's header mechanism; a per-member console reaches MCP servers with a service credential instead.

## Consequences

Two members of one console hold their own customer tokens at once: A's sessions, child sessions included, read the data backend as A and B's as B, a refusal by the backend drops only that member's token, and B signing out leaves A untouched. A browser that switched accounts while a post was in flight gets 409 instead of storing one member's token under another.

The trust premise moved to the deployment. Its login gate verifies the token and signs the assertion, and the signing key has to be unreadable to the dsh process's OS user; until that isolation is deployed, only the network topology in front of dsh keeps an assertion from being forged. With `shareWithMemberDirectory`, the member directory and the credential source it hands tokens to read every member's token, and the single-token gate's promise that nothing else in the process reads the token holds only with that field off.

A per-member console has no MCP forwarding, so a write an MCP tool makes — an iot write among them — is recorded under the console-mcp service account rather than under the member who asked. A per-member process with no directory running answers 503 on the token and sign-out routes; the error line that reports it is written when the Loader tree settles, because Cordis has no host-ready event.

auth-gate imports the directory's types from `@deepseek-ai/dsh-experimental-console-members`, which declares `Context.consoleMembers`. Until a plugin provides that service, a `perMember` row answers 503 on its token and sign-out routes.

No shipped profile sets `perMember`, so no recorded-session snapshot covers it. `packages/experimental/auth-gate/tests/per-member.client.spec.ts` boots the gate through the Loader with a test-only member directory row and covers both members' tokens, child sessions, the 401, 409, and 503 refusals, the reader handover and its refusal, and disposal.
