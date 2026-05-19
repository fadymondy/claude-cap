const $ = (id) => document.getElementById(id);

function fireCapture(withSelection) {
  try {
    chrome.runtime.sendMessage({ type: 'capture_now', withSelection }, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
  // Close popup so the page receives the selection overlay input.
  window.close();
}

async function showLastResult() {
  const { lastResult } = await chrome.storage.local.get(['lastResult']);
  if (!lastResult) return;
  const el = $('last');
  const link = document.createElement('a');
  link.href = lastResult.url;
  link.textContent = '⤓ ' + lastResult.url;
  link.style.cssText = 'display:block;font-size:11px;color:#0a7cff;word-break:break-all;margin-top:6px;text-decoration:none;';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: lastResult.url });
  });
  el.innerHTML = '';
  el.append(
    Object.assign(document.createElement('div'), {
      textContent: 'Last: ' + new Date(lastResult.when).toLocaleTimeString(),
      style: 'font-size:11px;color:#888;margin-top:8px;'
    }),
    link
  );
}

$('capture-region').addEventListener('click', () => fireCapture(true));
$('capture-full').addEventListener('click', () => fireCapture(false));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('manager').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
  window.close();
});

showLastResult();
