# Agent Note: a call the page seat gave up on is taken up again

Status: implemented

English | [中文](2026-09-03-content-seat-claim-restart.zh.md)

## Problem

One running console answered `content_read` and `content_act` with "No open console is showing this session's content column" 33 times in about 400 calls, with the console in front of the user throughout. One timeline out of that session log rules out every explanation but the seat's own bidding:

```
11:04:23.502  tool/call         content_act call_00_Q1rG…
11:04:23.504  approval/asked
11:05:02.385  approval/decided  allowed-once
11:05:05.397  tool/result       "No open console … (waited 3s)"
11:05:07.653  tool/call         content_read
11:05:07.941  tool/result       the page, read in 288ms
```

The user was at the console — they answered the approval — the tab was connected, the seat was alive, and the host's wait was open; that call was never bid for once, while a new call five seconds later was answered in 288ms. The host side was walked hop by hop and is clean: the projection fold held the call pending for the whole 41.9 seconds, the API proxy broadcasts to every consumer without filtering by session, the client applies projection frames whether or not the session is instantiated, and the reverse proxy logged no 4xx or 5xx at all.

The seat remembers the calls it has taken up in `started`, so no amount of re-rendering turns one call into two claims. Two paths left an id in that set for a call that was still open on the host:

- The pruning of `started` stood after the effect's own guards. A tab that is not visible — macOS Chrome reports an occluded foreground window as hidden — or a deployment with no `pageAccess` stopped pruning entirely. A pending list that blipped empty for one render then made the bidding loop give up, and the id stayed behind; when the tab came back with the call still on the list, it was skipped for good.
- `answer` returned without dropping the id whenever `claimRead` gave up — a bid the route refused, a claim another tab held, a call that left the list, the ten-minute ceiling. Every one of those leaves the call waiting on the host.

`content_act` meets both most easily: its wait is registered only after a person answers the approval, so the bidding window is as long as the user takes to decide.

## Decision

Giving up is not answering. `started` is pruned before the effect's guards, and `answer` drops the id whenever `claimRead` returns undefined. A call is remembered only while this seat is working on it; otherwise the next projection frame carrying that call is one the seat bids for again.

## Alternatives considered

**Clear `started` on a timer.** The pending list already says whether a call is open, and a clock would either re-bid for calls that have settled or sit past the host's own window — the same mistake as giving up at `claimTimeoutMs`, which an earlier fix removed.

**Bid again from inside `claimRead` rather than returning.** Its exits are different facts: a route that refused this bid would refuse the next one, and a call another tab holds is not this seat's. The effect is the half that knows whether the call is still on the list, so the retry belongs there.

**Prune only when the tab is visible, and forget on unmount instead.** A seat that unmounts loses `started` with everything else; the failure is precisely the seat that stays mounted through a hidden spell.

## Consequences

- A bid refused once, or lost while the tab was away, now costs about 200ms rather than the whole call.
- The retry is not self-triggering: dropping the id inside `answer` does not re-run the effect, so a re-bid waits for the next projection frame. Every tool call produces one, which is enough in the field; a call whose frames have stopped arriving still ends at the host's own timeout.
- What made the pending list blip empty is not pinned down. Several writers in the client runtime can do it — a projection store deleted, the current session briefly absent from the index, a summaries refresh replacing the list. It is worth its own investigation; this change bounds what one blip costs.
- **The visibility gate is still a one-sided veto, and stays one for now.** A seat claims nothing while `document.visibilityState` is `hidden`, and macOS Chrome reports an occluded foreground window as hidden — so the only console open answers nothing, and the model is told no console is showing this session, which points it at the wrong thing. The change is to make visibility a preference rather than a veto, matching the host's own `PREFERRED_TAB_WINDOW_MS` hold: an invisible seat bids after a grace window, so a visible tab always wins. It is not made here because it rewrites a documented, tested behaviour and deserves its own note. The trigger is the first "no open console" reported by a user whose console was on screen after this fix, or the first deployment where two consoles on one session make the preference decide something.

## Testing

Two cases in `packages/experimental/content-frame/tests/content-read-executor.client.spec.tsx`, both failing before this change and passing after: a call given up on while the tab was hidden and bid for again when the tab returns, and a call whose bid the route refused with 403 and which the next projection frame gets a bid for. Every existing case of the two executor suites is unchanged.
