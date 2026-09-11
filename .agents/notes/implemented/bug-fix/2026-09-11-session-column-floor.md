# Agent Note: the session column floors at 180px

Status: implemented

English | [中文](2026-09-11-session-column-floor.zh.md)

## Problem

`packages/experimental/server-layout/src/client/tracks.ts` solves the shell's four grid tracks on a fixed 24-unit ratio — session 3, content 16, chat 5 — as a pure function of the measured frame width and three booleans. The ratio has no lower bound, so in a 500px-wide browser window the expanded session column solves to 63px. The session list renders its Chinese titles inside that width, and every title wraps one character per line; the column is unreadable rather than merely tight. The product owner's screenshot of the console at that width is the report.

## Decision

**The expanded session column never solves below `SESSION_MIN = 180`.** In `solveTracks`, an unfolded column is `min(columns, max(SESSION_MIN, share(columns, 3, 24)))`, where `columns` is the frame less the details band. Content and chat then divide what remains on their 16:5 exactly as before, so the tracks still tile the frame whenever it is positive.

180 is the value the 3/24 share already produces from 1440px of columns. Every frame from 1440px up (with details closed) therefore solves byte-for-byte as it did before, and only a narrower frame lifts the column above its share; the floor changes nothing on the desktop widths the console is used at and only reaches the window sizes where the ratio had failed. A frame narrower than 180px clamps the column to the frame rather than overflowing it.

The floor is a contract-frozen constant beside `SESSION_RAIL` and `DETAILS_WIDTH`, not a configuration field: the shell's geometry is a fixed product decision so that a registrant written against one column renders identically under every composition, and the package README states it that way.

What the floor does not do: it does not fold the column on its own, it adds no breakpoint, and it opens no drawer. A folded column still renders the 56px rail and is unaffected. Below about 540px the chat column drops under 360px even with the content column collapsed; the fold control is the only way to give that width back on a phone-width window, and the README's Known Limitations say so.

## Alternatives considered

**Auto-fold the session column below a breakpoint.** Rejected. The package's stated geometry is that the solve is a function of frame width and three booleans with no concession chain, so that a resize reproduces the same layout and nothing has to be restored. A breakpoint that folds the column adds a fourth input the layout service does not own — the fold is user state, toggled through `ctx.layout.toggleSidebar()` — and the shell would either overwrite that state on resize or hold two fold states that disagree. It also does not fix the reported width: a 500px window is above any breakpoint that leaves a desktop usable.

**A drawer or overlay for the session list at narrow widths.** Rejected as out of scope for a geometry fix. It is a new surface with its own open state, dismissal, and focus handling, and the shipped ui-layout is the shell that already carries responsive behavior for deployments that need it. (This later shipped for the console below 1024px — see [the narrow-frame session drawer](../feature/2026-09-11-narrow-frame-session-drawer.md).)

**Make the floor a config field.** Rejected. The rail width and details width are contract-frozen for the same reason the ratio is, and the README lists "ratio and rail width are contract-frozen constants, not configuration" as a known limitation rather than a gap.

**A smaller floor such as 150px.** Rejected. 150px is what a 1200px frame yields on the ratio and is where the wrapping starts to appear in the screenshot; 180px is the narrowest value that both keeps two-character-per-line wrapping out of the sampled titles and coincides with a width the ratio already produces, so the change is invisible at and above 1440px.

## Consequences

- A 500px frame with the content column collapsed solves to session 180, chat 320; a 1440px frame solves to 180 exactly as before; a 2400px frame solves to 300, the ratio's own answer.
- Frames between 1440px and about 540px give content and chat less than the ratio would have; the sum invariant holds at every width.
- The shell-frame bench's 1200px resize case now expects 180 rather than 150 for the session column, through the same `solveTracks` call it already compared against.

## Testing

`packages/experimental/server-layout/tests/tracks.client.spec.ts` pins the floor at 500px (session 180, content 0, chat 320), the 1440px coincidence with the ratio, the ratio winning at 2400px (300), the clamp at 120px (session 120, chat 0), the floor applying to what the details band leaves (500px with details open: session 140), and a folded 500px frame staying on the 56px rail. The tiling property test gains 120 and 500 as sampled widths.
