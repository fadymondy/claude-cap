// Background service worker — capture + upload to cap.local.

const DEFAULTS = {
  serverBase: 'https://cap.fadymondy.com',
  token: '',
  notify: true,
  copyClipboard: true,
  captureNetwork: true,
  captureConsole: true,
  networkWindow: 15000,
  clipboardFormat: 'json', // 'json' | 'url' | 'markdown'
  enableRemoteControl: true,
  hotkeyMode: 'region' // 'region' | 'full'
};

// Rolling network log per tab.
const networkLog = new Map();
// In-flight requests for timing (requestId -> { method, url, type, startTs }).
const inFlight = new Map();
// Pending selection promises keyed by tabId.
const pendingSelections = new Map();

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  inFlight.set(details.requestId, {
    method: details.method,
    url: details.url,
    type: details.type,
    initiator: details.initiator,
    startTs: Date.now()
  });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onCompleted.addListener((details) => {
  if (details.tabId < 0) return;
  const pre = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  const now = Date.now();
  const buf = networkLog.get(details.tabId) || [];
  buf.push({
    method: details.method,
    url: details.url,
    status: details.statusCode,
    type: details.type,
    initiator: details.initiator,
    started_at: pre?.startTs ? new Date(pre.startTs).toISOString() : undefined,
    duration_ms: pre?.startTs ? now - pre.startTs : undefined,
    ts: now
  });
  while (buf.length > 100) buf.shift();
  networkLog.set(details.tabId, buf);
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.tabId < 0) return;
  const pre = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  const buf = networkLog.get(details.tabId) || [];
  buf.push({
    method: details.method,
    url: details.url,
    error: details.error,
    type: details.type,
    initiator: details.initiator,
    duration_ms: pre?.startTs ? Date.now() - pre.startTs : undefined,
    ts: Date.now()
  });
  while (buf.length > 100) buf.shift();
  networkLog.set(details.tabId, buf);
}, { urls: ['<all_urls>'] });

chrome.tabs.onRemoved.addListener((tabId) => {
  networkLog.delete(tabId);
});

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function notify(title, message) {
  const s = await getSettings();
  if (!s.notify) return;
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title,
      message: String(message).slice(0, 250)
    });
  } catch {}
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function gatherMeta(tab, s) {
  let viewport = '', userAgent = '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ viewport: window.innerWidth + 'x' + window.innerHeight, ua: navigator.userAgent })
    });
    viewport = result.viewport;
    userAgent = result.ua;
  } catch {}

  // Pull console log from the page's MAIN world.
  let consoleLog = [];
  if (s.captureConsole !== false) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => (window.__capConsoleLog || []).slice(-300)
      });
      consoleLog = result || [];
    } catch {}
  }

  const requests = s.captureNetwork ? (networkLog.get(tab.id) || []) : [];
  const cutoff = Date.now() - s.networkWindow;
  const recentNet = requests
    .filter(r => r.ts >= cutoff)
    .map(({ ts, ...rest }) => rest);

  const recentConsole = (consoleLog || [])
    .filter(c => c.ts >= cutoff)
    .map(({ ts, ...rest }) => ({ ...rest, at: new Date(ts).toISOString() }));

  return {
    url: tab.url,
    title: tab.title,
    viewport,
    user_agent: userAgent,
    when: new Date().toISOString(),
    network_requests: recentNet,
    console: recentConsole
  };
}

function buildPayload(result, meta, format) {
  const obj = {
    image_url: result.url,
    page_url: meta.url,
    title: meta.title,
    viewport: meta.viewport,
    captured_at: meta.when,
    region: meta.region,
    user_agent: meta.user_agent,
    network_requests: (meta.network_requests || []).slice(-25),
    console: (meta.console || []).slice(-50),
    sha256: result.sha256
  };
  if (format === 'url') return result.url;
  if (format === 'markdown') {
    const lines = [
      `## Screenshot — ${meta.title || meta.url}`,
      '',
      `![screenshot](${result.url})`,
      '',
      `- **Image**: ${result.url}`,
      `- **Page**: ${meta.url}`,
      `- **Viewport**: ${meta.viewport}`,
      `- **Captured**: ${meta.when}`,
      `- **Region**: ${typeof meta.region === 'string' ? meta.region : JSON.stringify(meta.region)}`
    ];
    if (obj.network_requests.length) {
      lines.push('', '### Recent network requests', '');
      for (const r of obj.network_requests.slice(-15)) {
        const status = r.status ? `${r.status}` : (r.error ? `err:${r.error}` : '');
        const dur = r.duration_ms != null ? ` ${r.duration_ms}ms` : '';
        lines.push(`- \`${r.method}\` ${r.url} ${status ? `(${status})` : ''}${dur}`);
      }
    }
    if (obj.console.length) {
      lines.push('', '### Console', '');
      for (const c of obj.console.slice(-20)) {
        lines.push(`- **${c.level}**: ${c.text}`);
      }
    }
    return lines.join('\n');
  }
  // default: json
  return JSON.stringify(obj, null, 2);
}

