const { app, Tray, Menu, globalShortcut, clipboard, Notification, dialog, BrowserWindow, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tray = null;
let settings = null;

const DEFAULTS = {
  serverBase: 'https://cap.local',
  token: '',
  hotkey: 'CommandOrControl+Shift+9',
  notify: true,
  insecureTLS: true,
  saveLocal: true,
  localDir: path.join(os.homedir(), 'Screenshots', 'tray')
};

async function loadSettings() {
  const { default: Store } = await import('electron-store');
  settings = new Store({ defaults: DEFAULTS });
  if (settings.get('saveLocal') && !fs.existsSync(settings.get('localDir'))) {
    fs.mkdirSync(settings.get('localDir'), { recursive: true });
  }
}

function notify(title, body) {
  if (!settings.get('notify')) return;
  new Notification({ title, body, silent: false }).show();
}

function takeScreenshot() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpPath = path.join(os.tmpdir(), `screenshot-${ts}.png`);

  // `-i` interactive region/window selector. User presses Esc to cancel.
  const proc = spawn('/usr/sbin/screencapture', ['-i', '-t', 'png', tmpPath], {
    stdio: 'ignore'
  });

  proc.on('exit', async (code) => {
    if (code !== 0 || !fs.existsSync(tmpPath)) {
      // user cancelled (Esc) — silent
      return;
    }
    try {
      await upload(tmpPath);
    } catch (err) {
      notify('Upload failed', err.message || String(err));
    } finally {
      if (settings.get('saveLocal')) {
        const dst = path.join(settings.get('localDir'), path.basename(tmpPath));
        try { fs.copyFileSync(tmpPath, dst); } catch {}
      }
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });
}

async function upload(filePath) {
  const base = settings.get('serverBase').replace(/\/$/, '');
  const token = settings.get('token');
  if (!token) {
    notify('No token configured', 'Open Settings → set the upload token.');
    return;
  }

  const buf = fs.readFileSync(filePath);
  const boundary = '----capboundary' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n` +
    `Content-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);

  const url = `${base}/upload`;
  const u = new URL(url);
  const useHttps = u.protocol === 'https:';
  const http = require(useHttps ? 'node:https' : 'node:http');

  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (useHttps ? 443 : 80),
    path: u.pathname,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };
  if (useHttps && settings.get('insecureTLS')) {
    opts.rejectUnauthorized = false; // local CA, self-signed
  }

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(text);
          clipboard.writeText(json.url);
          notify('Screenshot uploaded', json.url);
          resolve(json.url);
        } catch (e) {
          reject(new Error('Invalid server response: ' + text.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function openSettingsWindow() {
  const win = new BrowserWindow({
    width: 480, height: 520, resizable: false, fullscreenable: false,
    title: 'Screenshot Tray — Settings',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  win.removeMenu();
}

function rebuildTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!tray) {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } else {
    tray.setImage(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  }
  tray.setToolTip('Screenshot Tray');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Take Screenshot (${settings.get('hotkey')})`, click: takeScreenshot },
    { type: 'separator' },
    { label: 'Settings…', click: openSettingsWindow },
    { label: `Server: ${settings.get('serverBase')}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]));
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.get('hotkey');
  const ok = globalShortcut.register(key, takeScreenshot);
  if (!ok) {
    dialog.showErrorBox('Hotkey error', `Could not register hotkey "${key}". Pick another in Settings.`);
  }
}

async function main() {
  await loadSettings();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  rebuildTray();
  registerHotkey();
}

const { ipcMain } = require('electron');
ipcMain.handle('settings:get', () => settings.store);
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) settings.set(k, v);
  rebuildTray();
  registerHotkey();
  return settings.store;
});

app.whenReady().then(main);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { e.preventDefault(); });
