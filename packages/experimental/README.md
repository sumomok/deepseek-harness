---
description: "The experimental group map: publicly installable pre-stable prototypes."
kind: "package-group"
---

# packages/experimental

English | [中文](README.zh.md)

## Summary

Experimental prototypes may change their contracts and carry no support promise. New packages publish by default; private packages must also appear in the [private-exception list](../../scripts/experimental-package-policy.ts). All current packages publish under their `@deepseek-ai/dsh-experimental-*` names, including the opt-in Agent Teams composition, Auto review, Cua Driver providers, browser-use backends, cross-realm Inspector, CPython PTC backend, and browser-worker preview libraries. Released products outside this group must not depend on experimental packages. The dsh installation ships the Agent Teams, voice input, and Auto review packages as optional bundles switched on from the Web sidebar's Plugins page ([decision](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)); the other packages are libraries or explicit compositions.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`speech-to-text`](speech-to-text/README.md) | Named speech recognition providers | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.md) | Managed local SenseVoice inference | — |
| [`api-speech-to-text`](api-speech-to-text/README.md) | Authenticated transient transcription Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.md) | Microphone capture and guarded draft insertion | — |
| [`voice-input-bundle`](voice-input-bundle/README.md) | Default-disabled optional voice input composition | — |
| [`agent-team-profile`](agent-team-profile/README.md) | Agent Teams collaboration, tools, and Web UI bundle | — |
| [`agent-team`](agent-team/README.md) | Named teammates with durable messages and a shared task board | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.md) | Team roster, task board, and teammate navigation for Web | — |
| [`auto-review`](auto-review/README.md) | Explicit Web layer for same-model review before each native or PTC inner tool call | — |
| [`claude-code-mods`](claude-code-mods/README.md) | Run Claude Code mods as plugins: their hook chains on harness extension points and a band above the prompt | `ctx.claudeCodeMods` |
| [`client-ui-claude-code-mods`](client-ui-claude-code-mods/README.md) | The Web band that draws a mod's tree above the prompt and sends button clicks back | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.md) | CPython subprocess backend for the PTC execution seam | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.md) | Use an installed Cua Driver through MCP | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.md) | Embed the Cua Driver native npm runtime | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.md) | Playwright browser tools over MCP | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and browser control over MCP | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.md) | Stagehand browser operations with explicitly configured native models | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.md) | Session-owned browser resources shared by experimental providers | — |
| [`auth-gate`](auth-gate/README.md) | Sends a browser without an access token to the deployment's login page, mirrors the one it returns with into a cookie, and injects it into forwarded MCP requests | — |
| [`biz-backend`](biz-backend/README.md) | Three reads of a deployment's own data backend, made with the visitor's own access token | `ctx.bizBackend` |
| [`component-kit`](component-kit/README.md) | Component row: the six components it registers into a placement package's catalog, each a host definition and the React renderer that draws it | — |
| [`component-surface`](component-surface/README.md) | The `show_component` tool and the content column's `component` kind: blocks from a fixed catalog, judged before anything is drawn | — |
| [`console-mcp`](console-mcp/README.md) | The console's MCP capability as one row: a deployment-owned list of Streamable HTTP servers reached under named credentials, idle while the list is empty | — |
| [`console-members`](console-members/README.md) | Types of the console member directory: which signed-in member a request, a Remote caller, or a Session belongs to, each member's roots, and per-member storage; registers no plugin | `ctx.consoleMembers` |
| [`console-profile`](console-profile/README.md) | The customer console as one bundle layer over the Web profile, plus the permission lock applied above the profile patch | — |
| [`content-column`](content-column/README.md) | Browser half of the content surface: claims the shell's content column, lists the session's entries, and dispatches the selected one by kind | — |
| [`content-frame`](content-frame/README.md) | Serves one operator-configured static web application and contributes it as the content column's `page` kind | — |
| [`content-surface`](content-surface/README.md) | Host half of the content surface: extractors fold logged events into a per-session stream of typed content entries | `ctx.contentSurface` |
| [`inspector`](inspector/README.md) | Cross-realm CDP hub for Host debugging, Client Runtime inspection, network capture, and Cordis trees | `ctx.inspector` |
| [`session-inspector`](session-inspector/README.md) | Sidebar tables for raw Session logs and Chat nodes | — |
| [`inspector-profile`](inspector-profile/README.md) | Optional Web bundle for Session log and Chat node inspection | — |
| [`library-skills`](library-skills/README.md) | Ships component-library conventions as bundled SKILLs mounted at the lowest skill rank | — |
| [`page-refresh`](page-refresh/README.md) | Reloads an open page once when its server comes back with a different build, and shows the page's connection state in one banner | — |
| [`server-base`](server-base/README.md) | Tells the browser whether reaching the served page means owning the Host behind it, and carries the nginx sample for a prefixed console | — |
| [`server-layout`](server-layout/README.md) | Service-line shell: a permanent four-track frame (session, content, chat, details) replacing the shipped one | `ctx.layout` |
| [`server-sidebar`](server-sidebar/README.md) | Product console sidebar: a fixed workbench/navigation/workflows console replacing the shipped one, plus the de-terminology layer a customer-form page needs | — |
| [`skill-pack`](skill-pack/README.md) | Skill provider for a pack root: a pack is offered only once every component plugin part its views place is registered | `ctx.skillPacks` |
| [`skill-pack-components`](skill-pack-components/README.md) | The adapter a deployment composes between the two: it publishes the components this deployment offers as the parts a pack requires | — |
| [`system-map`](system-map/README.md) | Three reads of the deployment's own data-model configuration, filtered by the signed-in person's rights | registers tools on `ctx.tools` |
| [`tool-agent-team`](tool-agent-team/README.md) | Nine tools that let the model create, message, and coordinate teammates | registers scoped tools on `ctx.tools` |
| [`vue-ui-poc`](vue-ui-poc/README.md) | Feasibility probe: a Vue 3 component hosted in a React slot through a thin bridge | — |
| [`vue2-echarts-poc`](vue2-echarts-poc/README.md) | Component library: an ECharts bar chart written as a Vue 2.7 component, bridged into React | — |
| [`vue2-echarts-tool-poc`](vue2-echarts-tool-poc/README.md) | The `show_chart` tool: the model hands over an ECharts option, and the browser's render verdict returns in the tool result | registers `show_chart` on `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.md) | Builds the gzip-compressed VFS image consumed by the browser worker preview | library and CLI — no ctx key |
| [`webworker-runtime`](webworker-runtime/README.md) | Runs the harness plugin tree inside a dedicated browser worker | library and worker entry — no ctx key |

-----

<a id="related-documentation"></a>
## Related documentation

- [Experimental publication reference](../../scripts/experimental-package-policy.ts) — public defaults and private exceptions.
- [Computer use](../../docs/subsystems/computer-use.md) — desktop provider choices.
- [Browser use](../../docs/subsystems/browser-use.md) — browser provider choices and Session ownership.
- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [Experimental subtree rules](AGENTS.md) — what experimental status does and does not relax.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
