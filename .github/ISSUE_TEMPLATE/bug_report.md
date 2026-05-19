---
name: Bug report
about: Something isn't working
title: '[bug] '
labels: bug
---

**Component**
- [ ] server (Go)
- [ ] extension (Chrome)
- [ ] mcp (Node)
- [ ] cdp-mcp (alternative)

**What happened**
A short description.

**Reproduction**
1.
2.
3.

**Expected**

**Actual**

**Logs**
- `journalctl -u cap-server --no-pager -n 50` (server)
- `chrome://extensions` → Cap → Service worker → Console (extension)
- `claude mcp list` (mcp connection)

**Environment**
- OS:
- Chrome version:
- Claude client (Code / Desktop) + version:
- Server version (git SHA):
