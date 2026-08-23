# Agent Note: Host-configured presets name their selector glyph

Status: implemented

English | [中文](2026-08-23-permission-preset-glyph.zh.md)

## Problem

The Web composer's permission selector draws one shield glyph per row from a closed design set: a check for `read-only`, a pencil for `workspace-write`, an exclamation mark for `danger-full-access`. It chose that glyph by the option's own value, so only the three built-in preset ids matched.

A deployment that configures its own preset — for example a full-access bundle that keeps approval prompts on — therefore rendered as a text-only row between two rows carrying icons, and the trigger lost its icon whenever such a preset or the derived `custom` state was current. Nothing in the option projection let a client do better: `PresetOption` carried `value`, `name`, and `description`, and a client cannot guess which glyph fits a name it has never seen.

## Decision

`PresetSpec` and `PresetOption` carry an optional `glyph`, one of `read-only`, `workspace-write`, or `danger-full-access` — the names of the three glyphs the design set already ships. `PermissionPresetService.optionOf` passes a configured glyph through unchanged, and the `permissions` projection's wire schema carries it, so every presentation layer reads the same choice the host configured.

The field is a closed enum in both the schemastery `Config` schema and the projection's zod wire schema, so a name outside the set fails at plugin load with the offending path (`$.presets.<name>.glyph`), not at render time.

`PermissionSelect` resolves each row as `permissionGlyph(option.glyph ?? option.value)`, and any key outside the design set now draws the bare shield outline that the check and exclamation glyphs are already built on. The trigger resolves the current option the same way. Every row and the trigger therefore carry an icon of the same size, including the derived `custom` state, which names no glyph.

## Alternatives considered

**Derive the glyph from the preset's sandbox level.** Rejected: the option projection deliberately carries no knob values — a client renders labels and descriptions, and the sandbox mode reaches the model and the tools through its own event. Deriving presentation from a knob would put a second consumer on `sandbox/mode` and would still be wrong for a preset whose point is that its knobs do not describe it, such as full access held behind approval prompts.

**Let a preset name an arbitrary icon.** Rejected: the glyphs are a design set drawn inline as SVG, not an icon library. A free-form name would either fail to resolve or invite hosts to ship artwork through configuration.

**Only add the bare-outline fallback, with no `glyph` field.** Rejected: it fixes the alignment but not the meaning. A preset that is full access with review should be able to show the full-access shield rather than a neutral outline, and only the host knows that.

**Keep the mapping in the client and extend it with the fork's preset names.** Rejected: the client cannot enumerate host configuration, and hardcoding deployment-specific ids in a shipped component is the defect this change removes.

## Consequences

A host now decides presentation for its own presets without a client change, and the selector has no icon-less state. The glyph set stays closed, so adding a fourth glyph is a deliberate change to the design set, the enum, and both schemas together. A preset that names no glyph is unchanged: it still resolves by its own id, which keeps the three built-in ids working exactly as before.

**Retirement.** This change is carried as a temporary overlay in the fork. If upstream gains an equivalent way for a host-configured preset to select its selector artwork — in any form, not only this one — the overlay is retired and the fork's plugins adapt to upstream's form; a forked implementation of the same behavior is never maintained alongside it.

The client's aria tree is unchanged — the glyphs are `aria-hidden`, so no browser snapshot observes them. Coverage is the `permission-presets` schema and projection specs plus the `PermissionSelect` component spec, which pins the named glyph, the fallback outline, and the trigger sharing the row resolution.
