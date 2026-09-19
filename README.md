# Axy Router

Lightweight SaaS-style AI gateway built with Go, designed for Koyeb.

## Koyeb deployment

Create a **Web Service** from this GitHub repository and choose **Dockerfile** as the build/deploy method. Koyeb supplies the runtime `PORT`; Axy Router reads it automatically.

Set these environment variables:

- `AXY_PIN` — admin PIN
- `SESSION_SECRET` — long random secret

No fixed public port is required in the application.

### Health check

`GET /api/health`

### Persistent data

Provider configuration is stored in `data/axy-router.db`. Use persistent storage if you need provider settings to survive a service replacement/redeploy.

## Local

```bash
go mod tidy
AXY_PIN=123456 SESSION_SECRET=change-me go run .
```

Open `http://localhost:3000`.

## Docker

```bash
docker build -t axy-router .
docker run -p 3000:3000 -e AXY_PIN=123456 -e SESSION_SECRET=change-me axy-router
```

## API

- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /api/health`
- `GET/POST /api/providers` (admin session required)
