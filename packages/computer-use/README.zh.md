---
description: "电脑操控能力系列的包地图：桌面服务、崩溃隔离的本地 helper，以及面向模型的 computer_* 工具。"
kind: "package-group"
---

# computer-use/ — 电脑操控能力系列

[English](README.md) | 中文

## 摘要

`computer-use/` 组让 harness 通过一个与提供方无关的服务（`ctx.computer`）以及使用它的本地 helper 和工具来驱动 GUI 应用。部署会挂载本地提供方和面向模型的工具；服务选出一个可用提供方，使 `computer_*` 名称保持稳定，同时原生传输留在提供方之后。三个包分担该系列：`computer-use/` 服务拥有提供方选择、授权、拒绝列表、命中测试和错误；`computer-use-local/` 通过崩溃隔离 helper 讲 JSON-RPC；`tool-computer-use/` 向模型暴露 `computer_*`。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个包扮演电脑操控角色；子系统参考拥有完整类型。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`computer-use/`](computer-use/README.zh.md) | 电脑操控服务：通过可替换后端提供应用、窗口、授权和命中测试 | `ctx.computer` |
| [`computer-use-local/`](computer-use-local/README.zh.md) | 通过 stdio helper 中继无障碍、输入和捕获 | 注册到 `ctx.computer` |
| [`tool-computer-use/`](tool-computer-use/README.zh.md) | 向模型暴露 `computer_*` | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [电脑操控子系统](../../docs/subsystems/computer-use.zh.md) — 提供方、窗口、快照节点、截图请求和 `ComputerError`。
- [电脑操控能力 seam 决策](../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.zh.md) — 为何 helper 崩溃隔离，以及快照为何是主观察。
- [驱动 GUI 应用](../../docs/user/guide/computer-use.zh.md) — 权限与启用 overlay。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`dsh-base` 将 `enabled` 设为 `false`。持久 always-allow 属于 Phase 2。

</details>
