// Runs in the page's MAIN world at document_start so it sees every console call
// from the very first script that executes. The captured log is held on
// window.__capConsoleLog and read by the background at capture time via
// chrome.scripting.executeScript({world: 'MAIN'}).
(function () {
  if (window.__capConsoleTapInstalled) return;
  window.__capConsoleTapInstalled = true;
  window.__capConsoleLog = [];

  function safeStringify(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) return v.stack || v.message;
    try {
      return JSON.stringify(v, (k, val) => {
        if (typeof val === 'function') return '[fn]';
        if (val instanceof Element) return '<' + val.tagName.toLowerCase() + '>';
        return val;
      });
    } catch {
      try { return String(v); } catch { return '[unserializable]'; }
    }
  }

  function push(level, args) {
    try {
      const text = Array.from(args).map(safeStringify).join(' ');
      window.__capConsoleLog.push({
        level,
        text: text.length > 2000 ? text.slice(0, 2000) + '…' : text,
        ts: Date.now()
      });
      while (window.__capConsoleLog.length > 300) window.__capConsoleLog.shift();
    } catch {}
  }

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const lvl of levels) {
    const orig = console[lvl].bind(console);
    console[lvl] = function () {
      push(lvl, arguments);
      return orig.apply(console, arguments);
    };
  }

  window.addEventListener('error', (e) => {
    push('error', ['Uncaught:', e.message || e.error?.message || '', e.filename + ':' + e.lineno]);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['UnhandledRejection:', e.reason?.message || e.reason]);
  }, true);
})();
