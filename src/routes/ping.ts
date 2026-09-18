import { Elysia } from "elysia";
import { db } from "../db";
import { upstreamKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  getApiKeyForUpstream,
  getBaseUrl,
  getComboConfig,
  parseUpstreamModels,
} from "../services/router";

type PingModel = {
  id: string;
  label: string;
  kind: "round_robin" | "combo";
  providers: number;
};

type PingCheck = {
  timestamp: number;
  ok: boolean;
};

const pingHistory: PingCheck[] = [];
const MAX_HISTORY = 30;
const PING_TIMEOUT_MS = 4000;

function recordPing(ok: boolean) {
  pingHistory.push({ timestamp: Date.now(), ok });
  if (pingHistory.length > MAX_HISTORY) {
    pingHistory.splice(0, pingHistory.length - MAX_HISTORY);
  }
}

function getActiveRows() {
  return db.select().from(upstreamKeys).where(eq(upstreamKeys.isActive, 1)).all();
}

function cleanModelId(id: string) {
  const value = String(id || "").trim();
  return value.includes("/") ? value.split("/").slice(1).join("/") : value;
}

function getPingModels(): PingModel[] {
  const rows = getActiveRows();
  const pools = new Map<string, Set<string>>();

  for (const upstream of rows) {
    if (Boolean((upstream as any).followUpstream)) continue;
    for (const model of parseUpstreamModels(upstream.models)) {
      if (!model.enabled || !model.id) continue;
      const id = String(model.id).trim();
      if (!id || id.toLowerCase().includes("embedding")) continue;
      const clean = cleanModelId(id);
      if (!pools.has(clean)) pools.set(clean, new Set());
      pools.get(clean)!.add(String(upstream.id));
    }
  }

  const result: PingModel[] = [];
  for (const [id, providers] of pools) {
    if (providers.size >= 2) {
      result.push({ id, label: id, kind: "round_robin", providers: providers.size });
    }
  }

  const combo = getComboConfig();
  if (combo.name && combo.models.length) {
    result.unshift({
      id: combo.name,
      label: combo.name,
      kind: "combo",
      providers: combo.models.length,
    });
  }

  return result;
}

function getRoundRobinTargets(modelId: string) {
  const target = cleanModelId(modelId).toLowerCase();
  return getActiveRows().filter((upstream) => {
    if (Boolean((upstream as any).followUpstream)) return false;
    return parseUpstreamModels(upstream.models).some((m) => {
      if (!m.enabled || !m.id) return false;
      return cleanModelId(String(m.id)).toLowerCase() === target;
    });
  });
}

