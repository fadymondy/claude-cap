#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import CDP from 'chrome-remote-interface';
import http from 'node:http';

const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

// In-memory rolling network log per tab id (CDP target id).
const networkLog = new Map(); // targetId -> [requests]
const consoleLog = new Map(); // targetId -> [entries]
const attachedTargets = new Set();

async function listTabs() {
  const tabs = await CDP.List({ host: CDP_HOST, port: CDP_PORT });
  return tabs.filter(t => t.type === 'page');
}

async function pickActiveTab(preferUrl) {
  const tabs = await listTabs();
  if (!tabs.length) throw new Error('No Chrome tabs available — is Chrome running with --remote-debugging-port=' + CDP_PORT + '?');
  if (preferUrl) {
    const m = tabs.find(t => t.url === preferUrl);
    if (m) return m;
  }
  // The Chrome `/json/list` returns the focused tab first.
  return tabs[0];
}

async function ensureLogs(target) {
  if (attachedTargets.has(target.id)) return;
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target });
  attachedTargets.add(target.id);

  const { Network, Runtime, Log, Console } = client;
  await Network.enable();
  await Runtime.enable();
  await Log.enable().catch(() => {});
  await Console.enable().catch(() => {});

  networkLog.set(target.id, []);
  consoleLog.set(target.id, []);

  const reqs = new Map();
  Network.requestWillBeSent(({ requestId, request, type, initiator }) => {
    reqs.set(requestId, { method: request.method, url: request.url, type, initiator: initiator?.url || initiator?.type, startedAt: Date.now() });
  });
  Network.responseReceived(({ requestId, response, type }) => {
    const r = reqs.get(requestId) || {};
    r.status = response.status;
    r.type = type || r.type;
    r.mime = response.mimeType;
  });
  Network.loadingFinished(({ requestId }) => {
    const r = reqs.get(requestId);
    if (!r) return;
    const buf = networkLog.get(target.id) || [];
    buf.push({
      method: r.method, url: r.url, status: r.status,
      type: r.type, initiator: r.initiator, mime: r.mime,
      duration_ms: Date.now() - r.startedAt
    });
    while (buf.length > 100) buf.shift();
    networkLog.set(target.id, buf);
    reqs.delete(requestId);
  });
  Network.loadingFailed(({ requestId, errorText }) => {
    const r = reqs.get(requestId);
    if (!r) return;
    const buf = networkLog.get(target.id) || [];
    buf.push({ method: r.method, url: r.url, error: errorText, type: r.type });
    while (buf.length > 100) buf.shift();
    networkLog.set(target.id, buf);
    reqs.delete(requestId);
  });

  Runtime.consoleAPICalled((p) => {
    const buf = consoleLog.get(target.id) || [];
    const text = (p.args || []).map(a => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
    buf.push({ level: p.type, text, ts: p.timestamp });
    while (buf.length > 100) buf.shift();
    consoleLog.set(target.id, buf);
  });
  Runtime.exceptionThrown((p) => {
    const buf = consoleLog.get(target.id) || [];
    buf.push({ level: 'error', text: p.exceptionDetails?.text || 'exception', ts: p.timestamp });
    while (buf.length > 100) buf.shift();
    consoleLog.set(target.id, buf);
  });
}

async function captureTab({ targetId, preferUrl, fullPage = false, withConsole = true, withNetwork = true, networkWindow = 15000 }) {
  let target;
  if (targetId) {
    const tabs = await listTabs();
    target = tabs.find(t => t.id === targetId);
    if (!target) throw new Error('Tab id not found: ' + targetId);
  } else {
    target = await pickActiveTab(preferUrl);
  }

  await ensureLogs(target);
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target });
  const { Page, Runtime } = client;
  await Page.enable();

  // Bring tab to foreground if possible.
  await Page.bringToFront().catch(() => {});

  const screenshotOpts = { format: 'png' };
  if (fullPage) screenshotOpts.captureBeyondViewport = true;
  const { data } = await Page.captureScreenshot(screenshotOpts);

  // Page metadata
  const { result: viewport } = await Runtime.evaluate({
    expression: 'JSON.stringify({ vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY })',
    returnByValue: true
  });
  const { result: docTitle } = await Runtime.evaluate({
    expression: 'document.title', returnByValue: true
  });

  const now = Date.now();
  const recentNet = (networkLog.get(target.id) || [])
    .filter((_, idx, arr) => idx >= arr.length - 50);
  const recentConsole = (consoleLog.get(target.id) || []).slice(-30);

  await client.close();

  return {
    base64: data,
    meta: {
      url: target.url,
      title: docTitle.value || target.title,
      viewport: JSON.parse(viewport.value || '{}'),
      tab_id: target.id,
      when: new Date().toISOString(),
      network_requests: withNetwork ? recentNet : undefined,
      console: withConsole ? recentConsole : undefined
    }
  };
}

