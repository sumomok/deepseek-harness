# Agent Note: server-sidebar — the footer identity band is one row

Status: implemented

English | [中文](2026-09-10-server-sidebar-footer-one-row.zh.md)

## Problem

The console footer draws two things side by side: who is signed in, with the control that undoes it ([identity and sign-out](2026-09-04-server-sidebar-identity-and-sign-out.md)), and the `sidebar.settings` occupant, merged into one `space-between` band by [the console retrofit](2026-08-30-server-sidebar-product-console-retrofit.md). The band was allowed to wrap, and in the deployment's own window it did: the name and the sign-out label on one line, the settings trigger alone on the next. The product decision is one row — identity left, settings right — and the stylesheet's own comment already claimed that layout while the rule set did the opposite.

Wrapping was not an accident. The session column is a share of the frame (`dsh-experimental-server-layout`'s `solveTracks` gives it 3 of 24 units, so a 1568px frame yields a 196px column and 172px of content box inside this shell's padding), and the band's three fixed parts — a 24px avatar circle, the sign-out label, and a settings trigger drawing both an icon and its label — exceed that together in each of the two locales this console ships. Forcing them onto one line shrank the only flexible item, the name, to nothing, and then clipped the sign-out label against the identity cluster's `overflow: hidden`.

## Decision

**The band never wraps, and the settings seat is asked for its compact form.** `.identityRow` declares `flex-wrap: nowrap`, and the render site passes `wide: false`, for which `dsh-client-ui-settings-general` draws a 36px icon button instead of icon plus label. That is the only version of the trigger this column has room for, and with it the band fits at the narrowest frame the console runs at.

**The shrink order is declared, not left to the flex defaults.** `.avatarRow` is `flex: 1 1 auto; min-width: 0`, so the identity cluster absorbs the whole of any shortfall; inside it `.avatarName` is the only shrinkable child, so a long name truncates to its ellipsis while the sign-out label stays whole; `.settingsArea` keeps `flex: none`, so the trigger never shrinks below the icon it draws. `.avatarRow`'s `overflow: hidden` is the last resort under all of that: a column too narrow even for a zero-width name clips the identity cluster's own tail rather than pushing the trigger out of the row.

**The compact form's cost is recorded rather than absorbed.** That package renders its `ConnectionIndicator` only while `wide` is true, and the indicator is this console's only outage notice and its only reconnect button, so the sidebar now says nothing when the socket drops; the package README carries it as a Known Limitation with the one way back. The same coupling is what makes the compact form load-bearing rather than merely narrower: the indicator sits inside a `flex: none` seat, so under `nowrap` an outage would have widened that seat mid-outage and crushed the identity cluster next to it.

## Alternatives considered

**Keep `wide: true` and let one line resolve itself.** Rejected on the arithmetic above: the labeled trigger leaves the 172px content box nothing for the name in either locale and overruns the sign-out label as well, which is the outcome the e2e scenario's `scrollWidth <= clientWidth` assertion on the identity cluster exists to catch.

**Keep `wide: true` and cap `.settingsArea` with a `max-width`.** Rejected: the occupant's label carries `overflow: hidden` with no `text-overflow`, so a capped seat hard-clips the word rather than truncating it, and the same cap would clip away the connection indicator — the one control in that seat that has to stay reachable.

**Choose the form from the `width` owner prop, labeled above some pixel threshold.** Rejected: it writes a breakpoint into a plugin as a hardcoded tunable, and it makes the outage notice appear and disappear as the window is resized.

**Widen the session column.** Rejected here and recorded as the way back: `SESSION_UNITS` is contract-frozen geometry shared with every other track in `dsh-experimental-server-layout`, and one footer band is not the reason to move it.

## Consequences

The console's settings entry is a gear icon with no visible label, and the sidebar has no connection feedback. Both are stated in the package README's Known Limitations, together with the column width that would restore them.

Two tests hold the rule set. `tests/identity-row-styles.client.spec.ts` reads the stylesheet as text — jsdom has no layout — and asserts the band's `nowrap`, the shrink order, and the name's ellipsis; `tests/server-sidebar-root.client.spec.tsx` asserts the render site asks for `wide: false` there and still asks for `wide: true` in the full-width footer-action row above it. The Playwright scenario keeps its existing fit assertion and adds that the two children share one vertical centre.
