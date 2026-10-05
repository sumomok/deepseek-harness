# Agent Note: Console page-read and chart-report routes answer a post only for the member whose call it names

Status: implemented

English | [中文](2026-10-05-console-bare-routes-answer-only-the-call-owner.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-content-frame` answers its page channel on three bare webserver routes — `/content-frame/claim`, `/content-frame/report`, and `/content-frame/image` — and `@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc` takes render verdicts on `/show-chart/report`. They are registered through `webServer.register`, so no `connection` hook sees them, and each identifies the call it acts on by the tool execution's `callId` (with a `tabId` on the page channel) after checking only same-site and the JSON content type. In one console process serving several members, a console that knows another member's call id can claim that member's `content_read` or `content_act`, answer it with a listing of its own, store a picture into it, or settle that member's `show_chart` with a forged verdict. The call id reaches only the projection stream of the session it belongs to, but per-member session access is a separate check, and a call id that leaves that stream — an exported log, a shared screen, a provider that numbers its calls — must not be enough to act on another member's turn.

## Decision

**Each row takes a `perMember` Config field, false by default and not volatile.** False keeps every route as it was: every post answers every call, for a process that serves one person.

**With `perMember`, a route places the sender before it reads the body.** It reads `ctx.get('consoleMembers')` at the moment of the request, answers 503 while no member directory is running, and answers 401 when `principalOfRequest` places the request with nobody. The refusal text names the package, the route, and the missing piece — `<package>: the <route> needs the consoleMembers service, which is not running` and `<package>: the <route> could not tell which member sent this request` — and no value the request carried. These fences run after the method, same-site, and JSON fences, as auth-gate's token route does.

**After reading the body, the route checks the call against the sender's own sessions.** `PendingCalls.sessionOf(callId)` and `PendingCharts.sessionOf(callId)` answer the session the call was opened against, carried from `exec.agent.session.header.id` as a `SessionId`; content-frame's table of recently settled call ids records each one's session too. The route then compares `principalOfSession(thatSession)` with the sender's member; a child session belongs to whoever its parent belongs to, which is the member directory's rule.

**A post for another member's call is answered as a post for an unknown call.** A call whose session belongs to another member, to nobody, or — for `show_chart` — a call made outside any agent gets the answer an unknown call id gets, with the same status and bytes: `{"claimed":false,"reason":"unknown"}` from the claim route and `{"accepted":false}` from the report routes. content-frame answers both cases from one shared value and show-chart from one expression, so the two cases cannot drift apart. The picture route checks before it takes the call's settlement, so a post for another member's call stores nothing. The sender's own settled call still reads `settled`, and another member's reads `unknown`.

**Once the Loader tree settles, a mismatch is logged.** A `perMember` row with no member directory running, and a row without `perMember` beside a running directory, each log one error line, because the second one silently answers every member's post for every session.

The 503 and 401 checks are written in each package. `pnpm run duplication` reports no clone for them, so they are not extracted into a shared package.

This extends the rule of the [member directory note](2026-10-05-console-members-hold-customer-tokens.md) that a fork route obtains the member of a request through `principalOfRequest` and nothing else: these routes also check the call they name against `principalOfSession`.

## Alternatives considered

**Answer 403 for another member's call.** A distinct status or text tells a probing console that the call id is live and belongs to somebody else, which makes the route an oracle over other members' turns. Answering as an unknown call adds no status and no text, and the seat already handles `unknown`.

**Move the routes under `connection.fetch.register`.** The fetch routes sit under `/api` and the P2 route table judges them by path, so the per-call ownership check would still be needed: the table knows the route, not whose session a call id names. Moving them would also change the paths the browser halves post to and the deployment proxies forward. The routes stay where they are and place their sender through `principalOfRequest`.

**Remember only the call ids of settled calls, without their sessions.** The table would then have to answer every settled id the same way for every sender: `settled` to all of them tells another member that a call existed, and `unknown` to all of them makes the owner's own console bid again for a call that already ended. Keeping the session beside each remembered id keeps the owner's answer unchanged.

**Extract the placement into `@deepseek-ai/dsh-experimental-content-surface`.** Both packages already depend on it, but the extraction would give it a `console-members` dependency for two short functions the duplication gate does not flag.

**Fall back to answering every post while the directory is missing.** A misconfigured per-member process would then let any console answer any session's call, which is the failure this closes; the routes answer 503 instead, as auth-gate's token route does.

## Consequences

In a console with `perMember` set on both rows, another member's console can neither claim, report on, store a picture into, nor settle a chart call of a member's session or of that session's children, and nothing it is answered tells it whether such a call exists. The seat bids again on `unknown`, but only for a call on the pending list of a session it shows, so turning another member's `settled` into `unknown` changes the bidding only of a console that lists that call.

A call nobody owns is answered by no console: a `content_read` or `content_act` in a session whose working directory lies under no registered root ends on its claim window, and a `show_chart` call made outside any agent, or in such a session, answers unverified.

Both rows import the directory's types from `@deepseek-ai/dsh-experimental-console-members`, whose `Context.consoleMembers` merge is what `ctx.get('consoleMembers')` reads, and `@deepseek-ai/cordis-plugin-loader` for the settled-composition check. No shipped profile sets `perMember`, so no recorded-session snapshot covers it. `packages/experimental/content-frame/tests/content-read-members.client.spec.ts` and `packages/experimental/vue2-echarts-tool-poc/tests/show-chart-members.client.spec.ts` boot each row through the Loader with a test-only member directory and cover the 401 and 503 answers before the body is read, another member's call answered as an unknown one, child sessions, sessions nobody owns, both log lines, and disposal; `packages/experimental/component-kit/tests/abilities-members.client.spec.ts` covers the ability route under auth-gate's per-member resolver.
