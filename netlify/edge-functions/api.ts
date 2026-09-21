type Credential = { apiKey: string; baseUrl?: string; enabled?: boolean };
type Provider = { baseUrl: string; credentials: Credential[] };
type ModelConfig = {
  name: string;
  displayName?: string;
  provider: string;
  model: string;
  credentials?: number[];
};

const json = <T>(key: string, fallback: T): T => {
  try {
    const value = Netlify.env.get(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

const providers = (): Record<string, Provider> => {
  const configured = json<Record<string, Provider>>("AXY_PROVIDERS", {});
  const env = Netlify.env.toObject();
  const names = new Set(Object.keys(configured));

  for (const key of Object.keys(env)) {
    const match = key.match(/^AXY_PROVIDER_([A-Z0-9_]+)_(BASE_URL|KEY_\\d+)$/);
    if (match) names.add(match[1].toLowerCase());
  }

  for (const name of names) {
    const id = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const baseUrl = Netlify.env.get(`AXY_PROVIDER_${id}_BASE_URL`) || "";
    const keys = Object.keys(env)
      .filter((key) => key.startsWith(`AXY_PROVIDER_${id}_KEY_`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((key) => env[key])
      .filter(Boolean) as string[];

    if (!configured[name]) configured[name] = { baseUrl, credentials: [] };
    if (baseUrl) configured[name].baseUrl = baseUrl;
    if (keys.length) configured[name].credentials = keys.map((apiKey) => ({ apiKey, enabled: true }));
  }

  return configured;
};

const models = () => json<Record<string, ModelConfig>>("AXY_MODELS", {});
const keys = () => json<string[]>("AXY_KEYS", []);
const rr = new Map<string, number>();

function authorized(request: Request) {
  const configured = keys();
  if (!configured.length) return true;
  const auth = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "").trim();
  const key = request.headers.get("x-api-key")?.trim() || auth || "";
  return configured.includes(key);
}

function selectCredential(cfg: ModelConfig, provider: Provider) {
  const selected = cfg.credentials?.map((index) => provider.credentials[index]).filter(Boolean) || provider.credentials;
  const available = selected.filter((credential) => credential.enabled !== false && credential.apiKey);
  if (!available.length) throw new Error(`No enabled credentials for provider: ${cfg.provider}`);

  const stateKey = `${cfg.provider}:${cfg.name}`;
  const index = (rr.get(stateKey) || 0) % available.length;
  rr.set(stateKey, index + 1);
  return available[index];
}

function resolve(model: string) {
  const cfg = models()[model];
  if (!cfg) throw new Error(`Unknown model: ${model}`);
  const provider = providers()[cfg.provider];
  if (!provider) throw new Error(`Provider not configured: ${cfg.provider}`);
  const credential = selectCredential(cfg, provider);
  const base = (credential.baseUrl || provider.baseUrl || "").replace(/\\/$/, "");
  if (!base) throw new Error(`Provider base URL not configured: ${cfg.provider}`);
  return { cfg, credential, url: `${base}/chat/completions` };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function response(body: BodyInit | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...corsHeaders(), ...headers } });
}

async function openaiChat(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const model = String(body.model || "");
  const { cfg, credential, url } = resolve(model);

  const upstreamBody = { ...body, model: cfg.model };
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  const headers = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function anthropicMessages(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system ? [{ role: "system", content: body.system }] : [];
  const openaiBody = {
    model: body.model,
    messages: [...system, ...messages],
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
  };

  const { cfg, credential, url } = resolve(String(body.model || ""));
  openaiBody.model = cfg.model;

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  if (body.stream) {
    const headers = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return response(JSON.stringify(data), upstream.status, { "Content-Type": "application/json" });

  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? "";
  const usage = data?.usage || {};
  return response(JSON.stringify({
    id: data?.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: content }],
    stop_reason: choice?.finish_reason || "end_turn",
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  }), upstream.status, { "Content-Type": "application/json" });
}

export default async (request: Request) => {
  try {
    if (request.method === "OPTIONS") return response(null, 204);
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return response(JSON.stringify({
        status: "ok",
        service: Netlify.env.get("AXY_CONFIG") ? json("AXY_CONFIG", { name: "Axy-Router" }).name : "Axy-Router",
        runtime: "Netlify Edge",
      }), 200, { "Content-Type": "application/json" });
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      const data = Object.values(models()).map((model, index) => ({
        id: model.name,
        object: "model",
        created: 0,
        owned_by: "Axynera",
        display_name: model.displayName || model.name,
        index,
      }));
      return response(JSON.stringify({ object: "list", data }), 200, { "Content-Type": "application/json" });
    }

    if (!authorized(request)) {
      return response(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }), 401, {
        "Content-Type": "application/json",
      });
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return await openaiChat(request);
    }

    if (url.pathname === "/v1/messages" && request.method === "POST") {
      return await anthropicMessages(request);
    }

    return response(JSON.stringify({ error: { message: "Not found", type: "not_found" } }), 404, {
      "Content-Type": "application/json",
    });
  } catch (error) {
    return response(JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : "Internal router error",
        type: "router_error",
      },
    }), 500, { "Content-Type": "application/json" });
  }
};

export const config = {
  path: ["/health", "/v1/*"],
};
