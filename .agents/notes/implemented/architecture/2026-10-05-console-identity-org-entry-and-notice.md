# Agent Note: console sidebar — the identity row's organization entry, and the organization notice card

Status: implemented

English | [中文](2026-10-05-console-identity-org-entry-and-notice.zh.md)

## Problem

A customer console whose deployment joins an organization composes the organization plugin, `@sumomok/dsh-org`, beside [`@deepseek-ai/dsh-experimental-server-sidebar`](../../../../packages/experimental/server-sidebar/README.md). Two things then have to reach every member through the sidebar's page, and neither may exist in a console without that plugin.

- A way from the signed-in person to the organization's Settings section, `sumomok-org`, which shows the organization's disclosure in full, the member's standing, and anything the plugin cannot do yet. The identity row ([identity and sign-out](2026-09-04-server-sidebar-identity-and-sign-out.md)) is where the console names that person; it offered nothing but 退出登录.
- The organization's disclosure: once for each member when the organization accepted it for the deployment, again for each new version, and under `member` acceptance with an agreement the member gives. It informs and asks; it must not hold up the conversation a member came to have.

Who has to see which version is not the page's to know. Under `organization` acceptance the version that counts is the one the organization's owner confirmed for this deployment, which only the backend holds, and the page receives only the current disclosure's text. What a member has seen is per member, on a console every member shares.

## Decision

**The entry opens Settings through the fork's `settings.trigger.action` seat.** Upstream hands `openSection(id)` only to the current step of `settings.onboarding`; `settings.launcher` receives `openSettings` and `openOnboarding`, and the shell's store is built inside `dsh-client-ui-settings-general`'s registration and not exported. The fork's core patch `settings-trigger-action-seat` ([its Agent Note](../feature/2026-09-11-settings-trigger-action-slot.md)) declares `settings.trigger.action`, whose owner props carry `openSection`. The sidebar occupies it with `server-sidebar.settings-opener`, a seat that renders nothing and publishes the opener into a source the sidebar reads through its inject face's `hooks.settingsOpener` while mounted (`client/settings-opener.ts`). The console renders the settings trigger in its compact form, which hides the list with CSS and keeps its occupants mounted, so the opener exists exactly while the settings shell does. No upstream file changes for this; the sidebar becomes that seat's second occupant.

**The entry follows the section, read from the `settings.section` winners.** 组织 is offered while a winner of `settings.section` carries `sumomok-org` and the opener is published (`client/org-section.ts`). A row the deployment disabled, or one the compatibility check stopped, ships no browser bundle, so the section, and with it the entry, follows whether the row runs. The winners are the rows the Settings page draws, so a section another entry shadows under that id counts as the shadowing entry does. With no entry the identity row's markup is the one a console without the plugin draws, so nothing about that console changes. 退出登录 stays on the row in every composition.

**The plugin decides what a member sees; the page shows it and reports what the member did.** The plugin's browser half mounts the Remote namespace `sumomokOrgNotice`, and its Host half answers each method for the member who called: `due()` with nothing, a wait, a one-time notice, or a disclosure to agree to; `markSeen(version)` and `confirm(version)` with the result or `stale`. The rule of who sees which version is written once, in the plugin, beside the data it needs. The page restates the answer types and checks every answer at the wire, ignoring fields it does not read and reading an unknown `kind` as nothing to show, since the plugin's answers grow only by addition. The card registers only once the namespace exists (`client/org-notice-remote.ts`); the namespace is not in the sidebar's `inject` list, so a console without the plugin starts and shows no card.

**The page remembers nothing beyond what it has put away.** A member's seen and agreed versions are the plugin's. On the console a Settings write is refused to every member and lands in the profile patch every member shares, and browser storage is shared by whoever uses one browser, which sign-out does not clear. A card the member put away is kept off that page until the plugin answers another version; 稍后 (Later) is that and nothing more, so the next load asks the member again.

**The card is a non-modal entry in `shell.overlay`.** `Modal` takes the focus and Tab and Escape until it closes, which holds up the composer, and a `settings.onboarding` step closes an open Settings panel and lives inside the sidebar's tree. `shell.overlay` is the frame-wide layer that passes pointer events to its entries only, and server-layout always renders it. The card takes no focus, has no close button, and stands where it covers neither the composer nor the identity row and its settings button: inside the sidebar column above its foot band on a wide frame, by the column's and the band's boxes the sidebar measures (`client/foot-placement.ts`), and under the drawer button on a narrow one, ending above the line where an empty conversation's composer starts. It sits under the narrow frame's drawer and scrim, which cover it as they cover the rest of the page.

## Alternatives considered

**Ask upstream for an opener, or open Settings on its first row.** Upstream offers no such opener, and opening on the first row makes the member find 组织 under 账户与用量 themselves. An upstream opener, once there is one, replaces the seat.

**Offer the entry by the plugin's service or by a sidebar `Config` field.** A service's presence does not say the section is on the Settings page, and a `Config` field would be a second statement of whether the organization row runs, one that can disagree with the row and that the browser half cannot read without another route.

**Let the page decide from the disclosure and a stored seen version.** The page has the current text but not the version the organization's owner confirmed, and a seen version in Settings or browser storage would be shared between members.

**Move 退出登录 into the menu.** The row would then have two layouts, sign-out in a menu with the organization plugin and on the row without it, and on a shared machine signing out is the action that has to be one visible click.

**Place the card at the bottom-left at a fixed 360px width.** The sidebar column is 180px wide at common frame widths, and an empty conversation's composer starts about 180px further right, so a 360px card there covers the composer.

## Consequences

The console offers the organization's section from the identity row and shows the disclosure without any change to an upstream file beyond the fork's existing seat, and a console without the organization plugin draws exactly what it drew before; `apps/web/tests/server-sidebar.e2e.ts` checks both compositions in a real browser, the organization one through a fixture plugin with an in-memory `sumomokOrgNotice` Remote. The sidebar is a second consumer of `settings-trigger-action-seat`, so retiring that patch now needs the console to have another way to open a Settings section; the identity-menu scenario fails if the seat stops receiving the opener.

The page depends on the plugin mounting `sumomokOrgNotice`: a plugin version that registers its section without the namespace leaves members without the notice, and the page cannot detect that; the plugin's own tests pin it. A new version shows at the page's next ask (mount, reconnection, the page becoming visible, or a `pending` answer's delay), since the plugin offers no stream. On a wide frame the card is as wide as the sidebar column, 164px at the smallest wide frames, and scrolls a long disclosure; on a narrow frame it opens only in the half of the screen above the composer.
