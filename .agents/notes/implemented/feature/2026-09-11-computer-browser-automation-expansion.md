# Agent Note: Computer and browser automation expansion

Status: implemented

English | [中文](2026-09-11-computer-browser-automation-expansion.zh.md)

This decision extends the seams defined by [Computer-use capability seam](../architecture/2026-09-06-computer-use-capability-seam.md) and [Browser capability seam](../architecture/2026-09-06-browser-capability-seam.md). Those records continue to own provider selection, grants, attachment fencing, and the CDP relay. [Autonomous browser and computer tools](2026-09-13-autonomous-browser-computer-tools.md) later supersedes this note's approval-default and title-independent-id facts; discovery, frames, downloads, and presentation here remain current.

## Problem

The shipped desktop and browser tools could list apps and tabs, take a snapshot, click, type, and inspect network traffic, but they could not tell a caller whether the backend was configured or actually live, observe a window with bound geometry, invoke accessibility actions the native helper already supported, drive an iframe, or wait for a download to finish. Callers retried successful input when a later observation failed, stored screenshot bytes in replay metadata, and guessed a replacement window by title when the original vanished.

## Decision

Keep the work in the existing capability services, providers, and tool consumers. Do not change the agent loop, default enablement, or approval policy.

**Discovery.** `computer_status` and `browser_status` are read-only. They distinguish `available()` from a bounded live probe (`permissions()` / `listTabs()`), list supported operations, and return recovery copy for missing providers, disconnected Chrome, denied permissions, and unsupported facets. Tools stay registered when the selected provider is down.

**Desktop observation and action.** `computer_snapshot.maxDepth` and a current snapshot ref select a subtree. Nodes advertise states and actions. `computer_observe` returns the tree plus an optional screenshot attachment with pixel size, logical bounds, and scale. Screenshot-space coordinates bind to an observation id, are mapped through the same pixel dimensions the result declares, and fail with `COMPUTER_GEOMETRY_CHANGED` when bounds or title changed. `computer_action` runs advertised `activate` / `toggle` / `select` / `expandCollapse` / `setValue`. Drag endpoints accept refs or coordinates; click, scroll, and drag share modifiers. `computer_wait_for` waits for text disappearance and node states. After input, a fresh observation is attempted; if it fails, the tool returns `observationError` instead of asking the caller to repeat the input. Window identity is `pid:title` when the native adapter reports no `nativeId`; vanished or ambiguous targets fail.

**Frames, drag, and downloads.** `browser_frames` lists documents. Snapshot, text, evaluate, and wait accept an optional `frameId` (default: main frame). Stored refs carry frame identity; click, type, select, upload, and hover route through that frame's CDP session, including flattened OOPIF sessions from `Target.setAutoAttach`. A URL several attached iframes share is resolved by asking each candidate session which frame its own tree roots at, so input never routes to a same-URL sibling. Navigation and detach clear stored observations. `browser_drag` uses trusted pointer events and requires both endpoints in the same frame, counting raw viewport coordinates as main-frame coordinates. Download ids are branded strings. `browser_wait_for_download` polls an explicit id and returns the local path without reading the file; interruption is `BROWSER_DOWNLOAD_INTERRUPTED`.

**Presentation.** Replay cards persist target identity and observation errors; the tool name is the operation, so meta carries no separate field. Screenshot bytes never enter `presentationMeta`, and the browser preview stays a live capture rather than a stored attachment. New conversation rows register through existing locale dictionaries.

## Alternatives considered

**Title-independent window ids.** Rejected: the native adapter has no stable window identifier, so guessing a replacement would silently retarget.

**Per-frame snapshot epochs without bumping the tab.** Rejected for the first cut: bumping the tab epoch on `Page.frameNavigated` / `Target.detachedFromTarget` fails stale refs instead of serving a mixed-generation tree.

**Cross-frame drag.** Rejected: trusted pointer coordinates are frame-local; cross-frame drag needs a later hit-test design.

**Putting screenshot bytes in `presentationMeta` for the preview dock.** Rejected: session logs would retain unbounded images. The dock already captures a live preview; legacy logs that still store base64 remain readable.

**A `network` or `frames` provider facet.** Rejected: frames and downloads reuse CDP and the existing downloads facet; no provider implements a separate transport.

## Consequences

macOS is the first fully validated desktop platform. `dsh-base` still ships both tool suites `enabled: false`. OCR, persistent always-allow grants, workflow recording, other browser engines, and native window management stay deferred. Title-independent window ids stay deferred when the addon reports no `nativeId`.

Callers can complete desktop form interactions, iframe workflows, and download-to-upload handoffs with observable results and no silent retargeting. The cost is additional schemas, status probes on discovery, and CDP auto-attach for child targets.

## Testing

`packages/computer-use/*/tests` cover status (configured vs live vs probe-failed), observation geometry, advertised actions, drag refs, wait-for disappearance and node state, screenshot-space mapping through the declared pixel dimensions, accurate node-budget truncation, and partial `observationError`. `packages/browser/*/tests` cover status, flattened child sessions, same-URL iframe binding, `downloads.get`, frame listing and child snapshots, same-frame drag (including a child-frame ref paired with main-frame coordinates), stale refs after navigation, interrupted and timed-out downloads, and presentation meta without screenshot bytes. Conversation row tests register the new tool names. Recorded-session snapshots that embed tool schemas need a refresh when this ships.
