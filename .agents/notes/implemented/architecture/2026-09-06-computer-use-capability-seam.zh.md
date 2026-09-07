# Agent Note: 电脑操控能力 seam — 崩溃隔离 helper 与声明式 computer_* 工具

Status: implemented

[English](2026-09-06-computer-use-capability-seam.md) | 中文

相关：[浏览器能力 seam](2026-09-06-browser-capability-seam.zh.md)（同一三角色模式；观察面不同）。

## 问题

Harness 需要模型驱动没有 CLI、API 或浏览器路径的 GUI 应用。默认 DeepSeek 路由是纯文本（`deepseek-v4-flash` / `v4-pro` 声明 `inputModalities: ['text']`），因此截图不能作为主观察原语。进程内原生 addon 会拖垮 agent 进程。Codex 风格的 MCP computer-use 服务器会绕过 `ctx.tools`、presenters、snapshots 和 PTC 模式。

操作系统权限提示（macOS 辅助功能与屏幕录制）必须属于与 `dsh` 相同的责任进程，helper 不得打开监听 TCP 端口。

## 决策

电脑操控是一等能力 seam，对齐浏览器系列：

1. `@deepseek-ai/dsh-computer-use` 拥有 `ctx.computer`、提供方注册、按 owner 的应用授权、固定拒绝列表、坐标命中测试和 `ComputerError`。
2. `@deepseek-ai/dsh-computer-use-local` 是已发布提供方，id 为 `local`。它通过 `ctx.subprocess` 启动 `lib/host.js`，并在 stdio 上使用换行分隔的 JSON-RPC。helper 在可用时加载 `@simular-ai/simulang-js`，否则使用操作系统回退（macOS 上的 `osascript` / `screencapture`）。崩溃会使进行中的调用失败并返回 `COMPUTER_HOST_CRASHED`；下一次调用会启动新 helper。
3. `@deepseek-ai/dsh-tool-computer-use` 拥有声明式 `computer_*` 工具、快照 refs（`epoch-eN`）、通过 `ctx.attachments.saveImage` 的截图附件、审批/授权、presenters 以及 `tool:computer` 提示段落（`TOOL_COMPUTER: 2160`）。

提供方不注册工具。helper 宕机时工具仍保持注册，并在执行时以结构化 `ComputerError` 失败。`dsh-base` 挂载三行并将 `tool-computer-use.enabled` 设为 `false`。

主观察是无障碍树快照。截图用等价于 `assertImageCapableRoute` 的门控，且从不把 PNG 字节放入 JSON 值或 `presentationMeta`。

Phase 0 比较了 `@simular-ai/simulang-js`（带 `refId` 的窗口绑定 `AccessibilityTree`）与 `@crowecawcaw/xa11y`（locator/selector 模型）。Simulang 匹配 snapshot-ref 工具；xa11y 不匹配。提供方接口隐藏该库，操作系统回退让单元测试和 `dsh computer doctor` 在没有原生 addon 或 TCC 时也能工作。

安全不变量保持固定：拒绝终端应用和 harness pid、对坐标动作做命中测试、遮蔽安全 AX 字段、仅 stdio 的 helper、无监听 TCP 端口。

## 考虑过的替代方案

### 进程内 napi addon

原生库崩溃会带走 agent 进程。helper 把该故障隔离为 `COMPUTER_HOST_CRASHED`。

### Playwright 或 xdotool

Playwright 驱动浏览器，而不是任意 GUI 应用。xdotool 仅限 X11，且没有无障碍树。

### 手写 Swift helper

会在六个原生目标上重复维护 MIT 库。Simulang 加上操作系统回退覆盖 CI 和 doctor，无需该成本。

### Codex 风格 MCP computer-use 服务器

会绕过 `ctx.tools`、presenters、snapshots、PTC 模式和会话事件。

## 后果

`dsh computer doctor [--request]` 在不启动 Cordis 的情况下探测权限。本次变更中的应用授权是会话范围的；通过 `ctx.settings` 持久化 always-allow 属于 Phase 2。Windows 仅限前台。Wayland 输入不受支持。默认纯文本路由拒绝 `computer_screenshot` 并指向 `computer_snapshot`。
