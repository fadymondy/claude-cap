# cap-server

Tiny upload server for the Screenshot Tray app.

- `POST /upload` (Bearer auth) — multipart `file=...`, returns `{url, sha256}`
- `GET /s/<name>` — serves uploaded files
- `GET /healthz` — health check

## Env

- `CAP_TOKEN` (required) — Bearer token clients must send
- `CAP_PUBLIC_BASE` (default `https://cap.local`) — origin used to build returned URL

## Deploy (CT 117)

```bash
docker build -t cap-server:latest server/
docker run -d --name cap-server --restart=always \
  -p 8585:8585 \
  -e CAP_TOKEN=<token> \
  -e CAP_PUBLIC_BASE=https://cap.local \
  -v /opt/cap/screenshots:/data/screenshots \
  cap-server:latest
```
