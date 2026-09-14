# Agent Note: Autonomous browser and computer tools

Status: implemented

English | [中文](2026-09-13-autonomous-browser-computer-tools.zh.md)

This decision partially supersedes [Computer and browser automation expansion](2026-09-11-computer-browser-automation-expansion.md) for approval defaults and native-id window identity. Discovery, frames, downloads, and presentation in that note remain current. The seams in [Computer-use capability seam](../architecture/2026-09-06-computer-use-capability-seam.md) and [Browser capability seam](../architecture/2026-09-06-browser-capability-seam.md) still own provider selection, grants, attachment fencing, and the CDP relay.

## Problem

Default `apps` / `user-tabs` approval stopped unattended workflows even when the host already authorized the Chrome tab or the OS helper. Snapshot refs used a per-tab epoch, so a filter or pagination could rebind an old "Save" ref onto a newer "Delete" node. Screenshot-space clicks fell back to unrelated geometry. Desktop typing did not verify the foreground window. Accessibility press ran for every click, including right-click and modifiers. Linux X11 treated a missing hit-test as success. Console capture armed after `Runtime.enable`, so the first errors were lost.

## Decision

Both tool plugins and the `dsh-base` rows default to `approval: never`. `dsh-base` still ships `enabled: false`. `user-tabs`, `apps`, `always`, and explicit overlays remain selectable. In `never` mode the prompts do not tell the model to ask, and computer tools grant session app access internally, including clipboard-first writes.

Every fresh snapshot or screenshot mints a unique numeric observation id. Refs are `${observationId}-eN` and bind to that observation, owner, target, and browser frame. Filtering or paginating a capture is a view of `allNodes` and keeps the same refs. Navigation, frame detach, window destruction, reconnect, and dispose clear stored observations. An expired ref never resolves against a newer capture.

Browser input serializes per tab; desktop input serializes on the shared keyboard and pointer. Accessibility press is used only for an ordinary unmodified single left-click. Targeting that cannot be established fails before dispatch. After dispatch, a failed follow-up observation returns `observationError` and does not replay the action.

Browser clicks, typing, fill, hover, select, and drag wait for attached, visible, enabled or editable, stable, unobstructed geometry. CDP viewport coordinates include same-process frame offsets and transforms; hit-testing also rejects overlays in ancestor documents. Child-frame execution contexts are resolved for text, evaluate, select, and waits. `browser_fill` replaces a field; `browser_type` inserts. Clicks accept button, count, and named modifiers. Scroll uses a ref, coordinates, or the viewport center. Waits return `matched` and `timedOut`. Screenshots are attachments and emit image blocks only on image-capable routes. Console listeners install before `Runtime.enable`. Text defaults are 100 KB, 2,000 characters per snapshot field, and 200 console entries.

Desktop screenshot-space input requires the exact observation id and that capture's stored geometry. The attachment store owns screenshot sizing; reported scale is delivered pixels over logical bounds. `computer_focus_element`, `computer_set_window_bounds`, and `computer_displays` are registered. Keys support `press` / `down` / `up`; held keys are tracked per owner and released on turn stop, dispose, cancel, and helper failure. Typing verifies foreground focus. The simulang Linux path resolves its native accessibility hit node to a window through ancestry; an undefined hit is `COMPUTER_TARGET_MISMATCH`. Fresh text observations never inherit screenshot geometry. Snapshot and screenshot text carries the observation id, and browser wait text carries the matched and timeout outcomes.

When simulang reports `nativeId`, provider window ids are opaque `wN` values fenced by helper lifetime. Title changes keep the id; a destroyed then recreated native handle mints a new id. Builds without `nativeId` keep `<pid>:<title>`. Optional `setBounds`, `screens()`, `windowByNativeId`, and tree `focus` are used when present. Published v13 lacks native window ids, resizing, and tree focus; resizing fails `COMPUTER_UNSUPPORTED`, while element focus falls back to a pointer click. Native snapshot traversal remains unbounded; mapping limits apply after capture. This change does not pin a forked simulang binary.

`SESSION_FORMAT_VERSION` is unchanged.

## Alternatives considered

**Keep `apps` / `user-tabs` as the shipped default.** Rejected because unattended runs then require approval or user-question services that deployments often omit, and the model prompt still told it to ask before authorized actions.

**Pin a patched simulang binary with required native window APIs.** This remains required work, blocked by access to upstream’s private `simulang-rs-internal` dependency. Optional adapter methods do not complete that work; a reproducible native build and macOS, Windows, and Linux verification remain outstanding.

**Fall back screenshot-space clicks to screen coordinates or the latest cached shot.** Rejected because that silently retargets after a move, resize, or display-layout change.

**Auto-retry an action when the follow-up observation fails.** Rejected because the action may already have completed.

## Consequences

Default composition completes mutating browser and computer calls with no approval service mounted. Operators who still want a confirmation overlay set `approval` explicitly. Window ids are title-stable only when the addon reports `nativeId`. Wayland input remains unsupported. Screenshot bytes still never enter `presentationMeta`.

## Testing

`packages/browser/tool-browser/tests` cover observation-scoped refs, fill vs type, named click modifiers, wait `matched`/`timedOut`, console arming, actionability failure, and a Loader boot that opens a tab with default `never` and no approval service. `packages/computer-use/*/tests` cover held keys, `COMPUTER_INPUT_BUSY`, unfocused typing, undefined hit-test mismatch, nativeId-stable ids, Linux X11 listing, delivered screenshot scale, screenshot-space requiring the exact observation id, and a Loader launch with no approval or user-question service. Conversation rows register `browser_fill`, `computer_displays`, `computer_focus_element`, and `computer_set_window_bounds`. Header-pinned session snapshots `browser-tabs`, `computer-apps`, and `computer-screenshot-text-only` refresh tool schemas and prompt sections.
