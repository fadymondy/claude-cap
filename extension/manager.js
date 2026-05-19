const $ = (id) => document.getElementById(id);

let SERVER = 'https://cap.fadymondy.com';
let TOKEN = '';

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const url = `${SERVER.replace(/\/$/, '')}${path}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function loadSession() {
  const { managerSession } = await chrome.storage.sync.get(['managerSession']);
  if (managerSession?.token && managerSession?.server) {
    SERVER = managerSession.server;
    TOKEN = managerSession.token;
    return true;
  }
  return false;
}

async function saveSession() {
  await chrome.storage.sync.set({ managerSession: { server: SERVER, token: TOKEN } });
}

async function clearSession() {
  await chrome.storage.sync.remove(['managerSession']);
}

function showLogin() {
  $('login-view').style.display = '';
  $('manager-view').style.display = 'none';
  $('server').value = SERVER;
  $('password').value = '';
  $('password').focus();
}

function showManager() {
  $('login-view').style.display = 'none';
  $('manager-view').style.display = '';
  refresh();
  refreshTabs();
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  const { pinnedTabId } = await chrome.storage.local.get(['pinnedTabId']);
  $('tabs-info').textContent = pinnedTabId
    ? `MCP target → Pinned tab #${pinnedTabId}. Capture/navigate from Claude will hit this tab even if it's in the background.`
    : 'No tab pinned. MCP capture will use whichever tab is currently active.';
  const filtered = tabs.filter(t => !t.url?.startsWith('chrome-extension://') || !t.url.endsWith('manager.html'));
  $('tabs-list').innerHTML = filtered.map((t) => {
    const isPinned = t.id === pinnedTabId;
    const title = escapeHtml(t.title || '(no title)');
    const url = escapeHtml(t.url || '');
    const badges = [
      t.active ? '<span style="color:#0a7">active</span>' : null,
      t.windowId ? `window ${t.windowId}` : null
    ].filter(Boolean).join(' · ');
    return `
      <div class="tab-row ${isPinned ? 'pinned' : ''}" data-id="${t.id}">
        <div class="info">
          <div class="t">${title}</div>
          <div class="u">${url}</div>
          <div class="badges">${badges}</div>
        </div>
        <button data-action="${isPinned ? 'unpin' : 'pin'}">${isPinned ? 'Unpin' : 'Pin for MCP'}</button>
        <button data-action="activate">Switch to</button>
        <button data-action="capture">Capture</button>
      </div>
    `;
  }).join('');

  $('tabs-list').querySelectorAll('.tab-row').forEach((row) => {
    const id = parseInt(row.dataset.id, 10);
    row.addEventListener('click', async (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      try {
        if (action === 'pin') {
          await chrome.storage.local.set({ pinnedTabId: id });
          toast('Pinned tab #' + id);
        } else if (action === 'unpin') {
          await chrome.storage.local.remove(['pinnedTabId']);
          toast('Unpinned');
        } else if (action === 'activate') {
          const tab = await chrome.tabs.get(id);
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(id, { active: true });
          toast('Activated');
        } else if (action === 'capture') {
          // Capture this specific tab regardless of pin: temporarily activate it, capture, restore.
          const orig = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
          const target = await chrome.tabs.get(id);
          await chrome.windows.update(target.windowId, { focused: true });
          await chrome.tabs.update(id, { active: true });
          await new Promise(r => setTimeout(r, 300));
          await chrome.runtime.sendMessage({ type: 'capture_now', withSelection: false });
          // Restore previous focus if it was in a different window.
          if (orig && orig.id !== id) {
            try { await chrome.tabs.update(orig.id, { active: true }); } catch {}
          }
          setTimeout(() => { refresh(); refreshTabs(); }, 1500);
          return;
        }
      } catch (err) { toast('Action failed: ' + err.message); }
      refreshTabs();
    });
  });
}

// Re-render tabs on changes.
chrome.tabs.onCreated.addListener(() => refreshTabs());
chrome.tabs.onRemoved.addListener(() => refreshTabs());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.url || info.status === 'complete') refreshTabs(); });
chrome.tabs.onActivated.addListener(() => refreshTabs());

