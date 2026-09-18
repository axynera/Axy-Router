import { Elysia } from "elysia";
import { db } from "../db";
import { upstreamKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { getComboConfig, parseUpstreamModels } from "../services/router";

type PingModel = { id: string; label: string; kind: "round_robin" | "combo"; providers: number };
const pingHistory: Array<{ timestamp: number; ok: boolean }> = [];
const MAX_HISTORY = 30;

function recordPing(ok = true) {
  pingHistory.push({ timestamp: Date.now(), ok });
  if (pingHistory.length > MAX_HISTORY) pingHistory.splice(0, pingHistory.length - MAX_HISTORY);
}

function getPingModels(): PingModel[] {
  const rows = db.select().from(upstreamKeys).where(eq(upstreamKeys.isActive, 1)).all();
  const pools = new Map<string, Set<string>>();
  for (const upstream of rows) {
    if (Boolean((upstream as any).followUpstream)) continue;
    for (const model of parseUpstreamModels(upstream.models)) {
      if (!model.enabled || !model.id) continue;
      const id = String(model.id).trim();
      if (!id || id.toLowerCase().includes("embedding")) continue;
      const clean = id.includes("/") ? id.split("/").slice(1).join("/") : id;
      if (!pools.has(clean)) pools.set(clean, new Set());
      pools.get(clean)!.add(String(upstream.id));
    }
  }
  const result: PingModel[] = [];
  for (const [id, providers] of pools) {
    if (providers.size >= 2) result.push({ id, label: id, kind: "round_robin", providers: providers.size });
  }
  const combo = getComboConfig();
  if (combo.name && combo.models.length) {
    result.unshift({ id: combo.name, label: combo.name, kind: "combo", providers: combo.models.length });
  }
  return result;
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
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function renderPingPage() {
  recordPing(true);\n  const data = getPingStatus();
  const rows = data.models.length ? data.models.map((m) => `
    <div class="row"><span class="dot"></span><div class="model"><strong>${escapeHtml(m.label)}</strong><span>${m.kind === "combo" ? "Combo" : `Round Robin · ${m.providers} providers`}</span></div><span class="ok">ONLINE</span></div>
  `).join("") : `<div class="row"><span class="dot warn"></span><div class="model"><strong>No routing model configured</strong><span>Add an enabled model or Combo pool.</span></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Meow-Router Ping</title>
<style>*{box-sizing:border-box}body{margin:0;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}.card{width:min(620px,100%);border:1px solid #27272a;background:#111113;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}.head{display:flex;align-items:center;gap:12px}.logo{width:38px;height:38px;border-radius:11px;background:#18181b;display:grid;place-items:center;border:1px solid #3f3f46}.title{font-size:18px;font-weight:700}.sub{font-size:12px;color:#71717a;margin-top:3px}.line{height:1px;background:#27272a;margin:18px 0}.timeline{display:flex;align-items:center;gap:0;height:28px;margin:2px 2px 10px}.timeline i{height:2px;flex:1;background:#166534}.point{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;flex:none;z-index:1}.point.bad{background:#ef4444;box-shadow:0 0 8px #ef4444}.point:not(.good){background:#27272a;box-shadow:none}.row{display:flex;align-items:center;gap:12px;padding:13px 4px;border-bottom:1px solid #1f1f22}.row:last-child{border-bottom:0}.dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e}.dot.warn{background:#eab308;box-shadow:0 0 10px #eab308}.model{min-width:0;flex:1}.model strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model span{display:block;color:#71717a;font-size:11px;margin-top:3px}.ok{font-size:10px;color:#4ade80;font-weight:800;letter-spacing:.08em}.footer{display:flex;justify-content:space-between;color:#52525b;font-size:10px;margin-top:16px}</style>
</head><body><main class="card"><div class="head"><div class="logo">🐱</div><div><div class="title">Meow-Router Ping</div><div class="sub">Lightweight cron / uptime monitor endpoint</div></div></div><div class="line"></div><div id="models">${rows}</div><div class="footer"><span>Gateway: ONLINE</span><span>Auto refresh: 15s</span></div></main><script>setInterval(async()=>{try{const r=await fetch('/api/ping',{cache:'no-store'});const d=await r.json();document.querySelector('.footer span').textContent='Gateway: '+(d.status==='ok'?'ONLINE':'OFFLINE')}catch{document.querySelector('.footer span').textContent='Gateway: OFFLINE'}},15000)</script></body></html>`;
}

export const pingRoutes = new Elysia()
  .get("/api/ping", () => { recordPing(true); return getPingStatus(); }, { detail: { tags: ["Admin"], summary: "Public lightweight ping status" } })
  .get("/ping", ({ set }) => {
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    set.headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    return renderPingPage();
  });
