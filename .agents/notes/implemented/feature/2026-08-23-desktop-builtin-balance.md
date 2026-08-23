# Agent Note: The desktop ships the account balance and what it spent

Status: implemented

English | [中文](2026-08-23-desktop-builtin-balance.zh.md)

## Problem

The GUI says nothing about money. An agent running against a metered API spends the user's balance every turn, and the only way to see what is left, or what a conversation cost, is to open the provider's console in a browser and read it there. On a client whose whole argument is that it needs no terminal, "go and check the website" is the same failure as "run `dsh plugin add`", and it is worse for spend than for balance: the provider's console reports one account total, not what this installation did, and never what the conversation on screen cost.

The harness already has the numbers. Every `assistant/message` session event carries the provider route id, the model id, a timestamp, and a `TokenUsage` record, so the cost of a turn is arithmetic over data the session log already holds. What was missing is something that does the arithmetic and puts the answer where the user is looking.

## Why not the community plugin

`dsh-cost-meter` is the registry's leading answer for this and was audited before anything was written. Five findings, any one of which is disqualifying for a package shipped inside an installer.

**Unauthenticated mutating RPC with `{{ENV}}` templating.** Its configuration accepts request templates that expand environment variables, and the RPC that writes those templates requires no authentication, so any caller that reaches the server can point a template at a host it controls and have the process post its own environment there — credential exfiltration by anything on the LAN.

**It reads other applications' credential files.** Key discovery walks known config paths of unrelated tools rather than asking the host for a credential, so it holds keys the user never gave it.

**It writes API keys to disk in plaintext at mode `0644`.** Every account on the machine can read them.

**It exposes no `Config`.** None of the above can be turned off, narrowed, or pointed elsewhere from `cordis.yml`, so a deployment cannot ship it in a state its own audit would accept.

**Thirty-five publishes in five days.** An audit of one version says nothing about the next, and there is no released build the findings could be said to be fixed in.

## Decision

`@sumomok/dsh-balance` 0.1.0 was written for this deployment and is the eighth built-in.

**What the user sees.** A chip beside Settings at the sidebar foot (`sidebar.footer.action`) carries the remaining balance in the account's own currency, tinted by two configured thresholds and by the provider's own `isAvailable` flag, because an account can be suspended with money in it. Hovering it opens a popover with the total, granted, and topped-up balance, when it was read, and today / this month / all time spend with the share each price tier took. A line under the composer (`conversation.composer.dock`) shows what the open conversation has cost, plus a count of tokens the price table did not price. A read that resolves no key, or an endpoint the plugin may not talk to, is the `unconfigured` state and renders **nothing at all** — a deployment that never wanted this feature gets the sidebar it had, not a placeholder explaining a failure.

**Two different kinds of number, and the plugin never confuses them.** The balance is the provider's own figure, read from its account endpoint. The spend is the harness's own logged token usage multiplied by a price table this deployment owns, so a model the table does not price is reported as unpriced tokens rather than as zero. Nothing is scraped at run time and no pricing page is fetched.

**The price schema carries no vendor's vocabulary.** One list per currency, because a provider that bills in two currencies publishes two price lists rather than one list and an exchange rate, and a CNY balance beside a USD spend total is two numbers nobody can compare. An entry states base rates per token unit and an ordered list of named schedules; each schedule claims wall-clock windows in the entry's own IANA timezone and either restates the rates or scales the base by a multiplier, first match wins. The shipped default carries both lists DeepSeek publishes, transcribed on 2026-08-23, with `asOf` shown in the popover beside the currency; keeping them current is the deployment's job.

**The ledger holds numbers and nothing else.** `$DSH_HOME/dsh-balance/ledger.jsonl`, directory `0o700` and file `0o600`, one JSON object per LLM request: the time, the session id and log sequence number, the model and provider ids, the five token buckets, the cost, the currency it was priced in, and the tier that applied. No prompts, no completions, no keys, no endpoints. Rows older than `ledgerDays` are dropped at startup and the file rewritten.

**It is the first built-in with a host half that does work.** The package has three faces: `.` for the host plugin, `./client` for the browser half, and `./typert` for the wire manifest. `@deepseek-ai/dsh-typert-loader` discovers the third one on its own — when a loader entry mounts it resolves that entry's `package.json`, reads `exports['./typert']`, imports it, and registers the `TYPERT` manifest into `ctx.typert`, withdrawing it on unmount — so a third-party Remote needs no allowlist and no change in this repository. The loader is mounted by `@deepseek-ai/dsh-base`'s patch layer, which the `desktop` profile composes below every built-in.

