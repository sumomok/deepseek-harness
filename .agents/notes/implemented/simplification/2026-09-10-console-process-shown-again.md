# Agent Note: the console's conversation column shows the process again

Status: implemented

English | [中文](2026-09-10-console-process-shown-again.zh.md)

## Problem

The console hid every process row in its conversation column, re-texted the running-turn indicator, and swapped the composer's placeholder copy — [the 2026-09-07 decision](../feature/2026-09-07-console-business-content-only.md), carried entirely by CSS rules in `packages/experimental/server-sidebar/src/client/terminology-guard.ts`.

The product owner reversed it on 2026-09-10, on both halves at once: the process is to come back exactly as it was, and the restyled composer and indicator are wrong for the product ("样式有问题，还是用以前的就行" — the styling is broken, keep what was there before). A column carrying only the question and the answer leaves a visitor nothing to read about what the run did, and each `::after` swap changed the composer's and the indicator's own layout along with their words.

## Decision

`terminology-guard.ts` and `tests/terminology-guard.client.spec.ts` are back at their pre-2026-09-07 content, byte for byte, and the package README pair drops the Business content only section that documented the removed rules. The stylesheet's `STYLE` constant now carries the de-terminology rules and nothing else.

The console renders again exactly what `dsh-client-ui-chat` and `dsh-client-ui-conversation` draw: tool-call rows, `content_read`'s own result card among them; thinking disclosures; the 系统提示词 panel; command cards under all three kinds (`command`, `manual-compaction`, `compaction`); the completed-turn fold row; the `context`, `model-retry`, `command-input`, `workflow-run` and `unknown` rows; the reply footer's 用量 and 用时 pills; the running indicator with its own 深度求索中... copy and its DeepSeek-token gradient; and the upstream placeholder for every state of `InputBar.tsx`'s ladder, including 会话不可用 and the hero copy.

What stays hidden is [decision ②'s list](../architecture/2026-08-30-server-sidebar-product-console-retrofit.md), which this change does not touch: the turns/steps stats row seated after the composer card, the hero fish-mark hitbox, the PREVIEW badge, the hero headline's painted copy, the hero workspace-chip row, and the composer's permission-preset chip.

The 2026-09-07 note stays where it is, as the record of what those rules hid, which coupling each one took, and what the alternatives cost; this note supersedes it.

## Alternatives considered

**Keep the process hidden and restyle only the composer and the indicator.** The reversal names the process first ("之前是不是让你把所有的过程都隐藏了？还原回来吧") and the styling second, so a change limited to the two re-texted surfaces would leave hidden the rows the owner asked to have back.

**Hand-edit the stylesheet down to the decision-② rules.** Reverting the four commits restores the rules, the module doc that explains each coupling, and the unit spec together, and the result is verifiable as an empty diff against the pre-decision tree. An edit would have to reproduce all three by hand, and prose describing the reversed decision would survive unnoticed.

**Put the rules behind a `Config` field so a deployment can choose.** No deployment asks for the hidden column, and the field would keep every one of those DOM couplings — a real attribute for the kind rules, a CSS-module class substring for the footer, the indicator and the placeholder — alive and maintained against upstream renames for a value nobody selects.

**Delete the 2026-09-07 note.** [The Agent Note rules](../../README.md#when-to-write-one) permit deleting a superseded note only by consolidating every rationale it holds into the owning note. Its couplings, its four rejected alternatives, and its accessibility findings are the material a future attempt at the same product goal would need, and this note does not restate them.

## Consequences

- Nothing model-visible changed, in either direction. This is browser CSS in a client plugin: no system prompt, tool schema, session event, or model request moved, so `pnpm run test:snapshot snapshots/console` needs no update for the same reason the 2026-09-07 note gave, and the web lane's aria goldens are unaffected because every golden-bearing spec runs under a composition that never inserts `server-sidebar`.
- The console shows an end customer the harness's full developer transcript again, the system prompt panel and every tool row included. That is the state this package shipped in before 2026-09-07 and the state the product owner asked for; a deployment that wants a quieter column has this note's history and the superseded note's couplings to start from.
- The package's two whole-page banned-word screens (`workspaceWordsInChat` and the landing-page `body.innerText()` scan in `apps/web/tests/server-sidebar.e2e.ts`) regain the reach the hides had taken from them: `display: none` kept a row out of rendered text, so banned vocabulary inside one passed both screens unread.

## Deferred

`apps/web/tests/server-sidebar.e2e.ts` still carries the browser scenarios written for the reversed decision — the seeded closed turn, the per-kind `display: none` assertions, the footer-pill reads, the placeholder `::after` reads, the indicator read, and the `expectGuardHidesSelector` helper they share. They assert hides this change removes, so that describe fails until it is removed with them; the unit spec, which is reverted here, is what pins the rules that remain.
