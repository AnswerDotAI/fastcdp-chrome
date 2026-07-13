const defaults = {localEnabled: true, solveitEnabled: true}
chrome.storage.local.get(defaults).then(cfg => {
  for (const k of Object.keys(defaults)) {
    const el = document.getElementById(k)
    el.checked = cfg[k]
    el.onchange = () => chrome.storage.local.set({[k]: el.checked})
  }
})
