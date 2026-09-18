import { Elysia } from "elysia";
import { validateClientKey } from "../services/auth";
import { handleComboPublicModel } from "../services/combo-judge";

export const comboProxyRoutes = new Elysia()
  .post("/v1/chat/completions", async ({ request, set }) => {
    const auth = request.headers.get("Authorization");
    const x = request.headers.get("x-api-key");
    const key = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : x?.trim();
    const clientKey = await validateClientKey(key || "axy-default");
    if (!clientKey) return null;
    let body:any;
    try { body = await request.json(); } catch { set.status=400; return { error:{message:"Malformed JSON payload",type:"invalid_request_error"} }; }
    const result = await handleComboPublicModel("openai", body, clientKey, request.signal);
    return result;
  })
  .post("/v1/messages", async ({ request, set }) => {
    const auth = request.headers.get("Authorization");
    const x = request.headers.get("x-api-key");
    const key = x?.trim() || (auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null);
    const clientKey = await validateClientKey(key || "axy-default");
    if (!clientKey) return null;
    let body:any;
    try { body = await request.json(); } catch { set.status=400; return { type:"error", error:{type:"invalid_request_error",message:"Malformed JSON payload"} }; }
    return handleComboPublicModel("anthropic", body, clientKey, request.signal);
  });
