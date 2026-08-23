# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `content-frame/` | Serves one operator-configured static web application and shows it in the service-line shell's content column | — |
| `server-layout/` | Service-line shell: a permanent four-track frame (session, content, chat, details) replacing the shipped one | `ctx.layout` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| `vue-ui-poc/` | Feasibility probe: a Vue 3 component hosted in a React slot through a thin bridge | — |
| `vue2-echarts-content-poc/` | Placement: puts the Vue 2.7 ECharts panel in the service-line shell's content column | — |
| `vue2-echarts-poc/` | Component library: an ECharts bar chart written as a Vue 2.7 component, bridged into React | — |

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.
