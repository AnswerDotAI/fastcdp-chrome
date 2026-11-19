// Isolated-world content script. The relay socket to this solveit server is opened here, not in the
// service worker: from the page it's same-site, so Chrome sends the SameSite=Lax session cookie that
// /wsx needs on hosted solveit. Frames pass to and from the worker over a runtime port.
function connect() {
  const port = chrome.runtime.connect({name: 'relay'})
  let ws = null
  const restart = () => { if (ws) { ws.onclose = null; ws.close() }; try { port.disconnect() } catch {}; setTimeout(connect, 3000) }
  port.onMessage.addListener(msg => {
    if (msg.dial) {
      ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/wsx?chan=cdp')
      ws.onopen = () => port.postMessage({open: true})
      ws.onmessage = e => port.postMessage({data: e.data})
      ws.onclose = restart
    }
    else if (msg.data && ws?.readyState === WebSocket.OPEN) ws.send(msg.data)
  })
  port.onDisconnect.addListener(restart)
}
connect()
