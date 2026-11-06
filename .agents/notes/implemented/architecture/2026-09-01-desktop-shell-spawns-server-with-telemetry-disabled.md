# Agent Note: The desktop shell spawns its server with telemetry disabled

Status: implemented

English | [中文](2026-09-01-desktop-shell-spawns-server-with-telemetry-disabled.zh.md)

## Problem

[This fork ships with session telemetry and plugin inventory reporting off](../process/2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.md) turns the DeepSeek-bound rows off in the bundles every profile composes. Those rows are patch entries, and a patch layer composed above them — a profile patch, a home-level patch, an invocation `--patch` — can replace a row and turn `session-telemetry-otel` back on. The desktop is the one product whose server launch this fork controls directly, so it can carry a second guarantee that does not depend on which patch layers sit under it.

## Decision

`startServer` in [`apps/desktop-shell/src/server.ts`](../../../../apps/desktop-shell/src/server.ts) sets `DSH_TELEMETRY_DISABLED: '1'` on the embedded server's spawn environment. The value is spread after the shell's own environment and before `spec.env`, so a caller that sets its own value (a test) still overrides it.

`DSH_TELEMETRY_DISABLED` is upstream's own hard-disable switch. `resolveTelemetryPatch` in [`packages/boot/app-boot/src/profile-context.ts`](../../../../packages/boot/app-boot/src/profile-context.ts) turns any non-empty value into a `disabled: true` patch for the `session-telemetry-otel` row, and `readProfilePatches` appends that patch after every bundle, profile, home, and overlay layer. The desktop server therefore runs with the telemetry row disabled whatever the layers below it say.

The switch reaches that one row only. `plugin-package-inventory-deepseek` and `session-log-deepseek` have no environment switch; the bundle rows the shared note describes are their only off-switches.

## Alternatives considered

**Rely on the bundle rows alone.** Rejected for the desktop: a user or a future bundle layer that restates the `session-telemetry-otel` row reopens the upload, and nothing on the desktop side would notice. The environment switch is applied after every patch layer, so it holds regardless.

**Invent a fork environment switch covering the other two rows.** Rejected: it would be a new configuration surface this fork documents and maintains, while the bundle rows already turn those two plugins off in every composition the desktop ships.

## Consequences

The desktop server cannot upload session telemetry even if a patch layer re-enables the row; turning it back on requires changing the shell's spawn environment. [`apps/desktop-shell/tests/server.spec.ts`](../../../../apps/desktop-shell/tests/server.spec.ts) spawns a scripted child process and checks that it sees `DSH_TELEMETRY_DISABLED=1` by default and that an explicit `spec.env` entry overrides it. [`apps/desktop-shell/tests/desktop-composition-layer.spec.ts`](../../../../apps/desktop-shell/tests/desktop-composition-layer.spec.ts) covers the composed rows the bundle layers produce.
