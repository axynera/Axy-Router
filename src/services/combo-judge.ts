import { getComboConfig, getApiKeyForUpstream, getBaseUrl, getActiveUpstreamKeys, parseAllowedProviders } from "./router";
import { type ClientKey, type UpstreamKey } from "../db/schema";

type Candidate = {
  provider: "openai" | "anthropic";
  upstream: UpstreamKey;
  model: string;
  answer: string;
  turns: number;
};

type CandidateResult = {
  answer: string;
  truncated: boolean;
  finishReason?: string;
};

const MAX_CONTINUES = 8;
const MAX_TOTAL_OUTPUT = 100000;
const CANDIDATE_TIMEOUT_MS = 45000;
const MAX_CONTINUE_CONTEXT = 16000;
const MAX_JUDGE_CONTEXT_PER_CANDIDATE = 18000;
const MAX_JUDGE_OUTPUT = 16384;

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

function isTruncated(provider: "openai" | "anthropic", data: any, answer: string) {
  const reason = provider === "anthropic"
    ? String(data?.stop_reason || "").toLowerCase()
    : String(data?.choices?.[0]?.finish_reason || "").toLowerCase();
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens" ||
    false;
}

function toAnthropicContent(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((x: any) => {
    if (typeof x === "string") return { type: "text", text: x };
    if (x?.type === "text") return x;
    if (x?.type === "image_url" && x?.image_url?.url) {
      const url = String(x.image_url.url);
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
      }
      return { type: "image", source: { type: "url", url } };
    }
    return x;
  });
}

function toAnthropicBody(body: any, model: string, continuation?: { answer: string; instruction: string }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages) {
    if (m?.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      else if (Array.isArray(m.content)) systemParts.push(m.content.map((x: any) => x?.text || "").join(""));
      continue;
    }
    out.push({ role: m?.role === "assistant" ? "assistant" : "user", content: toAnthropicContent(m?.content) });
  }
  if (continuation) {
    out.push({ role: "assistant", content: continuationContext(continuation.answer) });
    out.push({ role: "user", content: continuation.instruction });
  }
  const payload: any = {
    model,
    max_tokens: Number(body?.max_tokens || body?.max_output_tokens || 8192),
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages: out.length ? out : [{ role: "user", content: "Please answer the request." }],
    stream: false
  };
  if (typeof body?.temperature === "number") payload.temperature = body.temperature;
  if (typeof body?.top_p === "number") payload.top_p = body.top_p;
  if (body?.stop_sequences) payload.stop_sequences = body.stop_sequences;
  if (body?.metadata) payload.metadata = body.metadata;
  return payload;
}

function continuationContext(answer: string) {
  if (answer.length <= MAX_CONTINUE_CONTEXT) return answer;
  const half = Math.floor(MAX_CONTINUE_CONTEXT / 2);
  return answer.slice(0, half) + "\n\n[...middle omitted for context...]\n\n" + answer.slice(-half);
}

function toOpenAIBody(body: any, model: string, continuation?: { answer: string; instruction: string }) {
  const messages = Array.isArray(body?.messages) ? [...body.messages] : [];
  if (continuation) {
    messages.push({ role: "assistant", content: continuationContext(continuation.answer) });
    messages.push({ role: "user", content: continuation.instruction });
  }
  return { ...body, model, messages, stream: false };
}

