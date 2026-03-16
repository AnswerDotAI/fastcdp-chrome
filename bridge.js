const DEBUG = false

window.addEventListener('message', e => {
  if (e.data?.type !== 'cdp-bridge-req') return
  if (DEBUG) console.log('bridge.js got:', e.data)
  chrome.runtime.sendMessage({...e.data, type: 'cdp', action: e.data.action}, r => {
    if (DEBUG) console.log('bridge.js reply:', r)
    window.postMessage({type: 'cdp-bridge-res', id: e.data.id, result: r}, '*')
  })
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'cdp-event') window.postMessage(msg, '*')
})