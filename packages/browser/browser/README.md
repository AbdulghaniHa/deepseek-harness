---
description: "The browser service (ctx.browser): how deployments and plugin authors drive Chrome tabs through interchangeable providers, with one selection policy and error vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

English | [中文](README.zh.md)

## Summary

Any plugin or tool can list tabs, attach, and send CDP through `dsh-browser` (`ctx.browser`) without binding to Chrome Native Messaging. Providers plug in as backends, and the service picks one usable provider, so callers never track which transport runs behind a call. Choose it when building browser tooling or another backend; the shipped model-facing tools (`dsh-tool-browser`) mount it automatically. The service itself makes no Chrome calls and registers no model-facing tool: a provider must be mounted before tab or CDP calls can run.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A composition that needs Chrome-tab access loads the `dsh-browser` service and mounts at least one backend, then plugin or tool authors call `ctx.browser.listTabs()`, `attach()`, and `cdp()` directly. The service resolves the backend for each call, so callers never see provider ids unless they configured one.

### When to choose it

Choose the service when a plugin or tool must drive Chrome without hard-coding Native Messaging. A deployment that only uses the shipped `browser_*` tools gets it for free through `dsh-tool-browser`. You do not need it when the composition never reaches Chrome. The service adds no browser access of its own: without at least one usable provider, every call fails with a structured `BrowserError`.

### Minimal configuration

Load the service and let a single mounted backend auto-select, or pin a provider id with `provider`. `$DSH_BROWSER_PROVIDER` feeds the same field and is not a separate priority chain.

```yaml
- name: '@deepseek-ai/dsh-browser'
- name: '@deepseek-ai/dsh-browser-chrome-extension'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | (unset) | Pinned provider id; unset auto-selects when exactly one is usable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-browser) is the exhaustive source for every accepted field and its JSDoc.

### Provider selection

Each call resolves its provider at execution time, and registration or load order never matters. A configured provider id wins when it is registered and usable; without a configured id, the service runs the single usable provider or fails clearly with `BROWSER_PROVIDER_UNAVAILABLE`, `BROWSER_PROVIDER_CONFIGURED_MISSING`, `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`, or `BROWSER_PROVIDER_AMBIGUOUS`.

### Failures and recovery

Failures throw `BrowserError` with a stable, machine-routable code. Callers route on the code. A disconnected host is `BROWSER_NOT_CONNECTED`; a vanished tab is `BROWSER_TAB_GONE`; a foreign attachment is `BROWSER_FOREIGN_ATTACHMENT`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `BrowserRuntime` service, provider registry, and owner-scoped attachments |
| [`src/types.ts`](src/types.ts) | Request/result types, branded ids, and the `BrowserError` taxonomy |
| — | No runtime invariant companion is published; attachment maps are private and selection is enforced on each call; the seam publishes no independent registry or request/result observation stream. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser subsystem](../../../docs/subsystems/browser.md) — provider, tab, CDP request, and error codes.
- [Browser package map](../README.md) — the three-package family.
- [dsh-tool-browser](../tool-browser/README.md) — the model-facing `browser_*` tools.
- [Browser capability seam decision](../../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.md) — why the native host listens.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-browser`, which renders snapshots and screenshots to the model while this service contributes no prompt or schema.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No observation surface** — availability is observable only by running a call and routing the thrown code.
- **Chrome-API facets are optional** — history, bookmarks, reading list, and downloads fail with `BROWSER_FACET_UNAVAILABLE` when the selected provider does not advertise them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Attachments are fenced by exact `Agent` object identity, not session-id string equality.

</details>
