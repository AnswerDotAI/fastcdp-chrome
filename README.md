# solveit-chrome

Chrome extension that bridges [Solveit](https://solve.it.com)'s Python backend with your browser — file system access, CDP automation, and real-time event streaming.

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** and select this directory
5. The extension icon should appear — it runs automatically on `solve.it.com`

The extension injects into pages served from `solve.it.com`. No configuration needed.

## Architecture

Three scripts work together:

- **content.js** (MAIN world) — listens for CustomEvents on `document.body`, calls `window.pushData` with results. Handles file system access and forwards CDP bridge requests.
- **bridge.js** (isolated world) — relays CDP messages between the page and the background service worker via `chrome.runtime`. Also forwards CDP event notifications back to the page.
- **background.js** (service worker) — manages `chrome.debugger` sessions. Creates/detaches tabs, sends CDP commands, and routes CDP events to subscribers.

## Usage from Python

All communication uses Solveit's `event_get_a` / `pop_data_a` async helpers. Results come back as `r.result` (success) or `r.error` (failure).

### File System Access

```python
await event_get_a('ext-pick-directory')                     # one-time directory picker (shows UI button)
await event_get_a('ext-list-files')                         # list files/folders in selected dir
await event_get_a('ext-list-files', path='sub/folder')      # list files in subdirectory
await event_get_a('ext-read-file', filename='foo.txt')      # read a file
await event_get_a('ext-forget-directory')                    # clear stored directory handle
```

The selected directory handle is persisted in IndexedDB, so it survives page reloads. Chrome will re-prompt for permission if needed.

### CDP (Chrome DevTools Protocol)

Control browser tabs programmatically — open pages, run JavaScript, interact with DOM, take screenshots:

```python
# Open a new tab
r = await event_get_a('cdp-new-tab', url='https://example.com')
tid = r.result['tabId']

# Send any CDP command
r = await event_get_a('cdp-send', tabId=tid, method='Runtime.evaluate',
                       params=dict(expression='document.title'))
r.result  # {'result': {'type': 'string', 'value': 'Example Domain'}}

# Close when done
await event_get_a('cdp-detach', tabId=tid)
```

### CDP Event Subscriptions

Subscribe to real-time CDP events (e.g. page loads, network requests, DOM changes):

```python
# Subscribe to events
sub_id = 'my_sub'
await event_get_a('cdp-subscribe', tabId=tid, subId=sub_id,
                   events=['Page.loadEventFired', 'Network.requestWillBeSent'])

# Enable the CDP domain first
await event_get_a('cdp-send', tabId=tid, method='Page.enable', params={})

# Navigate and wait for the load event
await event_get_a('cdp-send', tabId=tid, method='Page.navigate',
                   params=dict(url='https://example.com'))
evt = await pop_data_a(f'{sub_id}:1', timeout=10)
# {'data_id': 'my_sub:1', 'method': 'Page.loadEventFired', 'params': {'timestamp': ...}}

# Events arrive with sequential keys: sub_id:1, sub_id:2, ...
evt2 = await pop_data_a(f'{sub_id}:2', timeout=10)

# Unsubscribe when done
await event_get_a('cdp-unsubscribe', tabId=tid, subId=sub_id)
```

## Event Reference

| Event | Params | Description |
|---|---|---|
| `ext-ping` | — | Returns `'pong'` |
| `ext-get-url` | — | Returns current page URL |
| `ext-pick-directory` | — | Shows directory picker button, persists handle in IndexedDB |
| `ext-list-files` | `path` (optional) | Lists files/folders in selected directory |
| `ext-read-file` | `filename` | Reads file by name from selected directory |
| `ext-forget-directory` | — | Clears stored directory handle |
| `cdp-new-tab` | `url` | Opens new tab with debugger attached, returns `{tabId}` |
| `cdp-attach` | `tabId` or `targetId` | Attaches debugger to an existing tab/target |
| `cdp-get-targets` | — | Returns all debugger targets (pages, workers, etc.) |
| `cdp-send` | `tabId`/`targetId`, `method`, `params` | Sends CDP command, returns result |
| `cdp-detach` | `tabId`/`targetId` | Detaches debugger and cleans up subscriptions |
| `cdp-subscribe` | `tabId`/`targetId`, `subId`, `events` | Subscribes to CDP events (list of method names) |
| `cdp-unsubscribe` | `tabId`/`targetId`, `subId` | Removes event subscription |

## Permissions

- **activeTab** — access to the current tab
- **storage** — persist directory handles via IndexedDB
- **debugger** — Chrome DevTools Protocol access for CDP features
- **tabs** — create and manage tabs for CDP automation