async function login() {
  $('login-err').textContent = '';
  const server = $('server').value.trim();
  const password = $('password').value;
  if (!server || !password) return;
  $('login-btn').disabled = true;
  try {
    const res = await fetch(`${server.replace(/\/$/, '')}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Login failed (${res.status}): ${txt.slice(0, 120)}`);
    }
    const data = await res.json();
    SERVER = server;
    TOKEN = data.token;
    await saveSession();
    // Also push to the extension's general settings so the capture flow uses the same.
    await chrome.storage.sync.set({ serverBase: SERVER, token: TOKEN });
    showManager();
  } catch (err) {
    $('login-err').textContent = err.message;
  } finally {
    $('login-btn').disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function refresh() {
  $('grid').innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try {
    data = await api('/list?limit=50');
  } catch (err) {
    $('grid').innerHTML = `<div class="empty" style="color:#d22;">Load failed: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    $('grid').innerHTML = '';
    $('empty').style.display = '';
    return;
  }
  $('empty').style.display = 'none';
  $('grid').innerHTML = items.map((it) => {
    const m = it.meta || {};
    const title = escapeHtml(m.title || '(no title)');
    const page = escapeHtml(m.url || '');
    const when = new Date(it.when).toLocaleString();
    return `
      <div class="card" data-id="${escapeHtml(it.id)}" data-url="${escapeHtml(it.url)}">
        <img src="${escapeHtml(it.url)}" loading="lazy" data-action="view" alt="" />
        <div class="body">
          <div class="title">${title}</div>
          <div class="page">${page}</div>
          <div class="meta">${when} · ${Math.round(it.size / 1024)} KB</div>
        </div>
        <div class="actions">
          <button data-action="copy-url">Copy URL</button>
          <button data-action="copy-json">Copy JSON</button>
          <button data-action="meta">Meta</button>
          <button data-action="delete">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Wire up card actions.
  $('grid').querySelectorAll('.card').forEach((card) => {
    const id = card.dataset.id;
    const url = card.dataset.url;
    card.addEventListener('click', async (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'view') {
        showLightbox(`<img src="${escapeHtml(url)}" />`);
      } else if (action === 'copy-url') {
        await navigator.clipboard.writeText(url);
        toast('URL copied');
      } else if (action === 'copy-json') {
        try {
          const list = await api('/list?limit=50');
          const it = list.items.find(x => x.id === id) || {};
          const payload = {
            image_url: it.url,
            page_url: it.meta?.url,
            title: it.meta?.title,
            viewport: it.meta?.viewport,
            captured_at: it.meta?.when || it.when,
            region: it.meta?.region,
            network_requests: it.meta?.network_requests || [],
            console: it.meta?.console || []
          };
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          toast('Full JSON copied');
        } catch (err) { toast('Copy failed: ' + err.message); }
      } else if (action === 'meta') {
        try {
          const list = await api('/list?limit=50');
          const it = list.items.find(x => x.id === id);
          showLightbox(`<pre>${escapeHtml(JSON.stringify(it, null, 2))}</pre>`);
        } catch (err) { toast('Meta load failed'); }
      } else if (action === 'delete') {
        if (!confirm('Delete this screenshot?')) return;
        try {
          await api('/delete/' + encodeURIComponent(id), { method: 'DELETE' });
          card.remove();
          toast('Deleted');
        } catch (err) { toast('Delete failed: ' + err.message); }
      }
    });
  });
}

function showLightbox(html) {
  const modal = $('modal');
  $('modal-body').innerHTML = html;
  modal.classList.add('show');
}

$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) $('modal').classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('modal').classList.remove('show');
});

$('login-btn').addEventListener('click', login);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

$('refresh')?.addEventListener('click', () => { refresh(); refreshTabs(); });
$('logout')?.addEventListener('click', async () => { await clearSession(); TOKEN = ''; showLogin(); });
$('capture-now')?.addEventListener('click', async () => {
  $('capture-now').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'capture_now', withSelection: false });
    if (result?.error) throw new Error(result.error);
    setTimeout(refresh, 1500);
  } catch (err) {
    toast('Capture failed: ' + err.message);
  } finally {
    $('capture-now').disabled = false;
  }
});

(async () => {
  const ok = await loadSession();
  if (ok) showManager(); else showLogin();
})();
