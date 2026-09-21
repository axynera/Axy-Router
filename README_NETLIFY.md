# Axy-Router — Netlify

Axy-Router now has a dedicated Netlify Edge deployment path.

## Two deployment modes

### Full Docker/Bun mode
The existing application keeps its full local-database architecture: Elysia, Bun SQLite, admin dashboard, telemetry, database import/export, and provider/key management. Use this mode on Docker/VPS.

### Netlify Edge mode
Netlify uses `netlify/edge-functions/api.ts`, which is deliberately stateless and uses Web APIs plus Netlify environment variables.

Supported endpoints:
- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- OpenAI-compatible streaming passthrough
- Anthropic-compatible non-stream adapter
- client API-key authentication
- model aliasing
- provider credential round-robin
- generic provider Base URL + API keys

The Netlify layer does not load the Bun SQLite/admin modules, because the existing SQLite/filesystem architecture is not an Edge-compatible persistence layer.

## Netlify environment variables

Set these in Netlify Project configuration with the Functions scope:

```env
AXY_CONFIG={"name":"Axy-Router","developer":"Axynera","version":"1.0.0","defaultModel":"Axynity-M1"}
AXY_KEYS=["Axy-your-client-key"]
AXY_PROVIDER_DEFAULT_BASE_URL=https://your-provider.example/v1
AXY_PROVIDER_DEFAULT_KEY_1=YOUR_PROVIDER_API_KEY
AXY_PROVIDER_DEFAULT_KEY_2=ANOTHER_PROVIDER_API_KEY
AXY_MODELS={"Axynity-M1":{"name":"Axynity-M1","displayName":"Axynity","provider":"default","model":"YOUR_BACKEND_MODEL","credentials":[0,1]}}
```

Add another provider without source-code changes:

```env
AXY_PROVIDER_PROVIDER_B_BASE_URL=https://another-provider.example/v1
AXY_PROVIDER_PROVIDER_B_KEY_1=YOUR_PROVIDER_API_KEY
```

Netlify Edge Functions read runtime variables through `Netlify.env`. Real secrets should never be committed to GitHub.

## Netlify settings

With the included `netlify.toml`:
- Base directory: leave empty
- Publish directory: `public`
- Edge Functions directory: `netlify/edge-functions`
- Build command: can be empty because Edge Functions are deployed by Netlify; `npm run build` is also safe with the existing package script.
