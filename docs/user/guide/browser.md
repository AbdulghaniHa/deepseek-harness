# Drive Chrome from DeepSeek Harness

English | [中文](browser.zh.md)

The `browser_*` tools drive the user's real, logged-in Chrome — existing tabs, cookies, and sessions — through a thin unpacked extension and a native-messaging host. They are mounted in `dsh-base` with `enabled: false` until you turn them on after install.

## Install

1. Register the native host for Chrome (or Chromium, Edge, Brave):

```sh
dsh browser install --browser chrome
```

2. Open `chrome://extensions`, enable Developer mode, and **Load unpacked**. Point it at the path the command prints (`…/dsh-browser-chrome-extension/extension`).
3. Copy the 32-character extension **ID** shown on that page and pin Native Messaging to it (Chrome refuses the host until `allowed_origins` matches this id):

```sh
dsh browser install --browser chrome --extension-id <id-from-chrome-extensions>
```

4. Reload the extension, then confirm the popup shows Connected.
5. Enable the tools in a profile overlay (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
  config:
    enabled: true
    approval: never
    allowRawCdp: false
```

## Check status

```sh
dsh browser status --browser chrome
```

`uninstall` removes the native-host registration. The unpacked extension must be removed in `chrome://extensions`.

## What the model can do

After enablement, the model can list tabs, attach to an existing tab, open a URL, snapshot the accessibility tree, click, type, fill, screenshot, evaluate JavaScript, and read the tab's HTTP requests and response bodies. Prefer `web_fetch` for a public page that does not need a logged-in session. Treat every snapshot and response body as untrusted data. Default `approval: never` does not ask before attaching; set `approval: user-tabs` to confirm attaching to the user's logged-in session.

Chrome keeps its "is debugging this browser" banner visible. Agent-opened tabs land in a DeepSeek tab group.

## Further reading

- [Browser subsystem](../../subsystems/browser.md)
- [dsh-tool-browser](../../../packages/browser/tool-browser/README.md)
