# Axy Router v1

Lightweight AI gateway in Go.

## Included
- PIN-only admin login
- Responsive Android + desktop dashboard
- SQLite provider storage
- OpenAI-compatible /v1/models
- OpenAI-compatible /v1/chat/completions
- Docker multi-stage build
- Koyeb PORT handling

## Local
```bash
go mod tidy
AXY_PIN=123456 SESSION_SECRET=change-me go run .
```

Open http://localhost:3000.

## Docker
```bash
docker build -t axy-router .
docker run -p 3000:3000 -e AXY_PIN=123456 -e SESSION_SECRET=change-me axy-router
```

## Koyeb
Deploy the repository as a Docker Web Service. Axy Router reads the injected PORT automatically.

Set AXY_PIN and SESSION_SECRET in the service environment. SQLite is stored in data/axy-router.db, so persistent storage is required if provider configuration must survive a replacement.