async function uploadCapture(blob, meta, s) {
  if (!s.token) throw new Error('Token not set — open the extension options.');
  const form = new FormData();
  form.append('file', blob, `cap-${Date.now()}.png`);
  form.append('meta', JSON.stringify(meta));
  const res = await fetch(`${s.serverBase}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}` },
    body: form
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function writeClipboard(text) {
  if (!chrome.offscreen) return false;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Write upload URL to clipboard'
    });
  } catch {
    // Already exists — fine.
  }
  let ok = false;
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'clipboard_write', text }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard timeout')), 2000))
    ]);
    ok = !!(resp && resp.ok);
  } catch {}
  try { await chrome.offscreen.closeDocument(); } catch {}
  return ok;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab;
}

// Returns the pinned tab if set and still alive, otherwise the currently active tab.
// "Pinned" here means the user explicitly chose a tab in the manager for Claude to target.
async function getTargetTab() {
  const { pinnedTabId } = await chrome.storage.local.get(['pinnedTabId']);
  if (pinnedTabId) {
    try {
      const tab = await chrome.tabs.get(pinnedTabId);
      if (tab) return tab;
    } catch {
      // Tab was closed — clear the stale pin.
      await chrome.storage.local.remove(['pinnedTabId']);
    }
  }
  return getActiveTab();
}

// Clear pin if the pinned tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { pinnedTabId } = await chrome.storage.local.get(['pinnedTabId']);
  if (pinnedTabId === tabId) {
    await chrome.storage.local.remove(['pinnedTabId']);
    try {
      await chrome.notifications.create({
        type: 'basic', iconUrl: 'icon.png',
        title: 'Pinned tab closed',
        message: 'Cap will fall back to the active tab. Re-pin from the Manager when ready.'
      });
    } catch {}
  }
});

// =============== Server command channel ===============
// Subscribe to /events SSE. Receive commands. Execute. POST result.

let eventSource = null;
let reconnectTimer = null;

async function connectEventChannel() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
  const s = await getSettings();
  if (!s.token || !s.serverBase) return;
  if (s.enableRemoteControl === false) return;

  const url = `${s.serverBase.replace(/\/$/, '')}/events?token=${encodeURIComponent(s.token)}`;
  try {
    const es = new EventSource(url);
    eventSource = es;
    es.addEventListener('hello', () => {
      // Connected.
    });
    es.addEventListener('command', async (e) => {
      let cmd;
      try { cmd = JSON.parse(e.data); } catch { return; }
      const result = await runCommand(cmd);
      try {
        await fetch(`${s.serverBase.replace(/\/$/, '')}/command/result`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${s.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id: cmd.id, ...result })
        });
      } catch {}
    });
    es.onerror = () => {
      try { es.close(); } catch {}
      eventSource = null;
      reconnectTimer = setTimeout(connectEventChannel, 4000);
    };
  } catch (err) {
    reconnectTimer = setTimeout(connectEventChannel, 4000);
  }
}

async function runCommand(cmd) {
  try {
    if (cmd.type === 'capture') {
      const res = await captureRegionOrFull({ withSelection: false });
      return { ok: true, payload: res };
    }
    if (cmd.type === 'navigate') {
      const tab = await getTargetTab();
      await chrome.tabs.update(tab.id, { url: cmd.args?.url });
      await waitForTabLoad(tab.id, 15000);
      const fresh = await chrome.tabs.get(tab.id);
      return { ok: true, payload: { url: fresh.url, title: fresh.title } };
    }
    if (cmd.type === 'navigate_and_capture') {
      const tab = await getTargetTab();
      await chrome.tabs.update(tab.id, { url: cmd.args?.url });
      await waitForTabLoad(tab.id, 20000);
      // Give the page a moment after `complete` for late paints.
      await new Promise((r) => setTimeout(r, cmd.args?.settle_ms ?? 800));
      const res = await captureRegionOrFull({ withSelection: false });
      return { ok: true, payload: res };
    }
    if (cmd.type === 'list_tabs') {
      const tabs = await chrome.tabs.query({});
      return { ok: true, payload: { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) } };
    }
    if (cmd.type === 'activate_tab') {
      const id = parseInt(cmd.args?.id, 10);
      await chrome.tabs.update(id, { active: true });
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, payload: { id, url: tab.url, title: tab.title } };
    }
    return { ok: false, error: `unknown command type: ${cmd.type}` };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('navigation timeout'));
    }, timeoutMs);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.serverBase || changes.token || changes.enableRemoteControl) {
    connectEventChannel();
  }
});

