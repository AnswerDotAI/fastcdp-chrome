(() => {
let dirHandle = null;
const { get, set, del } = window.idbKeyval;

async function verifyPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const q = await handle.queryPermission({ mode });
  return q === 'granted' ? true : (await handle.requestPermission({ mode })) === 'granted';
}

async function ensureDir() {
  dirHandle ??= await get('solveit-directory');
  if (!dirHandle) return null;
  if (await verifyPermission(dirHandle)) return dirHandle;
  await del('solveit-directory');
  dirHandle = null;
  return null;
}

async function resolveDir(path) {
  let h = await ensureDir();
  if (!h) throw new Error('No directory selected');
  for (const seg of (path || '').split('/').filter(Boolean)) h = await h.getDirectoryHandle(seg);
  return h;
}

function reply(e, result) { window.pushData(e.detail.idx, {result}) }
function replyErr(e, err) { window.pushData(e.detail.idx, {error: err.message}) }

async function pickDirectory(e) {
  const btn = Object.assign(document.createElement('button'), {
    id: 'solveitconn_dirbtn', textContent: 'Select Directory',
    className: 'uk-btn uk-btn-primary z-10 fixed top-2 right-2',
  });
  btn.onclick = async () => {
    try {
      dirHandle = await window.showDirectoryPicker();
      await set('solveit-directory', dirHandle);
      if (!(await verifyPermission(dirHandle))) throw new Error('Permission not granted');
      btn.remove();
      reply(e, `Directory selected: ${dirHandle.name}`);
    } catch (err) { btn.remove(); replyErr(e, err); }
  };
  document.body.appendChild(btn);
}

const handlers = {
  'ext-ping': () => 'pong',
  'ext-get-url': () => window.location.href,
  'ext-pick-directory': pickDirectory,
  'ext-list-files': async (e) => {
    const h = await resolveDir(e.detail.path);
    return Array.fromAsync(h.entries(), ([name, handle]) => ({name, type: handle.kind}));
  },
  'ext-read-file': async (e) => {
    const parts = e.detail.filename.split('/'), fname = parts.pop();
    const h = await resolveDir(parts.join('/'));
    return (await (await h.getFileHandle(fname)).getFile()).text();
  },
  'ext-forget-directory': async () => { await del('solveit-directory'); dirHandle = null; return 'Directory forgotten'; },
};

for (const [evt, handler] of Object.entries(handlers)) {
  document.body.addEventListener(evt, async (e) => {
    if (evt === 'ext-pick-directory') return handler(e);
    try { reply(e, await handler(e)); }
    catch (err) { replyErr(e, err); }
  });
}

ensureDir();
})()
