# Changelog

All notable changes to claude-cap will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — semver.

## [Unreleased]

## [0.1.0] - 2026-05-19

Initial public release.

### Added
- Go upload server (`server/`) — single binary, Docker image, `/upload` `/list` `/delete` `/login` `/events` `/command` `/status` `/healthz`
- Chrome MV3 extension (`extension/`)
  - ⌘⇧9 hotkey with region selector overlay (Esc cancels, Enter skips selection)
  - Hotkey mode toggle in Options: region vs full visible tab
  - Right-click context menu: "Capture region for Claude" / "Capture whole tab for Claude"
  - Console log tap (MAIN-world content script at `document_start`) and uncaught error capture
  - Network request tap via webRequest API with duration tracking
  - Clipboard payload formats: JSON (default) / Markdown / URL-only
  - Tab pin for MCP — manager UI lets you pin a specific tab as Claude's target
  - Manager page (`manager.html`) — login, screenshots grid, copy URL/JSON, view metadata, delete
  - Remote-control SSE channel: server can drive captures and navigation
- MCP server (`mcp/`) — Node stdio
  - `capture_now`, `navigate_and_capture`, `navigate` — live capture/navigation
  - `list_open_tabs`, `activate_tab`, `pin_tab`, `unpin_tab`, `get_pinned_tab`
  - `screenshot_latest`, `screenshot_latest_meta`, `screenshot_list`, `screenshot_get`, `screenshot_find_by_page`
- Alternative `cdp-mcp/` — Chrome DevTools Protocol-based MCP for users who don't want to install the extension
- Legacy Electron tray app (`app/`) — superseded by the extension but kept for reference

### Security
- Bearer-token auth on all admin endpoints
- Optional friendly login password via `CAP_LOGIN_PASSWORD`
- File-type allowlist + 50 MB upload cap
- Wildcard TLS via NPM/Caddy in front; server itself listens plain HTTP on `:8585`
