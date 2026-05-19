const DEFAULTS = {
  serverBase: 'https://cap.fadymondy.com',
  token: '',
  notify: true,
  copyClipboard: true,
  captureNetwork: true,
  captureConsole: true,
  networkWindow: 15000,
  clipboardFormat: 'json',
  enableRemoteControl: true,
  hotkeyMode: 'region'
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('serverBase').value = s.serverBase;
  $('token').value = s.token;
  $('networkWindow').value = s.networkWindow;
  $('notify').checked = s.notify;
  $('copyClipboard').checked = s.copyClipboard;
  $('captureNetwork').checked = s.captureNetwork;
  $('captureConsole').checked = s.captureConsole;
  $('enableRemoteControl').checked = s.enableRemoteControl;
  $('clipboardFormat').value = s.clipboardFormat;
  $('hotkeyMode').value = s.hotkeyMode;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    serverBase: $('serverBase').value.trim(),
    token: $('token').value,
    networkWindow: parseInt($('networkWindow').value || '15000', 10),
    notify: $('notify').checked,
    copyClipboard: $('copyClipboard').checked,
    captureNetwork: $('captureNetwork').checked,
    captureConsole: $('captureConsole').checked,
    enableRemoteControl: $('enableRemoteControl').checked,
    clipboardFormat: $('clipboardFormat').value,
    hotkeyMode: $('hotkeyMode').value
  });
  $('status').textContent = 'Saved';
  setTimeout(() => $('status').textContent = '', 1500);
});

$('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

load();