**Its runtime dependency survives the payload collapse.** `zod` is a real dependency of the host and Typert faces, not a peer, and `scripts/bundle-closure.ts` deletes every third-party package nothing reachable imports. It is kept because the reachability walk starts from the profile bundles as well as from `@deepseek-ai/*`: the package declares `dsh.bundle`, so it is kept whole and joins the `external` set, and the walk then finds `from "zod"` in its shipped files and keeps `zod` with it. Replaying the walk's own `specifierFor` against the installed tree confirms it, and the range is the `^4.4.3` every workspace package already uses, so the payload carries one copy. Nothing it needs is lost to the copy filter either: `PRUNE_SUFFIXES` drops `.map` and `.ts`, and all five of its `exports` targets — `lib/index.js`, `lib/client.js`, `lib/typert.js`, `cordis.patch.yml`, `package.json` — are on the other side of that filter.

**Seed order.** The name is appended after the two conversation plugins and before `@haoran/dsh-default-model`, which stays the last bundle layer on a fresh profile. Nothing depends on the order: this layer inserts one row with its own id and patches no entry any other layer sets.

## Security posture

The plugin is the shape the audited one was not.

**One read-only service.** The Typert gateway exposes exactly two methods, `accountBalance/get` and `accountBalance/spend`. There is no mutator of any kind: the price table, the thresholds, and the polling windows change only through `cordis.yml`. A caller admitted to `/api` behind a reverse proxy can read numbers and change nothing, and learns no key, no endpoint, and no prompt.

**The key is never held.** It is resolved through the host credential seam once per read and dropped when the request completes, which is also what makes a rotated key reach the next poll without a restart. It travels as an `Authorization: Bearer` header — never in a URL, never logged, never returned to the browser, never written to the ledger. What the host caches is the balance, not the key.

**Egress is one origin.** The endpoint is derived from the provider's own `baseURL` by stripping one trailing `/v<digits>` and appending the account path; a base URL that is not `http(s)`, or any derivation that would leave that origin, is refused and reported as `unconfigured` rather than fetched. There is no telemetry and no update check.

**No routes and no session events.** The plugin registers no HTTP route; the browser half reaches the host through the harness's own `/api` Typert gateway and inherits its trust fence. It appends nothing to any session log, so uninstalling it cannot make a session unreadable.

## What an existing installation sees

The seed appends one name to `dsh.profile.bundles` and links the package into `$DSH_HOME/profiles/node_modules`, and does nothing else; the profile's own patch layer, dependencies, and every other manifest field are untouched.

Aggregates count from the first row this installation writes, and the popover says so. Sessions that existed before the plugin was installed, and sessions resumed from disk — whose seeded history is not republished on the event feed — do not appear in the day, month, or all-time totals. The per-session line is unaffected, because it is a projection over each session's own durable log, so opening a months-old conversation prices its whole history at the current table.

## Alternatives considered

**Ship `dsh-cost-meter` as the built-in.** It exists, it is maintained, and it would have cost one dependency line. Rejected on the audit above: shipping it inside an installer would put an unauthenticated exfiltration path on every desktop machine, and there is no configuration that closes it.

**Balance only, no spend.** The smaller plugin, and the one that needs no price table, no ledger, and no retention policy — the balance is a single number the provider already computes. Superseded by the product owner's request: the question a user actually asks is what a conversation cost, and a balance alone answers it only by subtraction between two glances.

**Wrap `llm/stream` instead of observing `session/event`.** The waterfall sees every request and would need no durable identity of its own. Rejected because it puts this plugin inside the request path, where a bug in a cost meter can fail a turn. The `session/event` subscription is post-commit and fire-and-forget, so nothing it does can fail a turn, and each record already carries the model, the provider, the usage, and a durable `(session, seq)` identity to write down — which the waterfall does not offer.

## Consequences

Every desktop install now makes one request per minute to the provider's account endpoint while a window is open, on the same credentials as the session. The answer is cached for `refreshMs` and shared by every tab, a failed read is suppressed for `retryMs`, concurrent callers share one in-flight request, and the browser skips the poll entirely while the tab is hidden.

The shipped price table is a transcription with a date on it, and it goes stale the day DeepSeek changes a rate. The symptom is quiet — spend totals drift rather than fail — so `asOf` is on screen beside the currency, and updating the table means shipping a desktop build like every other built-in. A model missing from the table is reported as unpriced tokens, which is the visible form of the same staleness.

Editing a price list, or switching to another currency's list, changes the per-session projection's cache version, so every session is re-priced on next read rather than continuing to add to totals computed at the old rates. The ledger's own rows keep the currency and tier they were written with, and aggregates are kept per currency, so a deployment that switches lists sees the new currency start from zero rather than inheriting a total in the old one.

The plugin owns a file under `$DSH_HOME` that no other part of the harness knows about. `dsh plugin remove` drops the dependency and the layer and leaves the ledger where it is; deleting `$DSH_HOME/dsh-balance/` is the user's move.
