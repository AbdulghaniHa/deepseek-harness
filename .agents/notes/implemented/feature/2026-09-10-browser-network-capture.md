# Agent Note: Browser network capture

Status: implemented

English | [中文](2026-09-10-browser-network-capture.zh.md)

This decision adds a consumer of the relay defined by [Browser capability seam](../architecture/2026-09-06-browser-capability-seam.md). That record continues to own provider selection, attachment fencing, and the CDP relay; no active Agent Note is superseded.

## Problem

The browser tools could drive a tab and read what the page rendered, logged, or answered to `Runtime.evaluate`, but nothing exposed its HTTP traffic. An agent debugging a failing authenticated flow could see the final page state and console lines yet not which request returned `401`, which endpoint a click triggered, or what the API answered.

The transport already carried the data. Chrome emits `Network.*` events for a tab with the debugger attached, the extension forwards every `chrome.debugger` event, the native host broadcasts each one to connected clients, and `ctx.browser.onCdpEvent` fans them out. The one consumer was `browser_console` reading `Runtime.consoleAPICalled`, so network events reached the seam and were dropped.

## Decision

`dsh-tool-browser` registers `browser_network` and `browser_network_body`. Capture state lives in the tool consumer (`src/network.ts`), not in the `dsh-browser` seam.

**Arming.** Capture starts at a tab's first `browser_network` call. The tool sends `Network.enable` through `ctx.browser.cdp`, which enforces attachment ownership, and arms the tab only after Chrome accepts the command. A refused enable therefore leaves the tab unarmed and the next call retries, instead of reporting a silent empty capture.

**Buffer.** One bounded buffer per tab keyed by the provisioned tab id; the newest `networkMaxRequests` entries (default 200) survive. A redirect reuses its request id, so the newest hop replaces the entry in place rather than adding one. `browser_close` and plugin-fiber disposal drop the buffer with the tab.

**Bounds.** `browser_network` returns the newest `limit` matches (default 50) of an optional case-insensitive URL filter and reports `truncated` when it dropped older matches. `networkMaxBodyBytes` (default 100000) caps a response body, truncated at a byte boundary without splitting a multi-byte character; a `base64Encoded` body is reported by byte size and never inlined, because base64 costs tokens without carrying readable content. `resourceType` carries Chrome's own resource-type enum casing (`Document`, `Fetch`, `Script`), not a lowercased normalization, so a value the model reads matches what the DevTools Network panel shows; an event without a reported type falls back to the enum's own `Other`.

**Authorization.** Neither tool asks `ctx.approval`. The attachment gate is the authorization: `Network.enable` and `Network.getResponseBody` both run through `ctx.browser.cdp`, which rejects a tab the calling agent has not attached. `browser_console` set the same precedent for reading a tab's output.

**Event access.** The tools reuse `ctx.browser.onCdpEvent` unchanged. Events arrive for every attached tab regardless of owner, so the capture keys on armed tabs only: an owner that never called `browser_network` for a tab contributes nothing to that tab's buffer, and no other tab's events are buffered at all.

## Alternatives considered

**Add a `network` facet to `BrowserProvider` and `BrowserCapability`.** Rejected because no provider implements a distinct transport for it: capture is the `Network.enable`, `Network.getResponseBody`, and `Network.*` traffic the `cdp` facet already serves, so a facet would advertise a provider difference that does not exist.

**Enable `Network.enable` for every tab an agent opens.** Rejected because it retains and streams response bodies for tabs nobody inspects, on every open. Arming on the first tool call is one explicit, model-visible step and keeps the cost next to the need.

**Put the buffer in the `dsh-browser` seam.** Rejected because the seam has one consumer for this data and no observation surface of its own; `browser_console` already established consumer-side event subscription, and a second in-process buffer in the seam would outlive every plugin that reads it.

**Return binary bodies as base64.** Rejected because the model cannot use the encoded bytes, and the size line already answers what the payload was and how large it is.

**Require approval before reading request or response payloads.** Rejected because the user already authorized the tab and its session by attaching it; a per-read confirmation would train the user to approve payload reads reflexively, which is the behavior approval exists to prevent.

## Consequences

The model can diagnose a tab's request-level failures — status codes, failed loads, redirect targets, response payloads — without leaving the tool surface, at the cost of two more schemas and one guiding sentence in the browser prompt section.

Chrome owns the response-body buffer while capture is enabled on a tab, so a body can be evicted before `browser_network_body` asks for it; that surfaces as the CDP error for that `requestId` rather than an empty body.

Capture covers HTTP requests only. WebSocket frames, server-sent events, and `data:` URLs are not observed, and traffic a tab produced before its first `browser_network` call is unavailable, so an initial page load is observable only after a reload.

This package cannot observe the user's DevTools Network panel and drive the same tab at once: Chrome permits one debugger per tab, so `chrome.debugger.attach` fails while DevTools is open on that tab.

## Testing

`packages/browser/tool-browser/tests/tool-browser.spec.ts` covers the buffer (arming, unreadable events, redirect replacement, eviction, drop), response-body bounds including a multi-byte truncation, both formatters' text, and the tool paths through a fake provider: arming once per tab, filter, limit, failure reasons, binary bodies, and a retry after a refused enable. `packages/browser/tool-browser/tests/loader-composition.spec.ts` pins registration of `browser_network` through a real Loader boot. `packages/browser/tool-browser/tests/browser-network.e2e.ts`, which runs when `DSH_BROWSER_E2E=1` selects it, loads the shipped extension into a real Chromium and reduces the Chrome events that follow a real `Network.enable` with the shipped store, pinning the capitalized resource type, the redirect collapse onto the final hop, one entry per request id, and a real `Network.getResponseBody` reduced by `networkMaxBodyBytes`. The `browser-tabs` session snapshot carries the refreshed tool schemas and prompt section.
