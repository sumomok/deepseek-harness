# Agent Note: A permission preset names its selector tone

Status: implemented

English | [中文](2026-09-17-permission-preset-danger-tone.zh.md)

## Problem

Both places a person picks an access mode draw every row in the same label color: the composer's access chip menu, and the default-preset row in General settings. `danger-full-access` — no sandbox wall, no approval prompt — reads there exactly like `workspace-write`. The risk confirmation both surfaces already raise fires after the row is clicked, so the list a person chooses from carries no signal about which row hands the machine over.

Which row that is cannot be decided in the client. The preset table is host config: a deployment renames rows, adds its own, and the fork's permission-gateway layer adds `yolo-access`, a full-access bundle that still asks a person and is deliberately not the dangerous one — it even names the full-access glyph. A client-side list of ids would either miss a deployment's own row or paint a reviewed one red.

## Decision

`PresetSpec` gains `tone`, a closed set whose one member is `danger`, alongside the existing `glyph`. The host names the meaning, the client owns the color: `danger` marks the entry whose knobs hand the machine over, and a preset naming none renders in the plain label color. Both fields are validated in the schemastery table schema, so an unnamed tone fails at plugin load.

The two surfaces read two different host faces, so the tone travels two ways. The composer chip reads the `permissions` session projection, where `tone` joins `glyph` on `PresetOption` and its zod wire schema. The settings row reads the `permission` settings section, whose `defaultPreset` value is a bare preset name — per-choice presentation there rides each union member's own schemastery metadata, where `description` already carries the label, so `tone` rides the free-form `extra` slot beside it.

Painting is the `ui-primitives` `Menu` primitive's existing `danger` row: error-colored text and icon over `--dsw-alias-state-error-primary`, with the danger hover fill. A toned preset sets `danger` on its `MenuItem` and nothing else changes — no new CSS, no new token, and the selected and hovered states are the ones every other destructive menu row in the app already has.

The tone paints menu rows only. The composer's closed chip and the settings row's closed button keep the plain label color, and the `/permission` command popup is untouched — its `SelectOption` carries no tone, and the risk confirmation both surfaces raise is unchanged.

The fork's own landing is one line: `packages/bundle/base/cordis.patch.yml` marks `danger-full-access` with `tone: danger`. The plugin's own default table stays untoned, so a composition that does not ask for the tone renders exactly as before.

## Alternatives considered

**Key the color off the `danger-full-access` id in both clients.** Rejected: which row is dangerous is a deployment-varying choice, and both clients already prove it — the gateway layer ships a second full-access bundle under its own id that must stay plain.

**Derive the tone from `glyph`.** Rejected: `yolo-access` names the full-access glyph precisely because it is a full-access bundle, and it is the row that must not be red. Glyph answers which shield to draw; tone answers how much is at stake.

**Derive the tone from the knob pair (`danger-full-access` + `never`).** Rejected: it re-decides a presentation question from enforcement values, and would silently re-color any future preset whose bundle happens to match.

**Give the `permission` settings section a second field.** Rejected: a settings field is user-writable and lands in `settings.yaml`; the tone is the host's statement about its own table, not a preference.

**Carry the tone through schemastery's `role`.** Rejected: `role` names which widget renders a node. The tone is metadata about one union member, which is what `extra` is for.

## Consequences

A deployment marks one row of its preset table, and both access-mode menus paint it destructive. The fork's base bundle marks `danger-full-access`; everything else in the table, including the gateway's reviewed full-access row, stays plain.

The settings row and the composer chip now agree about a presentation fact that has one home in host config, rather than each client holding its own idea of which id is dangerous.

**Retirement.** This is a fork overlay on upstream host and client packages. If upstream gives preset rows a semantic color or danger marker in any form, the overlay retires and the fork adapts to upstream's form. Until then it is re-ported and re-verified on every rolling sync, because it lands in files upstream edits.

Package tests carry the evidence: the tone reaches the option and the described settings choice, an unnamed tone is refused at load, the projection serves it over the wire, both menus paint the toned row and only that row, and a preset sharing the full-access glyph without the tone stays plain.
