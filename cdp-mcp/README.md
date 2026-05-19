# cap-cdp-mcp

MCP that drives the user's running Chrome via CDP (Chrome DevTools Protocol) — Claude calls one tool and gets:

- Screenshot of the active tab
- Page URL + title + viewport
- Last ~50 network requests on that tab
- Last ~30 console entries

No extension needed. No upload step. The MCP itself does the capture.

## Setup

### 1) Launch Chrome with debug port

On Mac, kill all Chrome instances first, then launch with the debug flag:

```bash
killall "Google Chrome"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome" &
```

(Keeping the same `--user-data-dir` preserves your sessions, extensions, bookmarks. The port is only listening on `127.0.0.1` by default.)

Verify:
```bash
curl -s http://127.0.0.1:9222/json/version | jq .
```

### 2) Install + run the MCP

```bash
cd /Users/fadymondy/Sites/screenshot-tray/cdp-mcp
npm install
```

### 3a) Use from Claude Desktop / Claude Code on Mac (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "cap-cdp": {
      "command": "node",
      "args": ["/Users/fadymondy/Sites/screenshot-tray/cdp-mcp/src/index.js"]
    }
  }
}
```

### 3b) Use from Claude Code on vs.local (HTTP/SSE)

On the Mac, run as daemon:
```bash
node /Users/fadymondy/Sites/screenshot-tray/cdp-mcp/src/index.js --http :3838
```

Then on vs.local (CT 102), add to Claude Code config:
```json
{
  "mcpServers": {
    "cap-cdp": {
      "url": "http://<mac-lan-ip>:3838/sse"
    }
  }
}
```

## Tools

- `capture_active_tab` — main one. Returns image + URL/title/viewport/network/console
- `list_tabs` — pick a tab when there are many
- `capture_tab` — grab a specific tab by id
