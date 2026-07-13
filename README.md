# fastcdp-chrome

Chrome extension that lets [fastcdp](https://github.com/AnswerDotAI/fastcdp) drive your everyday Chrome: CDP browser automation over a websocket bridge, plus [Solveit](https://solve.it.com) file system access.

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** and select this directory
5. The extension icon should appear. It runs automatically on `solve.it.com` and `localhost` pages.

The extension finds its peers two ways, both zero-config:

- **Local kernels**: it checks `http://127.0.0.1:34654` every few seconds with a quiet HTTP probe, and connects to any fastcdp listener there, such as `ExtCDP.listen()`. Override via the service worker console: `chrome.storage.local.set({localPorts: [34654], localToken: 's3cret'})` (the token, if set, must match the one passed to `ExtCDP.listen`).
- **Solveit relays**: when you open a solveit page, the extension learns the server's address from it and dials its `/wsx?chan=cdp` relay channel. Each origin announced since the worker started gets its own connection (so a localhost solveit and a solve.it.com instance can both be driven), dead origins are retried with quiet HTTP probes rather than failed websocket dials, and the most recently connected origin is redialed after a worker restart.

Either mode can be switched off from the extension's options page (right-click the icon, Options); disabling drops the relevant connections immediately, re-enabling reconnects within a few seconds.

## Architecture

Three scripts:

- **background.js** (service worker) owns everything CDP. It holds websockets to any number of peers (solveit relays plus local kernels), executes incoming frames with `chrome.debugger` and `chrome.tabs`, replies to the frame's sender, and broadcasts every debugger event to all peers. Both peer kinds are (re)connected by a 3s probe sweep, pings go out every 20s, the probes' own API calls keep the worker alive, and a `chrome.alarms` wake recovers it if Chrome force-kills it.
- **bridge.js** (isolated world) tells the service worker which solveit origin to connect to, on each solveit page load.
- **content.js** (MAIN world) handles file system access: it listens for CustomEvents on `document.body` and replies through `window.pushData`.

## CDP frame protocol

Kernel code normally uses [fastcdp](https://github.com/AnswerDotAI/fastcdp)'s `ExtCDP`, which owns this protocol; inside Solveit, [solvecdp](https://github.com/AnswerDotAI/solvecdp) binds it to a dialoghelper `Channel`. Frames are JSON dicts relayed verbatim by the solveit server.

Requests carry an `id`, which the reply echoes: `{id, result}` on success, `{id, error}` on failure. A request with a `method` is a CDP command, executed against the tab given by `tabId`:

```python
await ch.request(method='Runtime.evaluate', tabId=tid, params={'expression': 'document.title'})
```

A request with an `action` is a lifecycle operation:

| Action | Params | Result |
|---|---|---|
| `new-tab` | `url`, `active` | `{tabId}` (debugger attached) |
| `attach` | `tabId` or `targetId` | `{tabId}` |
| `get-targets` | — | list of debugger targets |
| `detach` | `tabId` or `targetId` | `{ok}` |
| `close-tab` | `tabId` | `{ok}` (detaches first if needed) |

Every `chrome.debugger` event is forwarded as `{method, params, tabId}` (no `id`). The extension also sends `{ping}` frames as a keepalive; consumers should ignore frames without a `method` or `id`.

## File System Access

All communication uses Solveit's `event_get_a` / `pop_data_a` async helpers. Results come back as `r.result` (success) or `r.error` (failure).

```python
await event_get_a('ext-pick-directory')                     # one-time directory picker (shows UI button)
await event_get_a('ext-list-files')                         # list files/folders in selected dir
await event_get_a('ext-list-files', path='sub/folder')      # list files in subdirectory
await event_get_a('ext-read-file', filename='foo.txt')      # read a file
await event_get_a('ext-forget-directory')                   # clear stored directory handle
```

The selected directory handle is persisted in IndexedDB, so it survives page reloads. Chrome will re-prompt for permission if needed.

## Event Reference

| Event | Params | Description |
|---|---|---|
| `ext-ping` | — | Returns `'pong'` |
| `ext-get-url` | — | Returns current page URL |
| `ext-pick-directory` | — | Shows directory picker button, persists handle in IndexedDB |
| `ext-list-files` | `path` (optional) | Lists files/folders in selected directory |
| `ext-read-file` | `filename` | Reads file by name from selected directory |
| `ext-forget-directory` | — | Clears stored directory handle |

## Permissions

- **storage** — persist directory handles, the solveit origin, and local port/token config
- **debugger** — Chrome DevTools Protocol access for CDP features
- **tabs** — create and manage tabs for CDP automation
- **alarms** — periodically wake the service worker to probe for local kernels
