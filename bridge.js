// Isolated-world content script: tell the service worker which solveit origin to connect to
chrome.runtime.sendMessage({type: 'solveit-origin', origin: location.origin})
