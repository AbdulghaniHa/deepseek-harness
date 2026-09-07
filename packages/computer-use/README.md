---
description: "Package map for the computer-use capability family: the desktop service, its crash-isolated local helper, and the model-facing computer_* tools."
kind: "package-group"
---

# computer-use/ — computer-use capability family

English | [中文](README.zh.md)

## Summary

The `computer-use/` group lets the harness drive GUI applications through one provider-neutral service (`ctx.computer`) and the local helper and tools that use it. A deployment mounts the local provider and the model-facing tools; the service picks a usable provider so the `computer_*` names stay stable while the native transport stays behind the provider. Three packages split the family: the `computer-use/` service that owns provider selection, grants, deny list, hit-testing, and errors; `computer-use-local/`, which speaks JSON-RPC to a crash-isolated helper; and `tool-computer-use/`, which exposes `computer_*` to the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three packages play the computer-use roles; the subsystem reference owns the exhaustive types.

| Package | Role | ctx key |
|---|---|---|
| [`computer-use/`](computer-use/README.md) | Computer-use service: apps, windows, grants, and hit-testing through interchangeable backends | `ctx.computer` |
| [`computer-use-local/`](computer-use-local/README.md) | Relays accessibility, input, and capture through a stdio helper | registers on `ctx.computer` |
| [`tool-computer-use/`](tool-computer-use/README.md) | Exposes `computer_*` to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Computer-use subsystem](../../docs/subsystems/computer-use.md) — provider, window, snapshot node, screenshot request, and `ComputerError`.
- [Computer-use capability seam decision](../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.md) — why the helper is crash-isolated and snapshots are primary.
- [Drive GUI apps](../../docs/user/guide/computer-use.md) — permissions and enabling overlay.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`dsh-base` sets `enabled: false`. Persistent always-allow is Phase 2.

</details>
