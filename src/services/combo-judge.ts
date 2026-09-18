import { getComboConfig, getApiKeyForUpstream, getBaseUrl, getActiveUpstreamKeys, parseAllowedProviders } from "./router";
import { type ClientKey, type UpstreamKey } from "../db/schema";

type Candidate = {
  provider: "openai" | "anthropic";
  upstream: UpstreamKey;
  model: string;
  answer: string;
};

function allowed(clientKey: ClientKey | null, upstream: UpstreamKey) {
  if (!clientKey) return true;
  const ids = parseAllowedProviders(clientKey.allowedProviders);
  return ids.includes(upstream.id) || ids.includes(upstream.provider);
}

function cleanModel(model: string) {
  const s = String(model || "").trim();
  return s.includes("/") ? s.split("/").slice(1).join("/") : s;
}

function extractOpenAI(data: any): string {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => typeof x === "string" ? x : x?.text || "").join("");
  return "";
}

function extractAnthropic(data: any): string {
  if (Array.isArray(data?.content)) {
    return data.content.map((x: any) => x?.type === "text" ? x.text : "").join("");
  }
  return typeof data?.content === "string" ? data.content : "";
}

function toAnthropicBody(body: any, model: string) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages) {
    if (m?.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      else if (Array.isArray(m.content)) systemParts.push(m.content.map((x: any) => x?.text || "").join(""));
      continue;
    }
    out.push({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")
    });
  }
  return {
    model,
    max_tokens: Number(body?.max_tokens || body?.max_output_tokens || 4096),
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages: out.length ? out : [{ role: "user", content: "Please answer the request." }],
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    stream: false
  };
}

async function callCandidate(item: { provider: "openai" | "anthropic"; upstream: UpstreamKey; model: string }, body: any, signal: AbortSignal): Promise<string> {
  const key = getApiKeyForUpstream(item.upstream);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const isAnthropic = item.provider === "anthropic";
    const payload = isAnthropic
      ? toAnthropicBody(body, item.model)
      : { ...body, model: item.model, stream: false };
    const headers: Record<string,string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (isAnthropic) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${key}`;
    }
    const res = await fetch(
      isAnthropic ? `${getBaseUrl(item.upstream)}/v1/messages` : `${getBaseUrl(item.upstream)}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal }
    );
    if (!res.ok) throw new Error(`${item.provider} ${res.status}`);
    const data = await res.json();
    const answer = isAnthropic ? extractAnthropic(data) : extractOpenAI(data);
    if (!answer.trim()) throw new Error("empty response");
    return answer.slice(0, 12000);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function judgeAnswers(config: any, answers: Candidate[], originalBody: any, signal: AbortSignal): Promise<string> {
  if (!config.judge) return answers[0]?.answer || "";
  const judgeUpstream = [...getActiveUpstreamKeys("openai"), ...getActiveUpstreamKeys("anthropic")]
    .find((u) => u.id === config.judge.upstreamId && allowed(null, u));
  if (!judgeUpstream) return answers[0]?.answer || "";

  const prompt = [
    "You are the final answer judge for a multi-model AI gateway.",
    "Produce ONE best final answer to the user's request using the candidate answers below.",
    "Do not mention the gateway, candidates, providers, or judging process. Do not say which model answered.",
    "",
    "USER REQUEST:",
    JSON.stringify(originalBody?.messages || []),
    "",
    ...answers.map((a, i) => `CANDIDATE ${i + 1} [${a.provider}/${a.model}]:\n${a.answer}`),
  ].join("\n");

  const synthetic = {
    model: cleanModel(config.judge.model),
    messages: [{ role: "system", content: "Return only the final answer, with no meta-commentary." }, { role: "user", content: prompt }],
    max_tokens: Math.min(Number(originalBody?.max_tokens || 8192), 8192),
    temperature: 0.2,
    stream: false
  };
  return callCandidate(
    { provider: config.judge.provider, upstream: judgeUpstream, model: cleanModel(config.judge.model) },
    synthetic,
    signal
  );
}

