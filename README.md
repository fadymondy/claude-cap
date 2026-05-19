# claude-cap

Capture a Chrome tab — image + the URL + the title + recent network requests + console logs — and hand the whole bundle to Claude through MCP.

Stop pasting screenshots into Claude one by one. With `claude-cap`, Claude pulls the live state of your browser whenever it needs to.

---

## What it does

| | |
|---|---|
| 🖼️ **Captures** | Active tab (or a pinned one), region or full, via hotkey, click, or MCP call |
| 📋 **Bundles context** | Page URL, title, viewport, last ~25 network requests with duration, last ~30 console entries |
| ☁️ **Uploads** | Tiny Go server on your own host, public URL returned, served over HTTPS |
| 🤖 **MCP tools** | Claude Code / Claude Desktop can list, fetch, trigger captures, navigate, pin tabs — all in-conversation |
| 📌 **Pin a tab** | Tell the extension "always capture this tab" — Claude looks at it even when you're browsing elsewhere |
| 🗂️ **Manager UI** | Built-in extension page: login, grid of captures, copy URL/JSON, delete |

## Architecture

```
┌──────────────────┐       SSE        ┌──────────────────┐
│  Chrome extension│ ◄────────────────│   cap-server     │
│  (manifest v3)   │ ──── upload ───► │   (Go, HTTPS)    │
│  ⌘⇧9 / Manager   │  + result POST   │   /upload /list  │
└──────────────────┘                  │   /events /command│
        ▲                             └────────┬─────────┘
        │ remote command                       │ HTTPS GET
        │                                      ▼
        │                            ┌──────────────────┐
        └────────────────────────────│  cap MCP server  │
                                     │   (Node, stdio)  │
                                     └────────┬─────────┘
                                              │
                                              ▼
                                     ┌──────────────────┐
                                     │  Claude Code /   │
                                     │  Claude Desktop  │
                                     └──────────────────┘
```

The extension keeps an SSE connection open to the server. When Claude calls `capture_now` through the MCP, the MCP POSTs a command to the server, the server fans it out over SSE, the extension executes the capture, uploads the result, the server replies to the original POST with the upload URL, and the MCP fetches the image bytes and hands them back to Claude.

## Components

```
server/       Go HTTP server  → /upload /list /delete /login /events /command /status
extension/    Chrome MV3 ext  → hotkey + region selector + manager + remote-controlled
mcp/          Node MCP server → tools Claude can call (stdio transport)
cdp-mcp/      Alt MCP that drives Chrome directly via CDP (no extension needed)
app/          Legacy Electron tray app (superseded by the extension)
```

## Quick start

### 1. Deploy the server

You need a host with HTTPS and a domain. Either:

**a) Docker on any Linux box**
```bash
cd server
docker build -t cap-server:latest .
docker run -d --name cap-server --restart=always \
  -p 8585:8585 \
  -e CAP_TOKEN=$(openssl rand -hex 24) \
  -e CAP_LOGIN_PASSWORD=changeme \
  -e CAP_PUBLIC_BASE=https://cap.example.com \
  -v /opt/cap/screenshots:/data/screenshots \
  cap-server:latest
```

**b) Binary + systemd**
```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o cap-server ./server
scp cap-server root@your-host:/usr/local/bin/
# Then create a systemd unit pointing at it (see server/README.md).
```

Front it with nginx / Caddy / Cloudflare Tunnel so it's reachable at `https://cap.example.com`.

### 2. Install the Chrome extension

```
chrome://extensions  →  enable Developer mode  →  Load unpacked  →  pick `extension/`
```

Click the extension icon → **Manager** → log in with the `CAP_LOGIN_PASSWORD` you set. The extension stores the bearer token in sync storage automatically.

### 3. Hook up the MCP

On the machine where you run Claude Code (or Claude Desktop):

```bash
cd mcp && npm install
```

For Claude Code (CLI):
```bash
claude mcp add --scope user cap \
  -e CAP_BASE=https://cap.example.com \
  -e CAP_TOKEN=<your-bearer-token> \
  -- node /absolute/path/to/mcp/src/index.js
```

For Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "cap": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/src/index.js"],
      "env": {
        "CAP_BASE": "https://cap.example.com",
        "CAP_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

Restart the Claude session. You'll see `cap` show up under `/mcp` (or in the Settings → Developer panel) as ✓ Connected.

## Using it from Claude

In any conversation:

> Take a screenshot of my current tab and tell me what's broken on the page.

Claude calls `mcp__cap__capture_now`. The MCP triggers the extension over SSE, the extension grabs the visible tab, uploads to `cap-server`, and the MCP returns the image + page URL + recent network calls + console errors back to Claude. All inline.

Other useful prompts:
- *"List my open Chrome tabs and pin the one showing the admin panel"* → `list_open_tabs` + `pin_tab`
- *"Navigate to /settings and show me what loaded"* → `navigate_and_capture`
- *"What was the last 5 screenshots I took, and what page were they on?"* → `screenshot_list`
- *"Look at the screenshot I took on the dashboard page"* → `screenshot_find_by_page`

## MCP tool reference

| Tool | What it does |
|---|---|
| `capture_now` | Trigger the extension to capture the pinned (or active) tab right now, return image + meta |
| `navigate_and_capture` | Navigate the pinned tab to a URL, wait for load, capture, return image + meta |
| `navigate` | Navigate without capturing |
| `list_open_tabs` | List all Chrome tabs (id, URL, title, active) |
| `activate_tab` | Bring a specific tab to the foreground |
| `pin_tab` / `unpin_tab` / `get_pinned_tab` | Manage which tab the MCP targets |
| `screenshot_latest` | Fetch the newest uploaded screenshot + meta |
| `screenshot_latest_meta` | Metadata only — fast |
| `screenshot_list` | List recent screenshots with timestamps and pages |
| `screenshot_get` | Fetch a specific screenshot by id/URL |
| `screenshot_find_by_page` | Search screenshots by URL or title substring/regex |

## Extension features

- **Region selection**: ⌘⇧9 brings up a crosshair overlay (Esc cancels, Enter skips selection)
- **Hotkey mode toggle**: Region vs full visible tab in Options
- **Tab pin for MCP**: Manager → click a tab → *Pin for MCP* → Claude always hits that tab
- **Console + network tap**: Content script injects at `document_start` to catch every console call from page load; webRequest captures fetch/XHR with duration
- **Clipboard payload**: After every capture, the URL + full metadata JSON (or Markdown) lands on your system clipboard
- **Manager UI**: Built-in `manager.html` with login, grid, copy/inspect/delete

## Server endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | liveness |
| `POST` | `/login` | password body | exchange a friendly password for the bearer token |
| `POST` | `/upload` | Bearer | multipart `file=` + optional `meta=JSON`, returns `{url, meta_url, sha256}` |
| `GET` | `/list?limit=` | Bearer | recent screenshots with meta |
| `GET` | `/s/<name>` | none | serve uploaded image |
| `GET` | `/m/<id>.json` | none | serve metadata sidecar |
| `DELETE` | `/delete/<name>` | Bearer | remove screenshot + meta |
| `GET` | `/events?token=` | query token | SSE stream of commands (extension subscribes) |
| `POST` | `/command` | Bearer | enqueue a command; blocks until extension result |
| `POST` | `/command/result` | Bearer | extension reports back |
| `GET` | `/status` | Bearer | how many extensions are connected |

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CAP_TOKEN` | (required) | Bearer token for all admin endpoints |
| `CAP_PUBLIC_BASE` | `https://cap.local` | Origin used in returned URLs |
| `CAP_LOGIN_PASSWORD` | (unset) | Optional friendly password for `/login`. Without it, only the raw token works |

## Security model

- All admin endpoints require `Authorization: Bearer ${CAP_TOKEN}`.
- The extension stores the token in `chrome.storage.sync` (encrypted at rest, synced via your Google profile). Self-host only: do not commit tokens.
- Uploads are capped at 50 MB and limited to `.png/.jpg/.jpeg/.gif/.webp`.
- Public read paths (`/s/`, `/m/`) are intentionally unauthenticated so Claude can fetch the image after upload. Treat the random id as the secret. If that's not acceptable, put the server behind Cloudflare Access or a similar auth layer.

## License

MIT — see [LICENSE](./LICENSE).

## Related

- [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol this MCP server speaks
- [Claude Code](https://claude.com/claude-code) — the CLI agent it's designed for

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
