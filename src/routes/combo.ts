import { Elysia, t } from "elysia";
import { db } from "../db";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { getComboConfig } from "../services/router";

const keys = ["combo_name","developer_name","combo_mode","combo_models","combo_judge"] as const;
function save(key: string, value: string) {
  db.insert(settings).values({ key, value, updatedAt: Date.now() }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() }}).run();
}

export const comboRoutes = new Elysia({ prefix: "/api/admin/combo" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) { set.status = 401; return { error: "Unauthorized" }; }
  })
  .get("/", () => getComboConfig())
  .post("/", ({ body, set }) => {
    try {
      const name = body.name.trim();
      const developer = body.developer.trim();
      const mode = body.mode;
      if (!name || !developer) throw new Error("Name and developer are required");
      save("combo_name", name);
      save("developer_name", developer);
      save("combo_mode", mode);
      save("combo_models", JSON.stringify(body.models || []));
      save("combo_judge", body.judge ? JSON.stringify(body.judge) : "");
      return { success: true, ...getComboConfig() };
    } catch (e: any) { set.status = 400; return { success: false, error: e?.message || "Invalid combo settings" }; }
  }, { body: t.Object({
    name: t.String(), developer: t.String(), mode: t.Union([t.Literal("round_robin"), t.Literal("fallback"), t.Literal("judge")]),
    models: t.Array(t.Object({ provider: t.Union([t.Literal("openai"), t.Literal("anthropic")]), upstreamId: t.String(), model: t.String() })),
    judge: t.Optional(t.Object({ provider: t.Union([t.Literal("openai"), t.Literal("anthropic")]), upstreamId: t.String(), model: t.String() }))
  }) });
