# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `content-column/` | Browser half of the content surface: claims the shell's content column, lists the session's entries, and dispatches the selected one by kind | — |
| `content-frame/` | Serves one operator-configured static web application and contributes it as the content column's `page` kind | — |
| `content-surface/` | Host half of the content surface: extractors fold logged events into a per-session stream of typed content entries | `ctx.contentSurface` |
| `server-layout/` | Service-line shell: a permanent four-track frame (session, content, chat, details) replacing the shipped one | `ctx.layout` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| `vue-ui-poc/` | Feasibility probe: a Vue 3 component hosted in a React slot through a thin bridge | — |
| `vue2-echarts-poc/` | Component library: an ECharts bar chart written as a Vue 2.7 component, bridged into React | — |

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.
