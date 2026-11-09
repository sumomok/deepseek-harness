---
kind: upgrade-guide
description: "启用模型选择或发现的自定义委派组合需要挂载模型选择设置服务。"
---

# 可选择模型的委派需要策略服务

[English](guide.md) | 中文

## 变更

在 `@deepseek-ai/dsh-tool-subagent` 上启用 `modelSelection` 或 `modelDiscovery` 的自定义组合需要挂载 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`。此前工具可以在没有该服务时读取已记录的授权。现在由该服务统一负责普通委派和 Agent Teams 的策略读取。所需服务不可用时，工具安装会失败。

两个选项都关闭的组合保持原样。基于 base 的 profile 挂载该服务，包括 Web、Desktop 和 headless。已在 `dsh-base` 之外自行插入此行的自定义组合须移除重复插入，并按 id 保留配置覆盖。现有 Session 的授权保持不变；设置变更仅作用于新建的顶层 Session。

## 迁移

1. 在自定义组合中启用模型选择或发现之前，挂载设置插件：

   ```yaml
   - id: subagent-model-selection-settings
     name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
     config:
       enabled: false
       allowedModels: []
   ```

2. 要授权其他模型，请设置 `enabled: true`，在 `allowedModels` 中列出精确的 `{ provider, model }` 对，然后新建顶层 Session。`enabled: false` 时，显式选择仍限于父 Agent 的路由。
3. 对于 Agent Teams，在 Team 工具插件上启用 `modelSelection: true` 和 `modelDiscovery: true`。每个作用域由一个工具拥有发现功能；Team 工具拥有各自 Agent 作用域的发现功能，并遮蔽继承的发现工具。
4. 在新 Session 中调用 `list_subagent_models`，确认结果与授权路由一致。使用返回的 provider/model 对创建子 Agent，并在继续工作前检查其模型。参数规则见[委派参考](../../../../packages/subagent/tool-subagent/README.zh.md)，成员创建见 [Team 工具参考](../../../../packages/experimental/tool-agent-team/README.zh.md)。