const server = new Server({ name: 'cap-cdp-mcp', version: '0.1.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'capture_active_tab',
      description: 'Take a screenshot of the active Chrome tab on the user\'s Mac and return it along with the page URL, title, viewport, recent network requests, and console output. Single call for full context.',
      inputSchema: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', default: false, description: 'Capture the entire scrollable page (not just the viewport).' },
          with_console: { type: 'boolean', default: true },
          with_network: { type: 'boolean', default: true }
        },
        additionalProperties: false
      }
    },
    {
      name: 'list_tabs',
      description: 'List all open Chrome tabs (URL + title + id). Use to pick a specific tab for capture_tab.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'capture_tab',
      description: 'Capture a specific Chrome tab by its CDP target id.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          full_page: { type: 'boolean', default: false }
        },
        required: ['tab_id'],
        additionalProperties: false
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'list_tabs') {
      const tabs = await listTabs();
      return {
        content: [{ type: 'text', text: JSON.stringify(tabs.map(t => ({ id: t.id, url: t.url, title: t.title })), null, 2) }]
      };
    }
    if (name === 'capture_active_tab' || name === 'capture_tab') {
      const cap = await captureTab({
        targetId: args.tab_id,
        fullPage: !!args.full_page,
        withConsole: args.with_console !== false,
        withNetwork: args.with_network !== false
      });
      const summary = [
        `URL: ${cap.meta.url}`,
        `Title: ${cap.meta.title}`,
        `Viewport: ${cap.meta.viewport.vw}x${cap.meta.viewport.vh} @ DPR ${cap.meta.viewport.dpr}`,
        `Captured: ${cap.meta.when}`,
        cap.meta.network_requests?.length ? `Network: ${cap.meta.network_requests.length} recent requests` : null,
        cap.meta.console?.length ? `Console: ${cap.meta.console.length} entries` : null
      ].filter(Boolean).join('\n');

      return {
        content: [
          { type: 'image', data: cap.base64, mimeType: 'image/png' },
          { type: 'text', text: summary + '\n\n```json\n' + JSON.stringify({
              url: cap.meta.url, title: cap.meta.title, viewport: cap.meta.viewport,
              network_requests: cap.meta.network_requests, console: cap.meta.console
            }, null, 2) + '\n```' }
        ]
      };
    }
    throw new Error('Unknown tool: ' + name);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: 'Error: ' + (err.message || String(err)) }] };
  }
});

// Choose transport from CLI args.
const httpArg = process.argv.find(a => a.startsWith('--http'));
if (httpArg) {
  const bindRaw = httpArg.includes('=')
    ? httpArg.split('=')[1]
    : (process.argv[process.argv.indexOf(httpArg) + 1] || ':3838');
  const [host, portStr] = bindRaw.startsWith(':')
    ? ['0.0.0.0', bindRaw.slice(1)]
    : (bindRaw.includes(':') ? bindRaw.split(':') : ['0.0.0.0', bindRaw]);

  const transports = new Map(); // sessionId -> SSEServerTransport

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => transports.delete(transport.sessionId));
      await server.connect(transport);
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/messages')) {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Unknown sessionId');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  httpServer.listen(parseInt(portStr, 10), host, () => {
    console.error(`cap-cdp-mcp listening on http://${host}:${portStr}/sse (CDP ${CDP_HOST}:${CDP_PORT})`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cap-cdp-mcp ready on stdio (CDP ${CDP_HOST}:${CDP_PORT})`);
}
