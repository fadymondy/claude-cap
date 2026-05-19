# cap-mcp

MCP server exposing screenshots from `cap.local` as image content to Claude.

## Tools

- `screenshot_latest` — fetch newest screenshot as image content
- `screenshot_list` — list recent screenshots
- `screenshot_get` — fetch a specific one by id/URL

## Setup on vs.local (CT 102)

```bash
cd /opt/cap-mcp
npm install
```

Add to Claude Code MCP config (`~/.claude/mcp.json` or repo-local `.mcp.json`):

```json
{
  "mcpServers": {
    "cap": {
      "command": "node",
      "args": ["/opt/cap-mcp/src/index.js"],
      "env": {
        "CAP_BASE": "https://cap.local",
        "CAP_TOKEN": "<the-bearer-token>",
        "CAP_INSECURE_TLS": "1"
      }
    }
  }
}
```

Then in Claude Code:

> Take a screenshot, then look at it.

Claude calls `screenshot_latest`, gets the image inline.
