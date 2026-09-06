---
description: "浏览器能力系列的包地图：Chrome 标签页服务、Native Messaging 提供方，以及面向模型的 browser_* 工具。"
kind: "package-group"
---

# browser/ — 浏览器能力系列

[English](README.md) | 中文

## 摘要

`browser/` 组让 harness 驱动用户真实的 Chrome——已有标签页、cookie 和登录态——通过一个与提供方无关的服务（`ctx.browser`）以及使用它的 Native Messaging 后端和工具。部署挂载 Chrome 扩展提供方和面向模型的工具；服务挑选可用提供方，因此 `browser_*` 名称保持稳定，传输留在提供方之后。三个包拆分该系列：`browser/` 服务拥有提供方选择、按 owner 限定的附件和错误；`browser-chrome-extension/` 通过 Native Messaging 和本地套接字通信；`tool-browser/` 向模型暴露 `browser_*`。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发笔记](#dev-note)

-----

<a id="packages"></a>
## 包

三个包承担浏览器角色；子系统参考页拥有完整类型。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`browser/`](browser/README.zh.md) | 浏览器服务：通过可替换后端提供标签页、附件和 CDP | `ctx.browser` |
| [`browser-chrome-extension/`](browser-chrome-extension/README.zh.md) | 通过 Native Messaging host 中继 Chrome DevTools Protocol | 注册到 `ctx.browser` |
| [`tool-browser/`](tool-browser/README.zh.md) | 向模型暴露 `browser_*` | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [浏览器子系统](../../docs/subsystems/browser.zh.md) — 提供方、标签页、CDP 请求和 `BrowserError`。
- [浏览器能力 seam 决策](../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.zh.md) — 为何由 native host 监听，以及工具保持声明式。
- [安装 Chrome 浏览器工具](../../docs/user/guide/browser.zh.md) — 用户安装步骤。

<a id="dev-note"></a>
## 开发笔记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

在出现 Web Store id 之前，扩展仍以未打包方式安装。`dsh-base` 中 raw CDP 默认关闭。

</details>
