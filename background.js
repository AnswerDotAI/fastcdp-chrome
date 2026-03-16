const DEBUG = false
const attached = new Set()
const subs = new Map()

function debuggee(req) { return req.tabId ? {tabId: req.tabId} : {targetId: req.targetId} }
function debuggeeKey(req) { return req.tabId || req.targetId }

chrome.runtime.onMessage.addListener((req, sender, reply) => {
  if (DEBUG) console.log('background.js got:', req)
  if (req.type !== 'cdp') return
  handle(req, sender).then(r => { if (DEBUG) console.log('background.js result:', r); reply(r) }).catch(e => { if (DEBUG) console.log('background.js error:', e); reply({error: e.message}) })
  return true
})

async function handle(req, sender) {
  if (req.action === 'new-tab') {
    const tab = await chrome.tabs.create({url: req.url || 'about:blank'})
    await chrome.debugger.attach({tabId: tab.id}, '1.3')
    attached.add(tab.id)
    return {tabId: tab.id}
  }
  if (req.action === 'attach') {
    await chrome.debugger.attach(debuggee(req), '1.3')
    attached.add(debuggeeKey(req))
    return {ok: true}
  }
  if (req.action === 'get-targets') return await chrome.debugger.getTargets()
  if (req.action === 'send') return await chrome.debugger.sendCommand(debuggee(req), req.method, req.params || undefined)
  if (req.action === 'detach') {
    const key = debuggeeKey(req)
    await chrome.debugger.detach(debuggee(req))
    attached.delete(key)
    subs.delete(key)
    return {ok: true}
  }
  if (req.action === 'subscribe') {
    const key = debuggeeKey(req)
    if (!subs.has(key)) subs.set(key, [])
    subs.get(key).push({subId: req.subId, events: req.events, senderTabId: sender.tab.id})
    return {ok: true}
  }
  if (req.action === 'unsubscribe') {
    const key = debuggeeKey(req)
    subs.set(key, (subs.get(key) || []).filter(s => s.subId !== req.subId))
    return {ok: true}
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const key = source.tabId || source.targetId
  for (const entry of subs.get(key) || []) {
    if (entry.events.includes(method)) {
      chrome.tabs.sendMessage(entry.senderTabId, {type: 'cdp-event', subId: entry.subId, method, params})
    }
  }
})