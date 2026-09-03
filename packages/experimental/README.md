---
description: "The experimental group map: private prototypes and internal-only plugins excluded from official releases, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/experimental

English | [中文](README.zh.md)

## Summary

The experimental group contains prototype capabilities that are not part of any official release: they run on the real harness, but their contracts can change and they carry no support promise. The group holds Agent Teams, the cross-realm Inspector, the CPython subprocess backend for the code-execution seam, and the browser-worker runtime and image packer used by preview deployments. Use these packages to try an unreleased capability; they carry no stability promise, and released products must not depend on them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`agent-team-profile`](agent-team-profile/README.md) | Explicit source-checkout profile layer for Agent Teams | — |
| [`agent-team`](agent-team/README.md) | Named teammates with durable messages and a shared task board | `ctx.agentTeams` |
| [`agent-team-web-profile`](agent-team-web-profile/README.md) | Explicit source-checkout Web layer for Agent Teams | — |
| [`auth-gate`](auth-gate/README.md) | Sends a browser without an access token to the deployment's login page, mirrors the one it returns with into a cookie, and injects it into forwarded MCP requests | — |
| [`client-ui-agent-team`](client-ui-agent-team/README.md) | Team roster, task board, and teammate navigation for Web | — |
| [`code-runtime-python`](code-runtime-python/README.md) | CPython subprocess backend for the code-execution seam | `ctx.codeRuntime` |
| [`content-column`](content-column/README.md) | Browser half of the content surface: claims the shell's content column, lists the session's entries, and dispatches the selected one by kind | — |
| [`content-frame`](content-frame/README.md) | Serves one operator-configured static web application and contributes it as the content column's `page` kind | — |
| [`content-surface`](content-surface/README.md) | Host half of the content surface: extractors fold logged events into a per-session stream of typed content entries | `ctx.contentSurface` |
| [`inspector`](inspector/README.md) | Cross-realm CDP hub for Host debugging, Client Runtime inspection, network capture, and Cordis trees | `ctx.inspector` |
| [`library-skills`](library-skills/README.md) | Ships component-library conventions as bundled SKILLs mounted at the lowest skill rank | — |
| [`server-layout`](server-layout/README.md) | Service-line shell: a permanent four-track frame (session, content, chat, details) replacing the shipped one | `ctx.layout` |
| [`server-sidebar`](server-sidebar/README.md) | Product console sidebar: a fixed workbench/navigation/workflows console replacing the shipped one, plus the de-terminology layer a customer-form page needs | — |
| [`tool-agent-team`](tool-agent-team/README.md) | Nine tools that let the model create, message, and coordinate teammates | registers scoped tools on `ctx.tools` |
| [`vue-ui-poc`](vue-ui-poc/README.md) | Feasibility probe: a Vue 3 component hosted in a React slot through a thin bridge | — |
| [`vue2-echarts-poc`](vue2-echarts-poc/README.md) | Component library: an ECharts bar chart written as a Vue 2.7 component, bridged into React | — |
| [`vue2-echarts-tool-poc`](vue2-echarts-tool-poc/README.md) | The `show_chart` tool: the model hands over an ECharts option, and the browser's render verdict returns in the tool result | registers `show_chart` on `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.md) | Builds the gzip-compressed VFS image consumed by the browser worker preview | library and CLI — no ctx key |
| [`webworker-runtime`](webworker-runtime/README.md) | Runs the harness plugin tree inside a dedicated browser worker | library and worker entry — no ctx key |

-----

<a id="related-documentation"></a>
## Related documentation

- [Experimental package decision](../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.md) — placement, release exclusion, and dependency isolation.
- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [Experimental subtree rules](AGENTS.md) — what experimental status does and does not relax.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
