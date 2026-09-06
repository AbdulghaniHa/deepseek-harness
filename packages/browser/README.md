---
description: "Package map for the browser capability family: the Chrome-tab service, its Native Messaging provider, and the model-facing browser_* tools."
kind: "package-group"
---

# browser/ — browser capability family

English | [中文](README.zh.md)

## Summary

The `browser/` group lets the harness drive the user's real Chrome — existing tabs, cookies, and logins — through one provider-neutral service (`ctx.browser`) and the Native Messaging backend and tools that use it. A deployment mounts the Chrome-extension provider and the model-facing tools; the service picks a usable provider so the `browser_*` names stay stable while the transport stays behind the provider. Three packages split the family: the `browser/` service that owns provider selection, owner-scoped attachments, and errors; `browser-chrome-extension/`, which speaks Native Messaging and a local socket; and `tool-browser/`, which exposes `browser_*` to the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three packages play the browser roles; the subsystem reference owns the exhaustive types.

| Package | Role | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Browser service: tabs, attachments, and CDP through interchangeable backends | `ctx.browser` |
| [`browser-chrome-extension/`](browser-chrome-extension/README.md) | Relays Chrome DevTools Protocol through a Native Messaging host | registers on `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | Exposes `browser_*` to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Browser subsystem](../../docs/subsystems/browser.md) — provider, tab, CDP request, and `BrowserError`.
- [Browser capability seam decision](../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.md) — why the native host listens and the tools stay declarative.
- [Install Chrome browser tools](../../docs/user/guide/browser.md) — user install steps.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Unpacked extension install remains until a Web Store id exists. Raw CDP stays off in `dsh-base`.

</details>
