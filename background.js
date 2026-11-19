const DEBUG = false
const attached = new Set()
const peers = new Set()                    // every open socket: solveit relays plus any local kernels
const LOCAL_PORTS = [34654]
const locals = new Map()                   // port -> socket (connecting or open)

function log(...args) { if (DEBUG) console.log('background.js:', ...args) }

function debuggee(req) { return req.tabId ? {tabId: req.tabId} : {targetId: req.targetId} }
function debuggeeKey(req) { return req.tabId || req.targetId }

async function handle(req, ws) {
  if (req.method) return await chrome.debugger.sendCommand(debuggee(req), req.method, req.params || undefined)
  if (req.action === 'new-tab') {
    const tab = await chrome.tabs.create({url: 'about:blank', active: !!req.active})
    await chrome.debugger.attach({tabId: tab.id}, '1.3')
    attached.add(tab.id)
    ws.attached.add(tab.id)
    if (req.url && req.url !== 'about:blank') await chrome.debugger.sendCommand({tabId: tab.id}, 'Page.navigate', {url: req.url})
    return {tabId: tab.id}
  }
  if (req.action === 'attach') {
    if (!attached.has(debuggeeKey(req))) await chrome.debugger.attach(debuggee(req), '1.3')
    attached.add(debuggeeKey(req))
    ws.attached.add(debuggeeKey(req))
    return {tabId: req.tabId}
  }
  if (req.action === 'active-tab') {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true})
    if (!tab) throw new Error('no focused tab')
    return {tabId: tab.id}
  }
  if (req.action === 'get-targets') return await chrome.debugger.getTargets()
  if (req.action === 'detach') {
    await chrome.debugger.detach(debuggee(req))
    attached.delete(debuggeeKey(req))
    return {ok: true}
  }
  if (req.action === 'close-tab') {
    if (attached.has(req.tabId)) { await chrome.debugger.detach({tabId: req.tabId}); attached.delete(req.tabId) }
    await chrome.tabs.remove(req.tabId)
    return {ok: true}
  }
  throw new Error(`Unknown request: ${JSON.stringify(req)}`)
}

function sendTo(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
function broadcast(msg) { for (const p of peers) sendTo(p, msg) }

// Speak the frame protocol on one socket: execute request frames, reply to their sender.
// Tabs a peer attached are detached when it goes away, so no debugger banners outlive a client.
function wirePeer(ws) {
  ws.attached = new Set()
  ws.addEventListener('close', () => {
    for (const id of ws.attached) {
      if (!attached.has(id)) continue
      attached.delete(id)
      chrome.debugger.detach(typeof id === 'number' ? {tabId: id} : {targetId: id}).catch(() => {})
    }
  })
  ws.onmessage = async e => {
    const req = JSON.parse(e.data)
    log('got', req)
    if (!req.id) return
    try { sendTo(ws, {id: req.id, result: await handle(req, ws)}) }
    catch (err) { sendTo(ws, {id: req.id, error: err.message}) }
  }
  return ws
}

// A refused WebSocket dial logs an unsuppressable console error, but a caught fetch doesn't: probe
// any target with quiet HTTP first, and only dial sockets we know are listening. Non-2xx counts as dead.
async function probeHttp(url, ms=2000) {
  try {
    const r = await fetch(url, {signal: AbortSignal.timeout(ms)})
    return r.ok ? await r.text() : null
  } catch { return null }
}

// React to the options-page toggles immediately: drop connections when disabled, redial when re-enabled
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return
  if (ch.localEnabled?.newValue === false) {
    for (const [port, ws] of locals) { ws.onclose = null; peers.delete(ws); ws.close(); locals.delete(port) }
  }
})

// -- Local kernels: dial listeners like fastcdp's `ExtCDP.listen` on well-known localhost ports.
// Configure via chrome.storage.local: {localPorts: [34654], localToken: 's3cret'}
// The listener answers plain GETs with 'fastcdp', so the probe also confirms who's on the port.
async function alive(port) { return ((await probeHttp(`http://127.0.0.1:${port}/`, 500)) ?? '').startsWith('fastcdp') }

let localsBusy = false
async function probeLocals() {
  if (localsBusy) return
  localsBusy = true
  try {
    const cfg = await chrome.storage.local.get({localPorts: LOCAL_PORTS, localToken: '', localEnabled: true})
    if (!cfg.localEnabled) return
    for (const port of cfg.localPorts) {
      if (locals.get(port)?.readyState <= WebSocket.OPEN) continue
      if (!await alive(port)) continue
      const ws = wirePeer(new WebSocket(`ws://127.0.0.1:${port}/` + (cfg.localToken ? `?token=${cfg.localToken}` : '')))
      locals.set(port, ws)
      ws.onopen = () => { log('local peer on', port); peers.add(ws) }
      ws.onclose = () => { peers.delete(ws); locals.delete(port) }
    }
  } finally { localsBusy = false }
}

// The probes' own extension-API calls reset the worker's 30s idle timer (Chrome 110+), so these
// intervals keep it alive indefinitely; the alarm only recovers from force-kills (crash, update).
setInterval(probeLocals, 3000)
chrome.alarms.create('probe', {periodInMinutes: 0.5})
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'probe') probeLocals() })
probeLocals()

// Keep the service worker alive while connected, and let peers see we're here
setInterval(() => { if (peers.size) broadcast({ping: Date.now()}) }, 20000)

chrome.debugger.onEvent.addListener((source, method, params) => {
  broadcast({method, params, tabId: source.tabId || source.targetId})
})

chrome.debugger.onDetach.addListener((source) => { attached.delete(source.tabId || source.targetId) })

// -- Solveit relays carried by tabs: the first solveit tab per origin carries that origin's /wsx socket,
// so each command runs once. Other tabs are turned away and retry, taking over when the carrier closes.
const carriers = new Map()   // origin -> the carrying tab's port

chrome.runtime.onConnect.addListener(async port => {
  if (port.name !== 'relay') return
  const origin = new URL(port.sender.url).origin
  if (carriers.has(origin)) return port.disconnect()
  carriers.set(origin, port)
  if (!(await chrome.storage.local.get({solveitEnabled: true})).solveitEnabled) { carriers.delete(origin); return port.disconnect() }
  const closers = []
  const peer = wirePeer({readyState: WebSocket.CONNECTING, send: data => port.postMessage({data}),
    addEventListener: (ev, fn) => { if (ev === 'close') closers.push(fn) }})
  port.onMessage.addListener(msg => {
    if (msg.open) { peer.readyState = WebSocket.OPEN; peers.add(peer) }
    else if (msg.data) peer.onmessage?.({data: msg.data})
  })
  port.onDisconnect.addListener(() => {
    peer.readyState = WebSocket.CLOSED; peers.delete(peer); carriers.delete(origin); closers.forEach(f => f())
  })
  port.postMessage({dial: true})
})
