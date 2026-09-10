# Agent Note: A same-row action seat beside the Settings trigger

Status: implemented

English | [中文](2026-09-11-settings-trigger-action-slot.zh.md)

## Problem

The fork's desktop shell needs to offer an "update ready" control where the user already looks for application-level state: on the Settings row at the sidebar foot. Nothing there could hold it.

`sidebar.footer.action` is the additive seat nearest Settings, but `.footArea` is a column — the sidebar's own comment reads "Footer actions stack above Settings" — so an occupant lands on its own row above the trigger, not beside it. `settings.trigger` is a single slot over the button's *content*: an occupant there replaces the shipped gear and label rather than joining them. Neither gap is reachable from a plugin, because a slot key is a `SlotMap` declaration merge owned by the package that renders the location.

## Decision

`settings.trigger.action` is a root-scoped list slot, declared in ui-settings beside every other settings slot type and rendered by the ui-settings-general shell as the last element of the trigger row, after the connection indicator. Entries render by ascending `order`.

Owner props are `SettingsTriggerOwnerProps` — the sidebar's `wide` state, the same currency the trigger content seat receives. `settings.action` already reuses `SettingsHeaderOwnerProps` for the header's action list, so a seat sharing its neighbour's owner share is this package's existing shape.

Right alignment is structural rather than declared: the trigger is `flex: 1`, so everything after it sits against the row's right edge. The seat's wrapper and the renderer's own slot anchor are both `display: contents`, so an unoccupied seat contributes neither a flex item nor one of the row's 8px gaps — the row with no contributor is byte-identical in layout to the row before this change.

The collapsed 56px rail folds the row to a 36px trigger circle with nothing beside it. The row hides the seat there in CSS (`.triggerRow.railRow .triggerActions { display: none }`) instead of skipping the `renderSlot` call, so an occupant keeps its own state, timers, and subscriptions across a fold and unfold. `wide` still reaches the occupant, which is how it learns the row is folded.

## Alternatives considered

**Register into `sidebar.footer.action` and accept the row above.** Rejected by the requirement: the control has to read as belonging to Settings, and a row of its own above the trigger reads as a separate control.

**Occupy `settings.trigger` and draw a gear with a badge.** Rejected: that seat is single and its occupant owns the whole button content, so the plugin would take over the shipped icon, the label, and their localization to add one adjacent affordance.

**Withhold the seat in the rail the way the connection indicator is withheld.** Rejected: the indicator is derived from a store the shell already holds, so re-deriving it after a fold is free, while an occupant of this seat owns private state a remount would discard.

**Let the rail row grow to fit an occupant.** Rejected: the rail's fixed 36px column geometry is shipped layout shared with every other rail control, and widening it for one optional contributor changes the collapsed sidebar for compositions that have no contributor at all.

## Consequences

A plugin puts a control on the Settings row by registering one entry, with no fork of ui-settings-general and no replacement of shipped chrome. The seat is empty in the shipped composition, so the generated client catalog lists it with no occupants and `replaceRisk: 'none'`.

**Retirement.** This is a fork overlay on upstream client packages. If upstream opens an equivalent same-row seat — in any form, not only this key — the overlay is retired and the fork's plugin adapts to upstream's form. It also retires if the fork moves to upstream's desktop shell and drops the update plugin that needs the seat. Until then it is re-ported and re-verified on every rolling sync, because it lands in the same trigger-row markup and the same slot contract upstream edits.

No browser golden changes. The shipped composition registers no occupant, so the seat renders as a role-less `display: contents` element that no ARIA snapshot can see; `apps/web/tests/settings-chrome.e2e.ts` and `lifecycle-chrome.e2e.ts` replay unchanged. The package tests carry the evidence instead: the declared child specs, an empty seat with no box, an occupant at the row's last position after the trigger, the folded row still passing `wide: false` to a mounted occupant, and the four CSS declarations the layout claim rests on.
