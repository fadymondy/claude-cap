// Content script: draw a fullscreen overlay; user drags a region; send back coords.
(function () {
  // Guard against double-injection.
  if (window.__capSelectorActive) return;
  window.__capSelectorActive = true;

  const overlay = document.createElement('div');
  overlay.id = '__cap_selector__';
  overlay.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(0,0,0,0.30)', 'cursor:crosshair',
    'user-select:none', '-webkit-user-select:none'
  ].join(';') + ';');

  const box = document.createElement('div');
  box.setAttribute('style', [
    'position:absolute', 'border:1px solid #0a7cff',
    'background:rgba(10,124,255,0.15)', 'pointer-events:none',
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.0)'
  ].join(';') + ';');

  const hint = document.createElement('div');
  hint.textContent = 'Drag to select region · Esc cancel · Enter full tab';
  hint.setAttribute('style', [
    'position:absolute', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
    'background:rgba(0,0,0,0.7)', 'color:white',
    'padding:6px 14px', 'border-radius:6px',
    'font:13px/1.4 -apple-system, system-ui, sans-serif',
    'pointer-events:none', 'z-index:2147483647'
  ].join(';') + ';');

  overlay.appendChild(box);
  overlay.appendChild(hint);
  (document.documentElement || document.body).appendChild(overlay);

  let start = null;

  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    window.__capSelectorActive = false;
  }

  // Wait until the browser has repainted at least one frame without the overlay,
  // so chrome.tabs.captureVisibleTab doesn't snapshot the dimmed overlay.
  function afterRepaint(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      chrome.runtime.sendMessage({ type: 'cap-selection-result', cancelled: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cleanup();
      afterRepaint(() => chrome.runtime.sendMessage({ type: 'cap-selection-result', rect: null }));
    }
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    box.style.left = start.x + 'px';
    box.style.top = start.y + 'px';
    box.style.width = '0';
    box.style.height = '0';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    const x1 = Math.min(start.x, e.clientX);
    const y1 = Math.min(start.y, e.clientY);
    box.style.left = x1 + 'px';
    box.style.top = y1 + 'px';
    box.style.width = Math.abs(e.clientX - start.x) + 'px';
    box.style.height = Math.abs(e.clientY - start.y) + 'px';
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!start) return;
    const end = { x: e.clientX, y: e.clientY };
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y)
    };
    cleanup();
    afterRepaint(() => chrome.runtime.sendMessage({ type: 'cap-selection-result', rect }));
  });

  document.addEventListener('keydown', onKey, true);
})();
