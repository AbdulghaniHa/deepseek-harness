---
description: "浏览器服务（ctx.browser）：部署与插件作者如何通过可替换提供方驱动 Chrome 标签页，并共用一套选择策略和错误词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

[English](README.md) | 中文

## 概述

任何插件或工具都可以通过 `dsh-browser`（`ctx.browser`）列出标签页、附加并发送 CDP，而无需绑定 Chrome Native Messaging。提供方作为后端插入，服务挑选一个可用提供方，因此调用方不必跟踪背后运行的传输。在构建浏览器工具或其他后端时选择它；随附的面向模型工具（`dsh-tool-browser`）会自动挂载它。服务本身不发起 Chrome 调用，也不注册面向模型的工具：必须先挂载提供方，标签页或 CDP 调用才能运行。

聊天预览捕获已附加的标签页，不激活 Chrome。`previewMaxBytes` 限制解码后的 PNG 字节数（默认 `1000000`）；`previewIntervalMs` 设置可见实时预览的刷新间隔（默认 `2000` 毫秒）。同一标签页的捕获串行执行。会话作用域的 `browser.preview` 和 `browser.reveal` Remote 方法要求精确的存活 Agent 附加关系；reveal 委托给可选的提供方 `revealTab` 方法，仅用于用户明确操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要访问 Chrome 标签页的组合加载 `dsh-browser` 服务并至少挂载一个后端，然后插件或工具作者直接调用 `ctx.browser.listTabs()`、`attach()` 和 `cdp()`。服务为每次调用解析后端，因此除非配置了提供方 id，调用方看不到这些 id。

### 何时选择它

当插件或工具必须驱动 Chrome 且不能硬编码 Native Messaging 时选择该服务。只使用随附 `browser_*` 工具的部署通过 `dsh-tool-browser` 自动获得它。组合从不接触 Chrome 时不需要它。服务自身不增加浏览器访问：没有至少一个可用提供方时，每次调用都以结构化 `BrowserError` 失败。

### 最小配置

加载服务并让单个已挂载后端自动选择，或用 `provider` 钉住提供方 id。`$DSH_BROWSER_PROVIDER` 填入同一字段，不是单独的优先级链。

```yaml
- name: '@deepseek-ai/dsh-browser'
- name: '@deepseek-ai/dsh-browser-chrome-extension'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | （未设置） | 钉住的提供方 id；未设置时在恰好一个可用时自动选择 |
| `previewMaxBytes` | `1000000` | 聊天预览解码后 PNG 字节数上限 |
| `previewIntervalMs` | `2000` | 可见实时预览的刷新间隔，单位毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-browser)是每个已接受字段及其 JSDoc 的穷尽来源。

### 提供方选择

每次调用在执行时解析提供方，注册或加载顺序从不重要。已配置的提供方 id 在已注册且可用时获胜；未配置 id 时，服务运行唯一可用提供方，或明确失败，错误码为 `BROWSER_PROVIDER_UNAVAILABLE`、`BROWSER_PROVIDER_CONFIGURED_MISSING`、`BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE` 或 `BROWSER_PROVIDER_AMBIGUOUS`。

### 失败与恢复

失败抛出带稳定、可机器路由码的 `BrowserError`。调用方按码路由。未连接的 host 是 `BROWSER_NOT_CONNECTED`；已消失的标签页是 `BROWSER_TAB_GONE`；外 owner 附件是 `BROWSER_FOREIGN_ATTACHMENT`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`BrowserRuntime` 服务、提供方注册表和按 owner 限定的附件 |
| [`src/types.ts`](src/types.ts) | 请求/结果类型、品牌化 id 和 `BrowserError` 分类 |
| [`src/client.ts`](src/client.ts) | 浏览器安全的标签页 id 和聊天预览类型 |
| — | 不发布运行时不变式配套插件；附件映射是私有的，选择在每次调用时强制执行；seam 不发布独立的注册表或请求/结果观察流。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器子系统](../../../docs/subsystems/browser.zh.md) — 提供方、标签页、CDP 请求和错误码。
- [浏览器包地图](../README.zh.md) — 三包系列。
- [dsh-tool-browser](../tool-browser/README.zh.md) — 面向模型的 `browser_*` 工具。
- [浏览器能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.zh.md) — 为何由 native host 监听。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-browser`，它向模型渲染快照和截图，而本服务不贡献提示词或 schema。

#### KV Cache 影响

无直接失效；由具名消费方拥有任何请求前缀变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **无观察面** — 可用性只能通过执行调用并路由抛出的码来观察。
- **Chrome API 侧面是可选的** — 当所选提供方未声明 history、bookmarks、reading list 和 downloads 时，以 `BROWSER_FACET_UNAVAILABLE` 失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

附件按精确的 `Agent` 对象身份围栏，而不是会话 id 字符串相等。

</details>