async function checkUpstream(upstream: any): Promise<boolean> {
  const base = getBaseUrl(upstream).replace(/\/+$/, "");
  const url = upstream.provider === "anthropic"
    ? `${base}/v1/models`
    : `${base}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const key = getApiKeyForUpstream(upstream);
    if (upstream.provider === "anthropic") {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkModel(model: PingModel): Promise<boolean> {
  if (model.kind === "combo") {
    const combo = getComboConfig();
    const targets = combo.models.map((entry) =>
      getActiveRows().find((u) => String(u.id) === entry.upstreamId)
    ).filter(Boolean);
    if (!targets.length) return false;
    const results = await Promise.all(targets.map(checkUpstream));
    return results.some(Boolean);
  }

  const targets = getRoundRobinTargets(model.id);
  if (!targets.length) return false;
  const results = await Promise.all(targets.map(checkUpstream));
  return results.some(Boolean);
}

export async function runPingCheck() {
  const models = getPingModels();
  if (!models.length) {
    recordPing(false);
    return { status: "down", gateway: "Meow-Router", timestamp: Date.now(), models: [], history: pingHistory.slice() };
  }

  const checks = await Promise.all(models.map(async (model) => ({
    ...model,
    online: await checkModel(model),
  })));

  const ok = checks.every((model) => model.online);
  recordPing(ok);

  return {
    status: ok ? "ok" : "degraded",
    gateway: "Meow-Router",
    timestamp: Date.now(),
    uptime_seconds: Math.floor(process.uptime()),
    models: checks,
    history: pingHistory.slice(),
  };
}

export function getPingStatus() {
  return {
    status: "ok",
    gateway: "Meow-Router",
    timestamp: Date.now(),
    uptime_seconds: Math.floor(process.uptime()),
    models: getPingModels(),
    history: pingHistory.slice(),
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] || c));
}

function renderPingPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Meow-Router Ping</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{width:min(700px,100%);border:1px solid #27272a;background:#111113;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}
.head{display:flex;align-items:center;gap:12px}.logo{width:38px;height:38px;border-radius:11px;background:#18181b;display:grid;place-items:center;border:1px solid #3f3f46}.title{font-size:18px;font-weight:700}.sub{font-size:12px;color:#71717a;margin-top:3px}
.line{height:1px;background:#27272a;margin:18px 0}.status{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:700;margin-bottom:14px}.statusDot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e}.statusDot.bad{background:#ef4444;box-shadow:0 0 10px #ef4444}
.modelRow{padding:14px 2px;border-bottom:1px solid #1f1f22}.modelTop{display:flex;align-items:center;gap:10px}.modelName{flex:1;min-width:0}.modelName strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.modelName span{display:block;color:#71717a;font-size:11px;margin-top:3px}
.online{font-size:10px;font-weight:800;letter-spacing:.08em}.green{color:#4ade80}.red{color:#f87171}
.bars{display:flex;align-items:end;gap:3px;height:24px;margin-top:10px}.bar{width:5px;height:20px;border-radius:2px;background:#27272a}.bar.good{background:#22c55e;box-shadow:0 0 5px #22c55e}.bar.bad{background:#ef4444;box-shadow:0 0 5px #ef4444}
.footer{display:flex;justify-content:space-between;color:#52525b;font-size:10px;margin-top:16px}
</style></head><body><main class="card">
<div class="head"><div class="logo">🐱</div><div><div class="title">Meow-Router AI Ping</div><div class="sub">Real upstream connection monitor</div></div></div>
<div class="line"></div><div id="app">Checking AI connections...</div>
<div class="footer"><span id="last">Waiting for check...</span><span>Every 15s</span></div>
</main>
<script>
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function check(){
  const app=document.getElementById('app');
  try{
    const r=await fetch('/api/ping?check=1',{cache:'no-store'});
    const d=await r.json();
    const all=d.models.length>0 && d.models.every(m=>m.online);
    app.innerHTML='<div class="status"><span class="statusDot '+(all?'':'bad')+'"></span>'+ (all?'ALL AI ONLINE':'AI CONNECTION DEGRADED') +'</div>'+
      d.models.map(m=>'<div class="modelRow"><div class="modelTop"><div class="modelName"><strong>'+esc(m.label)+'</strong><span>'+(m.kind==='combo'?'Combo · '+m.providers+' upstreams':'Round Robin · '+m.providers+' providers')+'</span></div><span class="online '+(m.online?'green':'red')+'">'+(m.online?'ONLINE':'OFFLINE')+'</span></div><div class="bars">'+Array.from({length:30},(_,i)=>'<span class="bar '+(m.online?'good':'bad')+'"></span>').join('')+'</div></div>').join('');
    document.getElementById('last').textContent='Last check: '+new Date(d.timestamp).toLocaleTimeString();
  }catch(e){
    document.getElementById('last').textContent='Last check: FAILED';
    app.innerHTML='<div class="status"><span class="statusDot bad"></span>ROUTER OFFLINE</div>';
  }
}
check();setInterval(check,15000);
</script></body></html>`;
}

export const pingRoutes = new Elysia()
  .get("/api/ping", async ({ query }: any) => {
    if (query?.check === "1" || query?.check === "true") return await runPingCheck();
    return getPingStatus();
  }, { detail: { tags: ["Admin"], summary: "AI upstream connection health check" } })
  .get("/ping", ({ set }) => {
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    set.headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    return renderPingPage();
  });
