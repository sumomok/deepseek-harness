# Agent Note: The server console runs in its own harness home

Status: implemented

English | [中文](2026-09-02-server-console-isolated-harness-home.zh.md)

## Problem

The web console this line composes and the desktop build share one harness home by default: [`resolveDshHome`](../../../../packages/util/home-paths/README.md) answers `$DSH_HOME` or `~/.dsh` for every surface, and both builds run with that default. The console's plugins append session events the desktop build carries no declaration for — `content/shown` is one — and a `SessionEventMap` member is required-on-read: a build that cannot type an event refuses the whole log instead of skipping the event ([mechanism](../architecture/2026-08-10-session-log-version-mechanism.md)). Every conversation held in the console therefore fails to load in the desktop app on the same machine, and the failure lands on the reader, which did nothing wrong.

## Decision

This line launches through [`scripts/dsh-web.sh`](../../../../scripts/dsh-web.sh): it exports `DSH_HOME=~/.dsh-web` unless the caller already supplied a non-empty value, changes to the repository root so `pnpm dsh` resolves the root script, and replaces itself with `pnpm dsh web` carrying every argument verbatim — the `--patch` overlays that compose the console included. The harness itself is untouched: `home-paths` keeps `~/.dsh` as the default for every surface, and `apps/cli` keeps reading it. The isolation lives on this line's own launch surface alone.

The two builds therefore keep separate `profiles/`, `sessions/`, `settings.yaml`, and `.credentials.yaml` trees. A console-only key goes in `~/.dsh-web/.credentials.yaml`, or `DEEPSEEK_API_KEY` stays in the launch environment, which resolves ahead of the managed document. The script creates no directory: `dsh` owns the harness home and initializes the `web` profile inside it on first use, so an isolated home reaches the same state the default one would.

## Alternatives considered

**Change the default home, in `home-paths` or in `apps/cli`.** Both are upstream code this fork re-syncs, so a changed default conflicts on every sync, relocates every existing deployment's data, and reroutes the desktop build too — it reads the same resolver.

**Mark `content/shown` and this line's other events `ignorable: true`.** The reader already honors the envelope flag, but `Session.append()` accepts only `type`, `data`, and a surface intent, so a plugin has no way to set it; this needs an upstream opening in the append signature first. It is also only half true: the event is informational to a build without the content column and load-bearing to the build that has it, and one static flag cannot say both. Isolation stands whether or not that opening arrives.

**Ask the operator to export `DSH_HOME` by hand.** A convention with no artifact fails the first time someone runs `pnpm dsh web` directly, and the damage it produces — a desktop session log that no longer loads — surfaces far from the omission.

**Add a `--home` flag to the launcher.** The launcher has no such flag, adding one is an upstream change to `apps/cli`, and the environment variable it would feed already exists.

## Consequences

- Neither build reads the other's history: a conversation started in the console is invisible to the desktop app, and one started in the desktop app is invisible to the console. Cross-build continuity is what isolation costs; each build's own log staying loadable is what it buys.
- Sessions an earlier console run already wrote under `~/.dsh` stay there. The script moves nothing, and a desktop build that refuses those logs keeps refusing them.
- `pnpm dsh web` still exists and still resolves `~/.dsh`, so the isolation holds only for launches that go through the script.
- An upstream opening that lets a producer mark its own events ignorable would make the two homes readable to each other again; it would not make them one home, because the console's settings and credentials stay deployment-specific.
