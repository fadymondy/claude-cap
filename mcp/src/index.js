#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import https from 'node:https';
import http from 'node:http';

const CAP_BASE = (process.env.CAP_BASE || 'https://cap.local').replace(/\/$/, '');
const CAP_TOKEN = process.env.CAP_TOKEN || '';
const INSECURE_TLS = process.env.CAP_INSECURE_TLS !== '0';

if (!CAP_TOKEN) {
  console.error('CAP_TOKEN env required');
  process.exit(1);
}

function request(pathOrUrl, { method = 'GET', json: jsonBody, timeoutMs = 45000 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${CAP_BASE}${pathOrUrl}`;
  const u = new URL(url);
  const client = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${CAP_TOKEN}` };
    let payload = null;
    if (jsonBody !== undefined) {
      payload = Buffer.from(JSON.stringify(jsonBody));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = client.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: !INSECURE_TLS
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${body.toString().slice(0, 300)}`));
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendCommand(type, args = {}, timeoutMs = 45000) {
  const { body } = await request('/command', {
    method: 'POST',
    json: { type, args, timeout_ms: Math.max(5000, timeoutMs - 5000) },
    timeoutMs
  });
  return JSON.parse(body.toString());
}

async function statusInfo() {
  try {
    const { body } = await request('/status');
    return JSON.parse(body.toString());
  } catch {
    return { extension_connected: false, extension_count: 0 };
  }
}

async function listScreenshots(limit = 10) {
  const { body } = await request('/list?limit=' + limit);
  return JSON.parse(body.toString());
}

async function fetchImage(idOrUrl) {
  const path = idOrUrl.startsWith('http')
    ? idOrUrl
    : (idOrUrl.startsWith('/s/') ? idOrUrl : '/s/' + idOrUrl);
  const { body, headers } = await request(path);
  return {
    base64: body.toString('base64'),
    mimeType: headers['content-type'] || 'image/png',
    size: body.length
  };
}

function summarizeMeta(meta) {
  if (!meta) return 'No metadata recorded for this screenshot.';
  const lines = [];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.url) lines.push(`Page URL: ${meta.url}`);
  if (meta.viewport) lines.push(`Viewport: ${meta.viewport}`);
  if (meta.when) lines.push(`Captured: ${meta.when}`);
  if (meta.region) lines.push(`Region: ${typeof meta.region === 'string' ? meta.region : JSON.stringify(meta.region)}`);
  if (meta.user_agent) lines.push(`UA: ${meta.user_agent.slice(0, 100)}`);
  if (meta.network_requests?.length) {
    lines.push('', `Recent network (${meta.network_requests.length}):`);
    for (const r of meta.network_requests.slice(-15)) {
      const status = r.status ? r.status : (r.error ? `err:${r.error}` : '?');
      const t = r.type ? `[${r.type}]` : '';
      const dur = r.duration_ms != null ? ` ${r.duration_ms}ms` : '';
      lines.push(`  ${r.method} ${status} ${t}${dur} ${r.url}`);
    }
  }
  if (meta.console?.length) {
    lines.push('', `Console (${meta.console.length}):`);
    for (const c of meta.console.slice(-20)) {
      lines.push(`  [${c.level}] ${c.text}`);
    }
  }
  return lines.join('\n');
}

const server = new Server({ name: 'cap-mcp', version: '0.2.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'capture_now',
      description: 'Trigger the Chrome extension to capture the user\'s currently active tab right now, upload it, then return the image plus full metadata (page URL, title, viewport, recent network requests, console logs). Use this for live "look at my screen" requests without needing the user to press the hotkey.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'navigate_and_capture',
      description: 'Tell the extension to navigate the active tab to a URL, wait for it to load, then capture and return the screenshot + metadata. Use this when you want to inspect a specific page (e.g., reproduce a bug by visiting a route).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to load into the active tab.' },
          settle_ms: { type: 'number', default: 800, description: 'Extra wait after onload, lets React/SPA paints settle.' }
        },
        required: ['url'],
        additionalProperties: false
      }
    },
    {
      name: 'navigate',
      description: 'Navigate the active tab to a URL without capturing. Use when you need to drive the browser somewhere before doing other work.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false
      }
    },
    {
      name: 'list_open_tabs',
      description: 'List the user\'s currently open Chrome tabs (id, URL, title, active). Useful before activate_tab.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'activate_tab',
      description: 'Bring a specific tab to the foreground by its id (from list_open_tabs).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
        additionalProperties: false
      }
    },
    {
      name: 'pin_tab',
      description: 'Pin a specific tab as the MCP target. After pinning, capture_now/navigate/navigate_and_capture will always hit THIS tab — even if the user is browsing other tabs in the foreground. Use this when the user says "always look at the dashboard tab" or "watch this page".',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Tab id from list_open_tabs.' } },
        required: ['id'],
        additionalProperties: false
      }
    },
    {
      name: 'unpin_tab',
      description: 'Stop targeting a pinned tab. After this, MCP commands hit whatever tab is currently active in Chrome.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'get_pinned_tab',
      description: 'Check whether a tab is currently pinned and which one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'screenshot_latest',
      description: 'Fetch the most recent screenshot uploaded from the Chrome extension on the user\'s Mac. Returns the image along with the page URL, title, viewport, and the network requests that fired in the seconds leading up to the capture. Use this whenever the user says "look at my screen", "what do you see", "check my latest screenshot", or refers to a recent capture.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'screenshot_latest_meta',
      description: 'Fast metadata-only check — returns the URL, page URL, title, and network requests of the latest screenshot without downloading the image. Use this when you only need to know what page the user is on or what requests fired, without inspecting the visual.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'screenshot_list',
      description: 'List recent screenshots with id, URL, page URL, title, size, and timestamp. Use when the user references multiple captures or wants to pick a specific one.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 10, minimum: 1, maximum: 50 }
        },
        additionalProperties: false
      }
    },
    {
      name: 'screenshot_get',
      description: 'Fetch a specific screenshot by id or URL — returns the image and its full metadata. Use after screenshot_list to inspect a particular capture.',
      inputSchema: {
        type: 'object',
        properties: {
          id_or_url: { type: 'string', description: 'Image filename (e.g. 1779135853-abc.png) or full URL.' }
        },
        required: ['id_or_url'],
        additionalProperties: false
      }
    },
    {
      name: 'screenshot_find_by_page',
      description: 'Find screenshots taken on pages matching a URL substring or regex. Use when the user says "the screenshot I took on the dashboard" or refers to a specific app/page.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring or regex matched against page URL or title.' },
          limit: { type: 'number', default: 5, minimum: 1, maximum: 20 }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  ]
}));

async function captureViaExtension(args = {}) {
  const status = await statusInfo();
  if (!status.extension_connected) {
    throw new Error('Chrome extension not connected to the server. Open Chrome and make sure the Cap extension is loaded.');
  }
  const res = await sendCommand('capture', args, 40000);
  if (!res.ok) throw new Error(res.error || 'capture failed');
  return res.payload; // { url, meta_url, sha256 }
}

async function navigateAndCaptureViaExtension(args) {
  const status = await statusInfo();
  if (!status.extension_connected) {
    throw new Error('Chrome extension not connected.');
  }
  const res = await sendCommand('navigate_and_capture', args, 50000);
  if (!res.ok) throw new Error(res.error || 'navigate_and_capture failed');
  return res.payload;
}

async function buildScreenshotResponse(payload) {
  // payload has { url, meta_url } — fetch the freshly uploaded image + its metadata.
  const img = await fetchImage(payload.url);
  // Find this image in /list to pick up its meta sidecar.
  const list = await listScreenshots(5);
  const item = list.items.find(it => it.url === payload.url);
  return {
    content: [
      { type: 'image', data: img.base64, mimeType: img.mimeType },
      {
        type: 'text',
        text: `Image URL: ${payload.url}\nSize: ${img.size} bytes\n\n${summarizeMeta(item?.meta)}`
      }
    ]
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'capture_now') {
      const payload = await captureViaExtension();
      return await buildScreenshotResponse(payload);
    }
    if (name === 'navigate_and_capture') {
      const payload = await navigateAndCaptureViaExtension(args);
      return await buildScreenshotResponse(payload);
    }
    if (name === 'navigate') {
      const res = await sendCommand('navigate', { url: args.url }, 25000);
      if (!res.ok) throw new Error(res.error || 'navigate failed');
      return { content: [{ type: 'text', text: `Navigated to ${res.payload.url} — ${res.payload.title || ''}` }] };
    }
    if (name === 'list_open_tabs') {
      const res = await sendCommand('list_tabs', {}, 15000);
      if (!res.ok) throw new Error(res.error || 'list_tabs failed');
      const tabs = res.payload.tabs || [];
      const text = tabs.map(t => `${t.active ? '►' : ' '} [${t.id}] ${t.title}\n      ${t.url}`).join('\n\n') || '(no tabs)';
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'activate_tab') {
      const res = await sendCommand('activate_tab', { id: args.id }, 15000);
      if (!res.ok) throw new Error(res.error || 'activate_tab failed');
      return { content: [{ type: 'text', text: `Activated tab ${args.id}: ${res.payload.title} — ${res.payload.url}` }] };
    }
    if (name === 'pin_tab') {
      const res = await sendCommand('pin_tab', { id: args.id }, 15000);
      if (!res.ok) throw new Error(res.error || 'pin_tab failed');
      return { content: [{ type: 'text', text: `📌 Pinned tab ${res.payload.pinned_tab_id}: ${res.payload.title} — ${res.payload.url}` }] };
    }
    if (name === 'unpin_tab') {
      const res = await sendCommand('unpin_tab', {}, 10000);
      if (!res.ok) throw new Error(res.error || 'unpin_tab failed');
      return { content: [{ type: 'text', text: 'Unpinned. MCP will use the active tab.' }] };
    }
    if (name === 'get_pinned_tab') {
      const res = await sendCommand('get_pin', {}, 10000);
      if (!res.ok) throw new Error(res.error || 'get_pin failed');
      const p = res.payload;
      const text = p.pinned
        ? `📌 Pinned tab ${p.tab_id}: ${p.title} — ${p.url}${p.active ? ' (currently active)' : ''}`
        : 'No tab pinned.';
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'screenshot_list') {
      const list = await listScreenshots(args.limit || 10);
      const text = list.items.map((it, i) => {
        const m = it.meta || {};
        return `${i + 1}. ${it.id}\n   when: ${it.when}  size: ${it.size}\n   url: ${it.url}\n   page: ${m.title || ''} — ${m.url || ''}`;
      }).join('\n\n') || '(no screenshots)';
      return { content: [{ type: 'text', text: `${list.count} screenshot(s):\n\n${text}` }] };
    }

    if (name === 'screenshot_latest_meta') {
      const list = await listScreenshots(1);
      if (!list.items?.length) {
        return { content: [{ type: 'text', text: 'No screenshots available yet.' }] };
      }
      const it = list.items[0];
      return {
        content: [{
          type: 'text',
          text: `Image URL: ${it.url}\nSize: ${it.size} bytes\n\n${summarizeMeta(it.meta)}`
        }]
      };
    }

    if (name === 'screenshot_latest') {
      const list = await listScreenshots(1);
      if (!list.items?.length) {
        return { content: [{ type: 'text', text: 'No screenshots available yet — ask the user to capture one with ⌘⇧9.' }] };
      }
      const it = list.items[0];
      const img = await fetchImage(it.url);
      return {
        content: [
          { type: 'image', data: img.base64, mimeType: img.mimeType },
          { type: 'text', text: `Image URL: ${it.url}\nSize: ${img.size} bytes\n\n${summarizeMeta(it.meta)}` }
        ]
      };
    }

    if (name === 'screenshot_get') {
      const idOrUrl = args.id_or_url;
      const img = await fetchImage(idOrUrl);
      // Try to find metadata via /list match (cheap; small dataset).
      const list = await listScreenshots(50);
      const matched = list.items.find(it => it.id === idOrUrl || it.url === idOrUrl || it.url.endsWith('/' + idOrUrl));
      return {
        content: [
          { type: 'image', data: img.base64, mimeType: img.mimeType },
          {
            type: 'text',
            text: `Image URL: ${matched?.url || idOrUrl}\nSize: ${img.size} bytes\n\n${summarizeMeta(matched?.meta)}`
          }
        ]
      };
    }

    if (name === 'screenshot_find_by_page') {
      const list = await listScreenshots(50);
      const q = args.query;
      let re;
      try { re = new RegExp(q, 'i'); } catch { re = null; }
      const hits = list.items.filter(it => {
        const haystack = `${it.meta?.url || ''} ${it.meta?.title || ''}`;
        return re ? re.test(haystack) : haystack.toLowerCase().includes(q.toLowerCase());
      }).slice(0, args.limit || 5);

      if (!hits.length) {
        return { content: [{ type: 'text', text: `No screenshots match "${q}".` }] };
      }
      const text = hits.map((it, i) =>
        `${i + 1}. ${it.id}\n   when: ${it.when}\n   url: ${it.url}\n   page: ${it.meta?.title || ''} — ${it.meta?.url || ''}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${hits.length} match(es):\n\n${text}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('cap-mcp ready, base=' + CAP_BASE);
