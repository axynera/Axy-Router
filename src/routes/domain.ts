import { Elysia, t } from "elysia";
import { sqlite } from "../db";
import { authMiddleware } from "../middleware/auth";

const SETTING_KEY = "custom_domain";

function getCustomDomain(): string {
  const row = sqlite
    .query("SELECT value FROM settings WHERE key = ?")
    .get(SETTING_KEY) as { value: string } | null;
  return row?.value || "";
}

function normalizeDomain(input: string): string {
  let value = input.trim();
  if (!value) return "";

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Custom domain must use http:// or https://");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("Invalid custom domain");
  }

  // Store only the origin so paths/query strings cannot accidentally become part of the API base URL.
  return url.origin;
}

export const domainRoutes = new Elysia({ prefix: "/api/admin/domain" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) {
      set.status = 401;
      return { error: "Unauthorized access to domain settings" };
    }
  })
  .get("/", ({ request }) => {
    const customDomain = getCustomDomain();
    const deploymentOrigin = new URL(request.url).origin;
    const origin = customDomain || deploymentOrigin;

    return {
      customDomain,
      deploymentOrigin,
      activeOrigin: origin,
      apiBaseUrl: `${origin}/v1`,
      isConfigured: Boolean(customDomain),
    };
  })
  .post(
    "/",
    ({ body, set }) => {
      try {
        const customDomain = normalizeDomain(body.domain || "");
        const now = Date.now();

        sqlite.run(
          `INSERT INTO settings (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [SETTING_KEY, customDomain, now]
        );

        return {
          success: true,
          customDomain,
          isConfigured: Boolean(customDomain),
          apiBaseUrl: customDomain ? `${customDomain}/v1` : null,
        };
      } catch (error: any) {
        set.status = 400;
        return {
          success: false,
          error: error?.message || "Invalid custom domain",
        };
      }
    },
    {
      body: t.Object({
        domain: t.String(),
      }),
    }
  );
