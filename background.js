const DEBUG = false
const attached = new Set()
const peers = new Set()                    // every open socket: solveit relays plus any local kernels
const relays = new Map(), relayOrigins = new Set()  // origin -> socket; origins announced this session
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
// any target with quiet HTTP first, and only dial sockets we know are listening. Non-2xx counts as
// dead: a reverse proxy (solve.it.com's caddy) still answers 502 when the instance behind it is stopped.
async function probeHttp(url, ms=2000) {
  try {
    const r = await fetch(url, {signal: AbortSignal.timeout(ms)})
    return r.ok ? await r.text() : null
  } catch { return null }
}

// -- Solveit relays: one connection per solveit origin announced this session, mirroring the local
// kernels' per-port map, so e.g. a localhost solveit and a solve.it.com instance can both be driven.
// Only the most recently connected origin is persisted, so a worker restart redials just that one.
let relaysBusy = false
async function probeRelays() {
  if (relaysBusy) return   // a slow probe can outlive the interval tick; a second sweep would double-dial
  relaysBusy = true
  try {
    if (!(await chrome.storage.local.get({solveitEnabled: true})).solveitEnabled) return
    for (const origin of relayOrigins) {
      if (relays.get(origin)?.readyState <= WebSocket.OPEN) continue
      if (await probeHttp(origin) == null) continue
      log('dialing relay', origin)
      const ws = wirePeer(new WebSocket(origin.replace(/^http/, 'ws') + '/wsx?chan=cdp'))
      relays.set(origin, ws)
      ws.onopen = () => { peers.add(ws); chrome.storage.local.set({wsOrigin: origin}) }
      ws.onclose = () => { peers.delete(ws); if (relays.get(origin) === ws) relays.delete(origin) }
    }
  } finally { relaysBusy = false }
}

chrome.storage.local.get('wsOrigin').then(r => { if (r.wsOrigin) { relayOrigins.add(r.wsOrigin); probeRelays() } })

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'solveit-origin') return
  relayOrigins.add(msg.origin)
  probeRelays()
})

// React to the options-page toggles immediately: drop connections when disabled, redial when re-enabled
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return
  if (ch.solveitEnabled) {
    if (ch.solveitEnabled.newValue) probeRelays()
    else for (const [o, ws] of relays) { ws.onclose = null; peers.delete(ws); ws.close(); relays.delete(o) }
  }
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
setInterval(probeRelays, 3000)
chrome.alarms.create('probe', {periodInMinutes: 0.5})
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'probe') { probeLocals(); probeRelays() } })
probeLocals()

// Keep the service worker alive while connected, and let peers see we're here
setInterval(() => { if (peers.size) broadcast({ping: Date.now()}) }, 20000)

chrome.debugger.onEvent.addListener((source, method, params) => {
  broadcast({method, params, tabId: source.tabId || source.targetId})
})

chrome.debugger.onDetach.addListener((source) => { attached.delete(source.tabId || source.targetId) })
