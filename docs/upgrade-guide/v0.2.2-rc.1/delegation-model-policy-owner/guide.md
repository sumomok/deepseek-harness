---
kind: upgrade-guide
description: "Custom delegation compositions with model selection or discovery require the model-selection settings service."
---

# Model-selectable delegation requires the policy service

English | [中文](guide.zh.md)

## Change

Custom compositions enabling `modelSelection` or `modelDiscovery` on `@deepseek-ai/dsh-tool-subagent` require `@deepseek-ai/dsh-tool-subagent/model-selection-settings`. Previously the tool could read recorded authorization without that service. The service now owns policy reads for both ordinary delegation and Agent Teams. Tool installation fails when the required service is unavailable.

Compositions leaving both options disabled are unchanged. Base-backed profiles mount the service, including Web, Desktop, and headless. Custom trees that already insert this row alongside `dsh-base` must remove their duplicate insertion and retain any config override by id. Existing Session authorization remains unchanged; settings edits apply only to new top-level Sessions.

`SpawnTeammateRequest` now includes Host Agent options and is exported from `@deepseek-ai/dsh-experimental-agent-team` instead of its Client-shared `/types` entry. TypeScript consumers must import this type from the main package entry.

## Migration

1. Mount the settings plugin before enabling model selection or discovery in your custom composition:

   ```yaml
   - id: subagent-model-selection-settings
     name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
     config:
       enabled: false
       allowedModels: []
   ```

2. To authorize alternative models, set `enabled: true` and list their exact `{ provider, model }` pairs in `allowedModels`, then create a new top-level Session. With `enabled: false`, explicit selection remains restricted to the parent's route.
3. For Agent Teams, enable `modelSelection: true` and `modelDiscovery: true` on the Team tool plugin. One tool per scope owns discovery; Team tools own their Agent scope and shadow inherited discovery.
4. Call `list_subagent_models` in the new Session and confirm that its results match the authorized routes. Create a child with a returned provider/model pair and check its model before continuing work. See the [delegation reference](../../../../packages/subagent/tool-subagent/README.md) for parameter rules and the [Team tools reference](../../../../packages/experimental/tool-agent-team/README.md) for teammate creation.
