# Agent Note: Export the ANSI line parser

Status: implemented

English | [中文](2026-08-27-export-ansi-parser.zh.md)

## Problem

`parseAnsiLines` (and its `AnsiLine` result type) in `dsh-client-ui-primitives` turns raw command output into per-line styled spans — the parsing `TerminalBlock` renders. It was module-private to `ansi.ts`, absent from the package's `src/index.ts` barrel, so nothing outside `TerminalBlock.tsx` could tokenize ANSI the same way. A fork-internal plugin that re-renders terminal output with clickable referents (linking a path or symbol inside the command output to another surface) needs to tokenize ANSI identically to the host renderer; a second implementation would drift from `TerminalBlock`'s cursor-replay and SGR-folding behavior the moment either changed.

## Decision

`parseAnsiLines` and `AnsiLine` are public exports of `@deepseek-ai/dsh-client-ui-primitives`, added to `src/index.ts` beside the other `TerminalBlock` exports. No implementation change: the parser's cursor replay, SGR folding, and theme-token mapping are byte-identical to what `TerminalBlock` already used internally, and it keeps the JSDoc contract `ansi.ts` already carried.

## Alternatives considered

**Vendor a copy of `parseAnsiLines` into the fork-internal plugin.** Rejected: the parser's cursor-replay and wide-character handling are tuned to match `TerminalBlock`'s own rendering exactly (see its module doc); a second copy would drift the first time either implementation changed, producing two renderers that tokenize the same output differently.

**Add a render hook to `TerminalBlock` instead of exporting the parser.** Rejected: the fork-internal plugin renders its own surface, not a `TerminalBlock` instance, and needs the parsed spans as data rather than a hook into `TerminalBlock`'s own JSX.

## Consequences

A consumer package can `import { parseAnsiLines, type AnsiLine } from '@deepseek-ai/dsh-client-ui-primitives'` and get the exact tokenization `TerminalBlock` uses, with no fork of `ansi.ts`. The package's public surface grows by one function and one type; `TerminalBlock`'s own rendering is unchanged.

**Retirement.** This patch is a temporary overlay for a capability upstream does not expose yet: if upstream exports the parser itself, or ships a terminal-output render hook that removes the need to re-parse ANSI outside `TerminalBlock`, this patch is retired and the dependent plugin adapts to upstream's form.
