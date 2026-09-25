# Agent Note: Two-level settings navigation

Status: implemented

English | [中文](2026-09-14-settings-navigation-groups.zh.md)

## Problem

The settings rail is a flat list of every `settings.section` registration, sorted by `order`. Upstream ships four sections and the fork's desktop composition adds seven more, so the shipped product draws eleven peers in one column: General, Models, Plugins, Agent presets, Balance, Automatic review, MCP servers, At file, Screenshot logins, Vision, Desktop update. Nothing tells a reader which of them are about the model, which are about extensions, and which are about the account — and eight of the eleven draw the same gear, because `navIcon()` names only `models`, `agent-presets`, and `plugins`.

Every mature settings surface of this size — macOS System Settings, Chrome, VS Code — groups its rail rather than lengthening it, which is the comparison that settled the direction.

The column also cannot grow. `.panel` is `min(800px, 100vh - 48px)` with `overflow: hidden`, and `.nav` is a flex column whose `.navList` declares neither `min-height: 0` nor an overflow, so a flex item that refuses to shrink below its content is simply clipped by the panel. Eleven 40px cells plus the title already reach 478px; a shorter viewport, a larger font, or one more plugin silently cuts the last rows off with no way to reach them.

A registrant cannot fix this from outside. A `settings.section` registration carries `key`, `id`, `order`, `label`, and `priority` and nothing else (`@deepseek-ai/dsh-client-ui-slots` `register`), so it has no way to name a group or a glyph.

## Decision

The rail draws two levels: a fixed table of groups, each with one glyph and a non-interactive title, over the ledger rows themselves. Section ids, `order`, labels, and the `openSection(id)` opener are untouched — only where a row is drawn changed.

Seven groups, in rail order, with the sections each claims: General (`general`, `at-file`), Models (`models`, `vision-switch`), Agent (`agent-presets`, `llm-permission-gateway`), Extensions (`plugins`, `mcp-servers`, `screenshot-logins`), Account & usage (`balance`), About (`desktop-update`), and a trailing Other for every id the table does not name. Claimed groups draw their members in table order rather than ledger order, so the rail reads the same whatever `order` a registrant chose. A group with no present member draws nothing at all, so an uninstalled plugin leaves no empty title behind, and an unrecognized id keeps its row under Other in ledger order — no section can disappear by being unknown.

**The table lives in the shell**, hard-coded in `nav-groups.ts`, because neither of the two ways to move it out exists. A registrant cannot declare its group (the register options above), and a browser plugin receives no configuration: the client boot wire carries `id`, `inject`, and `immediately` per row (`@deepseek-ai/dsh-client-modules` `BootPluginRow`), and `bootClient` creates each entry as `loader.create({ name })` — the wire carries no config field at all. A client-face `apply` may still declare a `Config` parameter (`ui-conversation` does), but with nothing on the wire to fill it such a parameter only ever materializes its schema defaults. A cordis.yml `config:` block on a dual-face row reaches that package's node half only. Making the table configurable would mean opening a new Host-to-Client channel for a presentation-only fact, which is a larger change than the grouping itself.

Glyphs move to the group titles and members carry none. `account` takes the person mark rather than the gauge: the gauge is already the session token meter's mark in the composer pills, and one glyph meaning two things in one product is worse than the person mark reading a shade wide for a group that also holds usage. `about` takes the question ring, the only informational mark in this icon set, drawn at the rail's 16px. Other reuses General's gear, which is the same fallback the flat rail had.

**Accessibility: each group is a `role="group"` named by `aria-labelledby` at its title**, rather than a decorative title hidden from assistive technology. The two levels are the point of the change, and a hidden title would leave a screen reader with the same flat list of eleven buttons — with Vision and Models indistinguishable. The title stays a `div`: it is not focusable, not clickable, and has no interactive role.

Two structural repairs ride along. `.nav` and `.navList` take `min-height: 0` and `.navList` takes `overflow-y: auto`, so the rail scrolls instead of being clipped; the panel already rebinds the elevated-surface scrollbar tokens, which inherit down. And the nav projection reads `ctx.slots.entriesOfSlot('settings.section')` instead of `entries()`: `entries()` is the raw ledger, so two entries on one section id drew two rows while the outlet rendered one — the shadowed row opened a panel showing the winner. The projection's version/revision cache keeps the snapshot reference stable, which is what `entriesOfSlot` needs to sit behind a `getSnapshot`.

## Alternatives considered

**Let registrants declare their group.** Rejected: the group set is a product decision about one rail, and a registration option would let any plugin — including a third-party one — mint groups or place itself in the wrong one, with no place to arbitrate.

**Make the table a validated `Config` field on ui-settings-general and put the fork's full table in the composition overlay.** Rejected as unavailable, not undesirable: the client boot wire carries no config and the loader creates client entries by name alone (evidence above). This is the preferred form the moment a client plugin can take configuration.

**Collapsible groups.** Rejected: a rail of eleven rows has nothing to hide, and collapse state is durable per-viewer state the shell would then have to own.

**Sort the flat list by group without titles.** Rejected: it reorders the same eleven peers and tells a reader nothing they can see.

**Keep a glyph on every member row as well.** Rejected: eleven glyphs at one indent read as eleven peers again, which is the problem; the glyph belongs to the level that distinguishes.

## Consequences

The rail shows six named groups plus a fallback, each with one glyph, and scrolls when it outgrows the panel. Adding a section to a named group is a one-line edit of `nav-groups.ts`; adding none still works, because the section lands under Other and opens normally.

A group title and the member beneath it can read the same word, because the title is the shell's copy (`nav.group.*`) and the row's is the registrant's (`general.nav` in this package, `nav` in the `settings.models` namespace). Where the two would collide, **the member row takes the longer name and the group title stands**: a group title is an intent name and has to stay short enough to head a column, while a member label describes the page it opens. The General group therefore holds **General settings** (Chinese 通用设置, which never collided), and the Models group holds **Providers & models** / **供应商与模型** — provider cards, API keys, and model lists are what that page is. Section ids, page titles, and group titles are untouched; only the two row labels carry the distinction.

Package specs carry the evidence: every section files under its group in table order — three groups of the fixture list their members against ascending `order`, so a rail that fell back to ledger order fails — each section draws exactly once across the groups, an id the table never named lands under Other and opens, a group with no present member draws no title, six distinct group glyphs with no glyph on any member row, each group named through `aria-labelledby` at a non-interactive title, group titles following the active locale, the four CSS declarations that make the rail scroll and set the levels apart, and one nav row per section cell when a second entry shadows an occupied id.

**Retirement.** This is a fork overlay on an upstream client package, in the same files as the `settings.trigger.action` family. If upstream gives `settings.section` registrations a group or glyph of their own, or the shell grows any grouping, icon, or scrolling mechanism, the corresponding part is retired and the fork adapts to upstream's form. Until then it is re-ported and re-verified on every rolling sync, because it lands in the nav markup, the nav stylesheet, and the ledger projection upstream edits.