async function callCandidateOnce(
  item: { provider: "openai" | "anthropic"; upstream: UpstreamKey; model: string },
  body: any,
  signal: AbortSignal,
  continuation?: { answer: string; instruction: string }
): Promise<CandidateResult> {
  const key = getApiKeyForUpstream(item.upstream);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANDIDATE_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const isAnthropic = item.provider === "anthropic";
    const payload = isAnthropic
      ? toAnthropicBody(body, item.model, continuation)
      : toOpenAIBody(body, item.model, continuation);
    const headers: Record<string, string> = {
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
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 600);
      const err: any = new Error(`${item.provider} ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const answer = isAnthropic ? extractAnthropic(data) : extractOpenAI(data);
    if (!answer.trim()) throw new Error("empty response");
    return {
      answer,
      truncated: isTruncated(item.provider, data, answer),
      finishReason: isAnthropic ? data?.stop_reason : data?.choices?.[0]?.finish_reason
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

class ComboContinuationError extends Error {
  partial: string;
  turns: number;
  constructor(message: string, partial: string, turns: number) {
    super(message);
    this.name = "ComboContinuationError";
    this.partial = partial;
    this.turns = turns;
  }
}

async function continueCandidate(
  item: { provider: "openai" | "anthropic"; upstream: UpstreamKey; model: string },
  body: any,
  signal: AbortSignal,
  initialAnswer: string,
  initialTurns = 0
): Promise<{ answer: string; turns: number }> {
  let answer = initialAnswer;
  let turns = initialTurns;
  let result: CandidateResult = {
    answer,
    truncated: true,
    finishReason: "continuation"
  };
  const instruction = "Continue exactly from where you stopped. Do not repeat previous text. Continue the requested answer/code until it is complete. If you are finished, stop.";
  while (result.truncated && turns < MAX_CONTINUES && answer.length < MAX_TOTAL_OUTPUT) {
    turns++;
    try {
      result = await callCandidateOnce(item, body, signal, { answer, instruction });
    } catch (error) {
      throw new ComboContinuationError(String((error as Error)?.message || error), answer, turns - 1);
    }
    if (result.answer) answer += result.answer;
  }
  if (result.truncated && turns >= MAX_CONTINUES) throw new ComboContinuationError("maximum continuation limit reached", answer, turns);
  if (result.truncated && answer.length >= MAX_TOTAL_OUTPUT) {
    throw new ComboContinuationError("maximum output limit reached", answer, turns);
  }
  return { answer: answer.slice(0, MAX_TOTAL_OUTPUT), turns };
}

async function callCandidate(
  item: { provider: "openai" | "anthropic"; upstream: UpstreamKey; model: string },
  body: any,
  signal: AbortSignal,
  initialAnswer = "",
  initialTurns = 0
): Promise<{ answer: string; turns: number }> {
  if (initialAnswer) return continueCandidate(item, body, signal, initialAnswer, initialTurns);
  const result = await callCandidateOnce(item, body, signal);
  return continueCandidate(item, body, signal, result.answer, 0);
}

async function judgeAnswers(config: any, answers: Candidate[], originalBody: any, clientKey: ClientKey | null, signal: AbortSignal): Promise<string> {
  if (!config.judge) return answers[0]?.answer || "";
  const judgeUpstream = [...getActiveUpstreamKeys("openai"), ...getActiveUpstreamKeys("anthropic")]
    .find((u) => u.id === config.judge.upstreamId && u.provider === config.judge.provider && allowed(clientKey, u));
  if (!judgeUpstream) return answers[0]?.answer || "";

  const prompt = [
    "You are the final answer judge for a multi-model AI gateway.",
    "Produce ONE best final answer to the user's request using the candidate answers below.",
    "Do not mention the gateway, candidates, providers, or judging process.",
    "",
    "USER REQUEST:",
    JSON.stringify(originalBody?.messages || []),
    "",
    ...answers.map((a, i) => { const candidateText = a.answer.length > MAX_JUDGE_CONTEXT_PER_CANDIDATE ? a.answer.slice(0, MAX_JUDGE_CONTEXT_PER_CANDIDATE / 2) + "\n\n[...middle omitted...]\n\n" + a.answer.slice(-MAX_JUDGE_CONTEXT_PER_CANDIDATE / 2) : a.answer; return `CANDIDATE ${i + 1} [${a.provider}/${a.model}]:\n${candidateText}`; }),
  ].join("\n");

  const synthetic = {
    model: cleanModel(config.judge.model),
    messages: [{ role: "system", content: "Return only the final answer, with no meta-commentary." }, { role: "user", content: prompt }],
    max_tokens: Math.min(Number(originalBody?.max_tokens || originalBody?.max_output_tokens || 8192), MAX_JUDGE_OUTPUT),
    temperature: 0.2,
    stream: false
  };
  const result = await callCandidate(
    { provider: config.judge.provider, upstream: judgeUpstream, model: cleanModel(config.judge.model) },
    synthetic,
    signal
  );
  return result.answer;
}

export async function handleCombo(
  protocol: "openai" | "anthropic",
  body: any,
  clientKey: ClientKey | null,
  signal: AbortSignal
): Promise<Response | null> {
  const config = getComboConfig();
  if (!config.name || !Array.isArray(config.models) || config.models.length === 0) return null;

  const all = [...getActiveUpstreamKeys("openai"), ...getActiveUpstreamKeys("anthropic")];
  const candidates = config.models.map((m: any) => {
    const upstream = all.find((u) => u.id === m.upstreamId && u.provider === m.provider && allowed(clientKey, u));
    return upstream ? { provider: m.provider, upstream, model: cleanModel(m.model) } : null;
  }).filter(Boolean) as Array<{provider:"openai"|"anthropic";upstream:UpstreamKey;model:string}>;

  if (!candidates.length) {
    return new Response(JSON.stringify({ error: { message: "Combo has no permitted active AI models.", type: "router_error", code: "combo_no_models" } }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  let answers: Candidate[] = [];
  const orderedCandidates = config.mode === "round_robin"
    ? (() => {
        const indexKey = "combo:" + (clientKey?.id || "global") + ":rr";
        const g = globalThis as any;
        g.__meowComboRR = g.__meowComboRR || {};
        const index = Number(g.__meowComboRR[indexKey] || 0) % candidates.length;
        g.__meowComboRR[indexKey] = (index + 1) % candidates.length;
        return candidates.map((_, i) => candidates[(index + i) % candidates.length]!);
      })()
    : candidates;

  if (config.mode === "judge") {
    const results = await Promise.allSettled(candidates.map(c => callCandidate(c, body, signal)));
    answers = results.flatMap((r, i) =>
      r.status === "fulfilled" && r.value?.answer
        ? [{ ...candidates[i], answer: r.value.answer, turns: r.value.turns }]
        : []
    );
  } else {
    let partial = "";
    let turns = 0;
    for (const candidate of orderedCandidates) {
      try {
        const result = await callCandidate(candidate, body, signal, partial, turns);
        answers = [{ ...candidate, answer: result.answer, turns: result.turns }];
        break;
      } catch (error) {
        if (error instanceof ComboContinuationError && error.partial) {
          partial = error.partial;
          turns = error.turns;
          continue;
        }
      }
    }
  }

  if (!answers.length) {
    return new Response(JSON.stringify({ error: { message: "All Combo upstreams failed, timed out, or hit their output limits.", type: "upstream_error", code: "combo_all_failed" } }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  let finalAnswer = answers[0]!.answer;
  if (config.mode === "judge" && config.judge) {
    try {
      finalAnswer = await judgeAnswers(config, answers, body, clientKey, signal);
    } catch {}
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
    ? handleCombo(protocol, body, clientKey, signal)
    : null;
}
