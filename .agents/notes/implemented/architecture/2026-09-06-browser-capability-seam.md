# Agent Note: Browser capability seam — Native Messaging host and declarative browser_* tools

Status: implemented

English | [中文](2026-09-06-browser-capability-seam.zh.md)

## Problem

The harness needs the model to drive the user's real, logged-in Chrome — existing tabs, cookies, and sessions — without launching a separate browser profile. A Playwright-owned profile would miss those sessions. A loopback WebSocket into the extension would add a listening TCP port. A Codex-style JavaScript REPL would bypass `ctx.tools`, presenters, snapshots, and PTC mode.

The transport must survive Chrome launching the native host, and the host must not race the app for a socket. Codex's known failure mode (app and host each listening on different sockets) is the defect to avoid.

## Decision

Browser access is a first-class capability seam:

1. `@deepseek-ai/dsh-browser` owns `ctx.browser`, provider registration, owner-scoped attachments, and `BrowserError`.
2. `@deepseek-ai/dsh-browser-chrome-extension` is the shipped provider: a thin MV3 extension, a Node native host that **listens** on `$DSH_HOME/browser/host.sock` (or a Windows named pipe), and a lazy socket client. Chrome Native Messaging is stdio with a 4-byte LE length prefix. dsh **connects**; the host never connects back.
3. `@deepseek-ai/dsh-tool-browser` owns the declarative `browser_*` tools, snapshot builder, approval gating, presenters, and the `tool:browser` prompt section.

Providers do not register tools. `dsh-tool-browser` is the only owner of model-facing names. Tools stay registered when the host is disconnected and fail at execution with `BROWSER_NOT_CONNECTED`. `dsh-base` mounts the three rows and sets `tool-browser.enabled` to `false` so default snapshot tool lists stay stable until a product overlay turns the tools on after `dsh browser install`.

Page logic (snapshot, click, type) lives host-side / tool-side over raw CDP. The extension only relays `chrome.debugger` and Chrome APIs. Chrome's debugging banner is never suppressed. Agent tabs are grouped.

Security invariants stay fixed: socket dir `0700`, socket `0600`, no listening TCP port, refs resolved through a backendNodeId map, `allowRawCdp` default false.

## Alternatives considered

### Loopback WebSocket into the extension

Rejected. A listening TCP port on localhost is a broader attack surface than a unix socket / named pipe under `$DSH_HOME`, and it still needs a Chrome-side listener the user must keep loaded.

### Playwright (or another automation profile)

Rejected for this capability. A separate profile does not see the user's logged-in tabs, cookies, or sessions. Playwright remains available for tests and for products that want an isolated browser.

### Codex-style JavaScript REPL as the model interface

Rejected. A REPL bypasses `defineTool`, presenters, snapshot transcripts, and PTC mode. Declarative `browser_*` tools fit `ctx.tools` and keep page content reconstructable from the session log.

### App listens, host connects

Rejected. That is the Codex socket-mismatch failure mode: if each side believes it should listen, neither connects. The native host listens because Chrome launches it; every dsh client connects to the known path.

## Consequences

**Install stays manual until a Web Store id exists.** `dsh browser install` writes the native-host manifest; the user still loads the unpacked extension.

**Default compositions do not advertise `browser_*`.** `dsh-base` keeps `enabled: false` so every default snapshot class does not grow twenty tools. Products turn the tools on after install.

**Owner fencing is object identity.** Two `Agent` values with the same session id do not share attachments.

**Large screenshots are chunked on the native-messaging pipe and omitted from the model when they exceed `screenshotMaxBytes`.**

**Background operation and chat preview.** New tabs are inactive, and clicks do not call `Page.bringToFront`. The browser service serializes grouped opens per Agent and carries the preceding created tab as a group reference. Preview capture uses `Page.captureScreenshot` against the attached tab, with a configured decoded-byte limit and per-tab serialization. Settled screenshots live in tool-result metadata; one floating session-scoped preview above the composer follows the newest result that names a tab, and live refreshes use a session-scoped Remote call and never become model input. Reveal is a separate user action that activates the tab and focuses its window. A capture failure cannot invalidate a completed browser action. A dropped host socket reconnects on the next call, and a grouped create reports the tab as Chrome stored it after grouping. The real Chromium extension test verifies background input and foreground typing independently; minimized-window and operating-system focus behavior remain platform verification cases.
