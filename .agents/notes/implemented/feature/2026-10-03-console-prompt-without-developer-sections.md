# Agent Note: The console's model requests carry no developer prompt sections

Status: implemented

English | [中文](2026-10-03-console-prompt-without-developer-sections.zh.md)

## Problem

Every console deployment sent the model three sections written for someone developing DeepSeek Harness. The Web bundle's `web-runtime` row ships `surfaceContext: true`, which registers `harness:source` (the path of the DeepSeek Harness checkout, to inspect or extend DSH) and `app:web-surface` (the page's local URL, `pnpm run dev:web`, and how to rebuild Web artifacts). `ui-deliverables` registers `ui:deliverable-file-references`, which tells the model when to call `present`, a tool neither console preset offers. The console persona tells the model not to describe its working directory or internal implementation, and the same request then handed it a checkout path and dev-server instructions.

## Decision

**The console bundle configures `web-runtime` with `surfaceContext: false`.** The flag gates three registrations and nothing else: the two prompt sections and the `DSH_WEB_URL` variable the row adds to a shell command's environment. Only `tool-bash` and `tool-pwsh` read that variable through `shellEnv.collect`, and neither console preset offers them. A patch replaces a row's whole config, so the console row restates the Web bundle's `openBrowser`, `printUrl`, and `trustedHosts` values; `tests/profile.spec.ts` checks that its config equals the shipped one with only `surfaceContext` changed, so a field the Web bundle adds later fails the test rather than falling to its default.

**The console bundle disables `ui-deliverables`.** The package has no Config, its section is registered unconditionally, and its README names removing the row as the way to turn the surface off. The rest of what the row carries goes with it: the changed-files card, which draws only with Coding Tools on; the delivery cards that `present` produces; clickable file paths in a closing answer; and the review tab those open. `ui-open-in-app` seats its actions inside those cards, so its registrations never fire.

**The console Web snapshot sees the bundle's choice.** The Web e2e scaffold re-applies `web-runtime` above every profile layer to turn off the URL line and the browser handoff, carrying over the composed `surfaceContext`. It now composes enabled profile packages into that value, so `console-auto-compact` pins the console's own system prompt.

## Alternatives considered

**A persona with `complete: true`.** It makes the persona the whole system prompt, which also drops the content column's on-display rule and every tool's guidance section.

**An empty scoped section under each name.** A scoped section shadows a global one with the same name, and an empty section renders nothing, but no shipped row registers a section by a configured name, so this needs new code in a console package for a result one composition row already gives.

**A core patch making the `ui-deliverables` section depend on `present`.** The console line takes behavior from composition rows where a supported switch exists; disabling the row is one.

## Consequences

The console's model requests hold the persona, the content column's rule, the file and skill tools' guidance, and nothing that names the DeepSeek Harness checkout, a dev server, or `present`. A console page draws no changed-files card, delivery card, or file link in a closing answer. The `web-content-console` pin of the content-read scenarios is unchanged: those scenarios compose the Web bundle with the content column and a copy of the console preset, not this bundle.
