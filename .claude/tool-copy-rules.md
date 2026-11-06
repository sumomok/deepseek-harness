# Tool copy rules

The fork's rules for the text a model reads about a tool. [`.claude/CLAUDE.md`](CLAUDE.md) links here.

## How your tool reaches the model

A tool is reachable only through the text a model reads about it, and a model that has decided what a tool is for does not read that text again: both sessions that abandoned `screenshot` had already called it once, with its full schema in front of them, before they spent about an hour each building their own browsers. **A parameter added without changing the description is not added** — the argument exists, and no call ever carries it. The description changes in the same commit as the parameter.

- **Write the description for the decision, not for the schema.** Say what the tool is good at and when to reach for it; the parameter list is already in front of the model, and repeating it there says nothing about when the tool is worth calling. A narrow framing narrows the use: `screenshot` described as a way to verify visual work against a reference was read as a CSS check for pages the agent had written itself, and never pointed at a live site.
- **Name the parameter in the failure that parameter would fix.** A failure message is the one piece of tool text a model reads while it is deciding what to do next, which makes it the cheapest place to recover a capability the description missed. A render that lands on a sign-in page answers `pass cookies or headers to capture it with a session` rather than only reporting that the page was not the one requested; a bound that was exceeded, a mode that was not used, and a path that may not be written to all read the same way.
- **A prompt section is the third place, and the most expensive.** `ctx.systemPrompt.section({ name, order, text })` contributes one — [`dsh-system-prompt`](../packages/core/system-prompt/README.md) owns the registry and tool guidance takes the `100–199` order band — and it is what the harness's own `Use the X tool` lines are; a tool that registers none is named nowhere in the assembled prompt and is found only by reading schemas. That text costs context in every request of every turn, so registering one needs a reason recorded in an Agent Note. [The screenshot note](../.agents/notes/implemented/feature/2026-08-22-screenshot-session-and-output.md) is the worked example: one line for a tool two sessions on two platforms called once and then rebuilt out of proxies and file scavengers, which is a measured failure rather than an assumed one.

## 你的工具如何触达模型

模型能否用上一个工具，只取决于它读到的那段关于该工具的文字；而模型一旦认定某个工具的用途，就不会再读一遍：两次放弃 `screenshot` 的会话都已经调用过它一次，完整 schema 就摆在眼前，随后各自花了约一小时自建浏览器。**新增参数却不同时改描述，等于没有新增**——参数存在，却不会有任何一次调用带上它。描述与参数在同一个提交中一起改。

- **描述为决策而写，而不是复述 schema。** 说明这个工具擅长什么、何时该用它；参数列表本就在模型眼前，在描述里重复一遍并不能说明它什么时候值得调用。框定得越窄，用途就越窄：`screenshot` 的描述曾把它定位成对照参考图检查视觉工作，于是被读成对 agent 自己写的页面做 CSS 检查，从未被指向线上站点。
- **在失败信息里点名那个能解决问题的参数。** 失败信息是模型在决定下一步时唯一会读的工具文字，因此它是补回描述遗漏能力的最省成本的位置。落在登录页上的渲染回答 `pass cookies or headers to capture it with a session`，而不是只报告该页面不是所请求的那一个；被超出的上限、未被使用的模式、不允许写入的路径同理。
- **提示词 section 是第三处，也是最贵的一处。** `ctx.systemPrompt.section({ name, order, text })` 贡献一条——[`dsh-system-prompt`](../packages/core/system-prompt/README.zh.md) 拥有该注册表，工具指引使用 `100–199` 的 order 区间——harness 自带工具的那些 `Use the X tool` 行正是这样来的；不注册 section 的工具在组装出的系统提示词里不会被提及，只能靠读 schema 才能找到。这段文字在每一轮的每次请求中都占用上下文，因此注册它需要一条记录在 Agent Note 中的理由。[screenshot Agent Note](../.agents/notes/implemented/feature/2026-08-22-screenshot-session-and-output.zh.md) 就是范例：为一个在两个平台上被两个会话各调用一次、随后用代理和文件搜刮脚本重建的工具加一行；这是实测到的失败，而不是假设出来的失败。