export async function handleComboJudge(
  protocol: "openai" | "anthropic",
  body: any,
  clientKey: ClientKey | null,
  signal: AbortSignal
): Promise<Response | null> {
  const config = getComboConfig();
  if (!config.name || config.mode !== "judge" || !Array.isArray(config.models) || config.models.length === 0) return null;

  const all = [...getActiveUpstreamKeys("openai"), ...getActiveUpstreamKeys("anthropic")];
  const candidates = config.models.map((m: any) => {
    const upstream = all.find((u) => u.id === m.upstreamId && u.provider === m.provider && allowed(clientKey, u));
    return upstream ? { provider: m.provider, upstream, model: cleanModel(m.model) } : null;
  }).filter(Boolean) as Array<{provider:"openai"|"anthropic";upstream:UpstreamKey;model:string}>;

  if (!candidates.length) {
    return new Response(JSON.stringify({ error: { message: "Combo Judge has no permitted active AI models.", type: "router_error", code: "combo_no_models" } }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  const started = Date.now();
  const results = await Promise.allSettled(candidates.map(c => callCandidate(c, body, signal)));
  const answers: Candidate[] = results.flatMap((r, i) =>
    r.status === "fulfilled" && r.value ? [{ ...candidates[i], answer: r.value }] : []
  );
  if (!answers.length) {
    return new Response(JSON.stringify({ error: { message: "All Combo Judge upstreams failed.", type: "upstream_error", code: "combo_all_failed" } }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  let finalAnswer = answers[0]!.answer;
  if (answers.length > 1 && config.judge) {
    try { finalAnswer = await judgeAnswers(config, answers, body, signal); } catch {}
  }

  const publicModel = config.name;
  if (protocol === "anthropic") {
    const response = {
      id: "msg_meow_combo_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20),
      type: "message",
      role: "assistant",
      model: publicModel,
      content: [{ type: "text", text: finalAnswer }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    };
    if (body?.stream) {
      const chunks = [
        `event: message_start\\ndata: ${JSON.stringify({ type:"message_start", message:{ ...response, usage:{input_tokens:0,output_tokens:0} } })}\\n\\n`,
        `event: content_block_start\\ndata: ${JSON.stringify({type:"content_block_start",index:0,content_block:{type:"text",text:""}})}\\n\\n`,
        `event: content_block_delta\\ndata: ${JSON.stringify({type:"content_block_delta",index:0,delta:{type:"text_delta",text:finalAnswer}})}\\n\\n`,
        `event: content_block_stop\\ndata: ${JSON.stringify({type:"content_block_stop",index:0})}\\n\\n`,
        `event: message_delta\\ndata: ${JSON.stringify({type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:0}})}\\n\\n`,
        `event: message_stop\\ndata: ${JSON.stringify({type:"message_stop"})}\\n\\n`
      ];
      return new Response(chunks.join(""), { status:200, headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"} });
    }
    return new Response(JSON.stringify(response), { status:200, headers:{"Content-Type":"application/json"} });
  }

  const response = {
    id: "chatcmpl-meow-combo-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20),
    object: "chat.completion",
    created: Math.floor(Date.now()/1000),
    model: publicModel,
    choices: [{ index:0, message:{ role:"assistant", content:finalAnswer }, finish_reason:"stop" }],
    usage: { prompt_tokens:0, completion_tokens:0, total_tokens:0 },
    system_fingerprint: "meow-combo"
  };
  if (body?.stream) {
    const chunks = `data: ${JSON.stringify({id:response.id,object:"chat.completion.chunk",created:response.created,model:publicModel,choices:[{index:0,delta:{role:"assistant",content:finalAnswer},finish_reason:null}]})}\\n\\ndata: ${JSON.stringify({id:response.id,object:"chat.completion.chunk",created:response.created,model:publicModel,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:response.usage})}\\n\\ndata: [DONE]\\n\\n`;
    return new Response(chunks, { status:200, headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"} });
  }
  return new Response(JSON.stringify(response), { status:200, headers:{"Content-Type":"application/json"} });
}

export async function handleComboPublicModel(protocol: "openai"|"anthropic", body:any, clientKey:ClientKey|null, signal:AbortSignal) {
  const config=getComboConfig();
  return config.name && String(body?.model||"").trim().toLowerCase() === config.name.trim().toLowerCase()
    ? handleComboJudge(protocol, body, clientKey, signal)
    : null;
}
