# Agent Note: Browser capability seam — Native Messaging host and declarative browser_* tools

Status: implemented

[English](2026-09-06-browser-capability-seam.md) | 中文

## Problem

harness 需要模型驱动用户真实、已登录的 Chrome——已有标签页、cookie 和会话——而不是启动单独的浏览器 profile。Playwright 自有的 profile 看不到这些会话。伸进扩展的 loopback WebSocket 会增加一个监听 TCP 端口。Codex 风格的 JavaScript REPL 会绕过 `ctx.tools`、presenter、快照和 PTC 模式。

传输必须能在 Chrome 启动 native host 后存活，而且 host 不能和应用抢同一个套接字。Codex 已知的失败模式（应用和 host 各自在不同套接字上监听）是要避免的缺陷。

## Decision

浏览器访问是一等能力 seam：

1. `@deepseek-ai/dsh-browser` 拥有 `ctx.browser`、提供方注册、按 owner 限定的附件和 `BrowserError`。
2. `@deepseek-ai/dsh-browser-chrome-extension` 是随附提供方：瘦 MV3 扩展、在 `$DSH_HOME/browser/host.sock`（或 Windows named pipe）上**监听**的 Node native host，以及惰性套接字客户端。Chrome Native Messaging 是带 4 字节小端长度前缀的 stdio。dsh **连接**；host 从不回连。
3. `@deepseek-ai/dsh-tool-browser` 拥有声明式 `browser_*` 工具、快照构建器、审批门控、presenter 和 `tool:browser` 提示词段落。

提供方不注册工具。`dsh-tool-browser` 是面向模型名称的唯一所有者。host 断开时工具仍保持注册，执行时以 `BROWSER_NOT_CONNECTED` 失败。`dsh-base` 挂载这三行，并把 `tool-browser.enabled` 设为 `false`，以便默认快照工具列表保持稳定，直到产品 overlay 在 `dsh browser install` 之后打开这些工具。

页面逻辑（快照、点击、输入）留在 host/工具侧，通过原始 CDP 完成。扩展只中继 `chrome.debugger` 和 Chrome API。从不抑制 Chrome 的调试横幅。智能体标签页会被分组。

安全不变量保持固定：套接字目录 `0700`、套接字 `0600`、无监听 TCP 端口、ref 通过 backendNodeId 映射解析、`allowRawCdp` 默认 false。

## Alternatives considered

### 伸进扩展的 loopback WebSocket

否决。本机上的监听 TCP 端口比 `$DSH_HOME` 下的 unix socket / named pipe 攻击面更大，而且仍然需要用户保持加载的 Chrome 侧监听器。

### Playwright（或其他自动化 profile）

否决作为本能力。单独的 profile 看不到用户已登录的标签页、cookie 或会话。Playwright 仍可用于测试，以及想要隔离浏览器的产品。

### 以 Codex 风格的 JavaScript REPL 作为模型接口

否决。REPL 绕过 `defineTool`、presenter、快照转录和 PTC 模式。声明式 `browser_*` 工具适配 `ctx.tools`，并让页面内容可从会话日志重建。

### 应用监听，host 连接

否决。那就是 Codex 套接字不匹配的失败模式：如果双方都认为自己应监听，就没有人连接。Native host 监听，因为是 Chrome 启动它；每个 dsh 客户端连接到已知路径。

## Consequences

**在出现 Web Store id 之前，安装保持手动。** `dsh browser install` 写入 native-host 清单；用户仍需加载未打包扩展。

**默认组合不宣传 `browser_*`。** `dsh-base` 保持 `enabled: false`，因此每个默认快照 class 不会增加二十个工具。产品在安装后打开这些工具。

**Owner 围栏是对象身份。** 两个具有相同会话 id 的 `Agent` 值不共享附件。

**大型截图在 native-messaging 管道上分块，并在超过 `screenshotMaxBytes` 时从模型输出中省略。**
