# Agent Note: The console's model requests carry no developer prompt sections

Status: implemented

English | [中文](2026-10-03-console-prompt-without-developer-sections.zh.md)

## Problem

Every console deployment sent the model three sections written for someone developing DeepSeek Harness. The Web bundle's `web-runtime` row ships `surfaceContext: true`, which registers `harness:source` (the path of the DeepSeek Harness checkout, to inspect or extend DSH) and `app:web-surface` (the page's local URL, `pnpm run dev:web`, and how to rebuild Web artifacts). `ui-deliverables` registers `ui:deliverable-file-references`, which tells the model when to call `present`, a tool neither console preset offers. The console persona tells the model not to describe its working directory or internal implementation, and the same request then handed it a checkout path and dev-server instructions. The prompt also opened with the base `system-prompt` row's fixed sentence `You are an AI agent powered by DeepSeek Harness.`; on 2026-10-03, asked what system or framework it runs on, the console assistant answered that DeepSeek Harness drives it.

## Decision

**The console bundle configures `web-runtime` with `surfaceContext: false`.** The flag gates three registrations and nothing else: the two prompt sections and the `DSH_WEB_URL` variable the row adds to a shell command's environment. Only `tool-bash` and `tool-pwsh` read that variable through `shellEnv.collect`, and neither console preset offers them. A patch replaces a row's whole config, so the console row restates the Web bundle's `openBrowser`, `printUrl`, and `trustedHosts` values; `tests/profile.spec.ts` checks that its config equals the shipped one with only `surfaceContext` changed, so a field the Web bundle adds later fails the test rather than falling to its default.

**The console bundle disables `ui-deliverables`.** The package has no Config, its section is registered unconditionally, and its README names removing the row as the way to turn the surface off. The rest of what the row carries goes with it: the changed-files card, which draws only with Coding Tools on; the delivery cards that `present` produces; clickable file paths in a closing answer; and the review tab those open. `ui-open-in-app` seats its actions inside those cards, so its registrations never fire.

**The console bundle configures `system-prompt` with `includeHarnessIdentity: false`.** The `dsh-system-prompt` README says to set it false "only when a compatibility deployment owns the complete system prompt"; the console is not a compatibility deployment and does not own the complete prompt, since the content column and the file and skill tools add their own sections. The same README states that the flag omits only that fixed opener, and no source outside `dsh-system-prompt` reads the `harness:identity` section, so the change removes one sentence and each console preset's persona prefix then opens the prompt. A patch replaces the whole config, so the row restates the Web bundle's `personaPrefix` and `personaSuffix`, which each console preset's persona shadows; `tests/profile.spec.ts` checks the row against the shipped one with only `includeHarnessIdentity` added.

**The console Web snapshot sees the bundle's choice.** The Web e2e scaffold re-applies `web-runtime` above every profile layer to turn off the URL line and the browser handoff, carrying over the composed `surfaceContext`. It now composes enabled profile packages into that value, so `console-auto-compact` pins the console's own system prompt.

## Alternatives considered

**A persona with `complete: true`.** It makes the persona the whole system prompt, which also drops the content column's on-display rule and every tool's guidance section.

**An empty scoped section under each name.** A scoped section shadows a global one with the same name, and an empty section renders nothing, but no shipped row registers a section by a configured name, so this needs new code in a console package for a result one composition row already gives.

**A core patch making the `ui-deliverables` section depend on `present`.** The console line takes behavior from composition rows where a supported switch exists; disabling the row is one.

## Consequences

The console's model requests hold the persona, the content column's rule, the file and skill tools' guidance, and no system-prompt sentence that names DeepSeek Harness, its checkout, a dev server, or `present`. The first turn's runtime-context message still names the "DSH file policy" and the "DSH file sandbox"; that text comes from the sandbox policy, not from a row this bundle composes. A console page draws no changed-files card, delivery card, or file link in a closing answer. The content-read scenarios compose the Web bundle with the content column, a copy of the console preset, and `apps/web/tests/console-prompt.overlay.yml`, which restates these three rows; their `web-content-console` pin holds the same system prompt as the `console-auto-compact` pin, and `apps/web/tests/console-preset.spec.ts` checks both copies against this bundle.