chrome.runtime.onStartup.addListener(connectEventChannel);
chrome.runtime.onInstalled.addListener(() => {
  connectEventChannel();
});
connectEventChannel();

// Convenience wrapper used by captureRegionOrFull below.
// Inject the region selector overlay and wait for the user's pick (or Esc).
async function requestRegionSelection(tab) {
  // Detach any previous pending pick.
  pendingSelections.delete(tab.id);

  return new Promise(async (resolve, reject) => {
    pendingSelections.set(tab.id, { resolve, reject });
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['select.js']
      });
    } catch (err) {
      pendingSelections.delete(tab.id);
      // Likely a restricted page (chrome://, chrome-extension://, PDFs). Fall back to full-tab.
      resolve(null);
    }
  });
}

async function captureRegionOrFull({ withSelection = true, forceActive = false } = {}) {
  const s = await getSettings();
  const tab = forceActive ? await getActiveTab() : await getTargetTab();

  let rect = null;
  if (withSelection) {
    try {
      rect = await requestRegionSelection(tab);
    } catch (err) {
      // User cancelled
      return null;
    }
  }

  // Get DPR for accurate crop coordinates.
  let dpr = 1;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.devicePixelRatio || 1
    });
    dpr = result;
  } catch {}

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  let outBlob;
  if (rect && rect.w > 2 && rect.h > 2) {
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    const sx = Math.max(0, Math.floor(rect.x * dpr));
    const sy = Math.max(0, Math.floor(rect.y * dpr));
    const sw = Math.min(bitmap.width - sx, Math.floor(rect.w * dpr));
    const sh = Math.min(bitmap.height - sy, Math.floor(rect.h * dpr));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    outBlob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    outBlob = dataUrlToBlob(dataUrl);
  }

  const meta = await gatherMeta(tab, s);
  meta.region = rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : 'full_tab';
  const result = await uploadCapture(outBlob, meta, s);

  const payload = buildPayload(result, meta, s.clipboardFormat);

  // Persist last result so popup can show it even after notification fades.
  await chrome.storage.local.set({
    lastResult: {
      url: result.url,
      payload,
      meta,
      when: new Date().toISOString()
    }
  });

  let clipboardOk = false;
  if (s.copyClipboard) {
    clipboardOk = await writeClipboard(payload);
  }
  // Badge feedback — visible regardless of OS notification permission.
  try {
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0a7' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 4000);
  } catch {}
  await notify(
    'Screenshot uploaded' + (clipboardOk ? ' (URL on clipboard)' : ''),
    result.url
  );
  return result;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture') {
    const s = await getSettings();
    const withSelection = s.hotkeyMode !== 'full';
    captureRegionOrFull({ withSelection }).catch(async (e) => {
      await notify('Capture failed', e.message);
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cap-region', title: 'Capture region for Claude',
      contexts: ['page', 'image', 'link', 'selection']
    });
    chrome.contextMenus.create({
      id: 'cap-full', title: 'Capture whole tab for Claude',
      contexts: ['page', 'image', 'link', 'selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'cap-region') captureRegionOrFull({ withSelection: true });
  else if (info.menuItemId === 'cap-full') captureRegionOrFull({ withSelection: false });
});

// Selector → background: receives rect or cancel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'cap-selection-result') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    const p = pendingSelections.get(tabId);
    if (!p) return;
    pendingSelections.delete(tabId);
    if (msg.cancelled) p.reject(new Error('cancelled'));
    else p.resolve(msg.rect);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'capture_now') {
    // The hotkey/popup always uses the focused window's active tab, ignoring the pin.
    captureRegionOrFull({ withSelection: msg.withSelection !== false, forceActive: true }).catch(async (e) => {
      await notify('Capture failed', e.message);
    });
    sendResponse({ started: true });
    return;
  }
});
