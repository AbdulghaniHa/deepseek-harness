---
description: "The computer-use service (ctx.computer): how deployments and plugin authors drive GUI apps through interchangeable providers, with grants, a deny list, and hit-testing."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use

English | [中文](README.zh.md)

## Summary

Any plugin or tool can list apps, snapshot windows, and inject input through `dsh-computer-use` (`ctx.computer`) without binding to a native GUI library. Providers plug in as backends, and the service picks one usable provider, so callers never track which helper runs behind a call. Choose it when building desktop tooling or another backend; the shipped model-facing tools (`dsh-tool-computer-use`) mount it automatically. The service itself makes no OS GUI calls and registers no model-facing tool: a provider must be mounted before app or input calls can run.

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

A composition that needs desktop GUI access loads the `dsh-computer-use` service and mounts at least one backend, then plugin or tool authors call `ctx.computer.listApps()`, `snapshot()`, and `click()` through an `Agent` owner. The service resolves the backend for each call, so callers never see provider ids unless they configured one.

### When to choose it

Choose the service when a plugin or tool must drive GUI apps without hard-coding a native library. A deployment that only uses the shipped `computer_*` tools gets it for free through `dsh-tool-computer-use`. You do not need it when the composition never reaches the desktop. The service adds no desktop access of its own: without at least one usable provider, every call fails with a structured `ComputerError`.

### Minimal configuration

Load the service and let a single mounted backend auto-select, or pin a provider id with `provider`. `$DSH_COMPUTER_PROVIDER` feeds the same field and is not a separate priority chain.

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-computer-use-local'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | (unset) | Pinned provider id; unset auto-selects when exactly one is usable |
| `deniedApps` | `[]` | Extra deny tokens beyond the fixed terminal list |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-computer-use) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ComputerRuntime` is a Cordis `Service` on `ctx.computer`. Selection matches `BrowserRuntime`: configured id, else exactly one usable provider. Grants are a `WeakMap` keyed by `Agent` object identity. Deny checks and `windowAtPoint` hit-testing run in the runtime so a direct caller cannot skip the tools.

Held keys retain their provider until matching key-up calls settle. Turn stop, agent disposal, runtime disposal, cancellation, and failed key dispatch attempt every matching release before clearing ownership.

| File | Owns |
|---|---|
| `src/index.ts` | registry, grants, deny, hit-test |
| `src/types.ts` | provider vocabulary and `ComputerError` |
| `src/deny.ts` | terminal tokens and harness pid |
| — | No runtime invariant companion is published; this Service Definition holds a single provider slot and no event stream or mutable data relation of its own. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use subsystem](../../../docs/subsystems/computer-use.md) — provider, window, snapshot node, and error codes.
- [Computer-use package map](../README.md) — the three-package family.
- [dsh-tool-computer-use](../tool-computer-use/README.md) — the model-facing `computer_*` tools.
- [Computer-use capability seam decision](../../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.md) — why the helper is crash-isolated.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-computer-use`, which renders snapshots and screenshots to the model while this service contributes no prompt or schema.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No observation surface** — availability is observable only by running a call and routing the thrown code.
- **Launch does not require a grant** — the launched identity is unknown until the provider returns; consumers then run the grant flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Grants are fenced by exact `Agent` object identity, not session-id string equality.

</details>
