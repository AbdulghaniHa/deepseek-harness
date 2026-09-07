# Agent Note: Computer-use capability seam — crash-isolated helper and declarative computer_* tools

Status: implemented

English | [中文](2026-09-06-computer-use-capability-seam.zh.md)

Related: [Browser capability seam](2026-09-06-browser-capability-seam.md) (same three-role pattern; different observation surface).

## Problem

The harness needs the model to drive GUI applications that have no CLI, API, or browser path. Default DeepSeek routes are text-only (`deepseek-v4-flash` / `v4-pro` declare `inputModalities: ['text']`), so screenshots cannot be the primary observation primitive. An in-process native addon would crash the agent process. A Codex-style MCP computer-use server would bypass `ctx.tools`, presenters, snapshots, and PTC mode.

OS permission prompts (macOS Accessibility and Screen Recording) must belong to the same responsible process as `dsh`, and the helper must not open a listening TCP port.

## Decision

Computer use is a first-class capability seam, matching the browser family:

1. `@deepseek-ai/dsh-computer-use` owns `ctx.computer`, provider registration, per-owner app grants, the fixed deny list, coordinate hit-testing, and `ComputerError`.
2. `@deepseek-ai/dsh-computer-use-local` is the shipped provider id `local`. It spawns `lib/host.js` through `ctx.subprocess` and speaks newline-delimited JSON-RPC over stdio. The helper loads `@simular-ai/simulang-js` when present and otherwise uses an OS fallback (`osascript` / `screencapture` on macOS). A crash fails the in-flight call with `COMPUTER_HOST_CRASHED`; the next call starts a new helper.
3. `@deepseek-ai/dsh-tool-computer-use` owns the declarative `computer_*` tools, snapshot refs (`epoch-eN`), screenshot attachments via `ctx.attachments.saveImage`, approval/grants, presenters, and the `tool:computer` prompt section (`TOOL_COMPUTER: 2160`).

Providers do not register tools. Tools stay registered when the helper is down and fail at execution with a structured `ComputerError`. `dsh-base` mounts the three rows and sets `tool-computer-use.enabled` to `false`.

Primary observation is the accessibility-tree snapshot. Screenshots are gated with an `assertImageCapableRoute` equivalent and never put PNG bytes in JSON values or `presentationMeta`.

Phase 0 compared `@simular-ai/simulang-js` (window-bound `AccessibilityTree` with `refId`s) against `@crowecawcaw/xa11y` (locator/selector model). Simulang matches snapshot-ref tools; xa11y does not. The provider interface hides the library, and the OS fallback keeps unit tests and `dsh computer doctor` working without the native addon or TCC.

Security invariants stay fixed: deny terminal apps and the harness pid, hit-test coordinate actions, redact secure AX fields, stdio-only helper, no listening TCP port.

## Alternatives considered

### In-process napi addon

A crash in the native library would take down the agent process. The helper isolates that fault to `COMPUTER_HOST_CRASHED`.

### Playwright or xdotool

Playwright drives a browser, not arbitrary GUI apps. xdotool is X11-only and has no accessibility tree.

### Hand-rolled Swift helper

Would duplicate a maintained MIT library across six native targets. Simulang plus the OS fallback covers CI and doctor without that cost.

### Codex-style MCP computer-use server

Would bypass `ctx.tools`, presenters, snapshots, PTC mode, and session events.

## Consequences

`dsh computer doctor [--request]` probes permissions without booting Cordis. App grants are session-scoped in this change; persistent always-allow via `ctx.settings` is Phase 2. Windows is foreground-only. Wayland input is unsupported. Default text-only routes refuse `computer_screenshot` and point at `computer_snapshot`.
