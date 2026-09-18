import { getComboConfig, getApiKeyForUpstream, getBaseUrl, getActiveUpstreamKeys, parseAllowedProviders } from "./router";
import { type ClientKey, type UpstreamKey } from "../db/schema";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Candidate = {
  provider: "openai" | "anthropic";
  upstream: UpstreamKey;
  model: string;
  answer: string;
  turns: number;
  toolCalls?: ToolCall[];
  rawContent?: any[];
  usage?: { input_tokens: number; output_tokens: number };
};

type CandidateResult = {
  answer: string;
  truncated: boolean;
  finishReason?: string;
  toolCalls?: ToolCall[];
  rawContent?: any[];
  usage?: { input_tokens: number; output_tokens: number };
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

function extractOpenAI(data: any): Pick<CandidateResult, "answer" | "toolCalls" | "rawContent" | "usage"> {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  const answer = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((x: any) => typeof x === "string" ? x : x?.text || "").join("")
      : "";
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((x: any) => ({
        id: String(x?.id || crypto.randomUUID()),
        type: "function" as const,
        function: {
          name: String(x?.function?.name || ""),
          arguments: typeof x?.function?.arguments === "string" ? x.function.arguments : JSON.stringify(x?.function?.arguments ?? {})
        }
      })).filter((x: ToolCall) => x.function.name)
    : undefined;
  const usage = data?.usage
    ? { input_tokens: Number(data.usage.prompt_tokens || 0), output_tokens: Number(data.usage.completion_tokens || 0) }
    : undefined;
  return { answer, toolCalls, usage };
}

function extractAnthropic(data: any): Pick<CandidateResult, "answer" | "toolCalls" | "rawContent" | "usage"> {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const answer = blocks.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("");
  const toolCalls = blocks.filter((x: any) => x?.type === "tool_use").map((x: any) => ({
    id: String(x.id || crypto.randomUUID()),
    type: "function" as const,
    function: { name: String(x.name || ""), arguments: JSON.stringify(x.input ?? {}) }
  }));
  const usage = data?.usage
    ? { input_tokens: Number(data.usage.input_tokens || 0), output_tokens: Number(data.usage.output_tokens || 0) }
    : undefined;
  return { answer, toolCalls: toolCalls.length ? toolCalls : undefined, rawContent: blocks, usage };
}

function isTruncated(provider: "openai" | "anthropic", data: any, answer: string) {
  const reason = provider === "anthropic"
    ? String(data?.stop_reason || "").toLowerCase()
    : String(data?.choices?.[0]?.finish_reason || "").toLowerCase();
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens";
}

function toAnthropicContent(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((x: any) => {
    if (typeof x === "string") return { type: "text", text: x };
    if (x?.type === "text" || x?.type === "thinking" || x?.type === "redacted_thinking" || x?.type === "tool_use" || x?.type === "tool_result") return x;
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

function openAIToolsToAnthropic(tools: any) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t: any) => t?.type === "function" && t?.function
    ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: "object", properties: {} } }
    : t).filter(Boolean);
}

function anthropicToolsToOpenAI(tools: any) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t: any) => t?.name
    ? { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } } }
    : t).filter(Boolean);
}



function isPlainJsonObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonObjects(base: any, extra: any): any {
  if (!isPlainJsonObject(base) || !isPlainJsonObject(extra)) return base;
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainJsonObject(out[key]) && isPlainJsonObject(value)) {
      out[key] = mergeJsonObjects(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Universal Meow-Router custom JSON.
 *
 * Clients may send either:
 *   "custom_json": { ... }
 * or:
 *   "extra_body": { ... }
 *
 * The object is deep-merged into the provider payload after protocol
 * translation, so provider-specific parameters survive OpenAI <-> Anthropic
 * conversion. Control fields are never forwarded as custom JSON themselves.
 */
function applyCustomJson(payload: any, body: any): any {
  const custom = isPlainJsonObject(body?.custom_json)
    ? body.custom_json
    : isPlainJsonObject(body?.extra_body)
      ? body.extra_body
      : null;

  if (!custom) return payload;
  const cleanCustom = { ...custom };
  delete cleanCustom.custom_json;
  delete cleanCustom.extra_body;
  return mergeJsonObjects(payload, cleanCustom);
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
    if (m?.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }] });
    } else if (m?.role === "assistant" && Array.isArray(m?.tool_calls)) {
      const blocks: any[] = [];
      if (m.content) blocks.push(...(Array.isArray(m.content) ? toAnthropicContent(m.content) : [{ type: "text", text: String(m.content) }]));
      for (const tc of m.tool_calls) {
        let input: any = {};
        try { input = JSON.parse(tc?.function?.arguments || "{}"); } catch { input = { raw: tc?.function?.arguments || "" }; }
        blocks.push({ type: "tool_use", id: String(tc?.id || crypto.randomUUID()), name: String(tc?.function?.name || ""), input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m?.role === "assistant" ? "assistant" : "user", content: toAnthropicContent(m?.content) });
    }
  }
  if (continuation) {
    out.push({
      role: "user",
      content: `Previous partial answer (continue from this; do not repeat it):\n\n${continuationContext(continuation.answer)}\n\n${continuation.instruction}`
    });
  }
  const payload: any = {
    model,
    max_tokens: Number(body?.max_tokens || body?.max_output_tokens || 8192),
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages: out.length ? out : [{ role: "user", content: "Please answer the request." }],
    stream: false
  };
  if (body?.tools) payload.tools = openAIToolsToAnthropic(body.tools);
  if (body?.tool_choice) {
    payload.tool_choice = body.tool_choice === "required"
      ? { type: "any" }
      : body.tool_choice === "none"
        ? { type: "none" }
        : body.tool_choice?.function?.name
          ? { type: "tool", name: body.tool_choice.function.name }
          : { type: "auto" };
  }
  // Avoid forwarding OpenAI sampling parameters that newer Claude models may reject.
  if (body?.stop_sequences) payload.stop_sequences = body.stop_sequences;
  if (body?.metadata) payload.metadata = body.metadata;
  return applyCustomJson(payload, body);
}

function continuationContext(answer: string) {
  if (answer.length <= MAX_CONTINUE_CONTEXT) return answer;
  const half = Math.floor(MAX_CONTINUE_CONTEXT / 2);
  return answer.slice(0, half) + "\n\n[...middle omitted for context...]\n\n" + answer.slice(-half);
}

function anthropicMessagesToOpenAI(messages: any[]) {
  return messages.flatMap((m: any) => {
    const content = m?.content;
    if (!Array.isArray(content)) return [{ ...m }];
    if (m.role === "assistant") {
      const text = content.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("");
      const toolCalls = content.filter((x: any) => x?.type === "tool_use").map((x: any) => ({
        id: String(x.id || crypto.randomUUID()),
        type: "function",
        function: { name: String(x.name || ""), arguments: JSON.stringify(x.input ?? {}) }
      }));
      return [{ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
    }
    const toolResults = content.filter((x: any) => x?.type === "tool_result");
    if (toolResults.length) {
      const textBlocks = content.filter((x: any) => x?.type === "text");
      const resultMessages = toolResults.map((x: any) => ({
        role: "tool",
        tool_call_id: String(x.tool_use_id || ""),
        content: typeof x.content === "string" ? x.content : JSON.stringify(x.content ?? "")
      }));
      if (textBlocks.length) resultMessages.unshift({ role: "user", content: textBlocks.map((x: any) => x.text || "").join("") } as any);
      return resultMessages;
    }
    return [{ role: m?.role === "user" ? "user" : "assistant", content: content.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("") }];
  });
}

function toOpenAIBody(body: any, model: string, continuation?: { answer: string; instruction: string }) {
  const messages = Array.isArray(body?.messages) ? [...body.messages] : [];
  if (continuation) {
    messages.push({ role: "assistant", content: continuationContext(continuation.answer) });
    messages.push({ role: "user", content: continuation.instruction });
  }
  const normalizedMessages = body?.messages?.some((m: any) => Array.isArray(m?.content) && m?.content.some((x: any) => x?.type === "tool_use" || x?.type === "tool_result"))
    ? anthropicMessagesToOpenAI(messages)
    : messages;
  const payload: any = { ...body, model, messages: normalizedMessages, stream: false };
  if (body?.max_completion_tokens && !body?.max_tokens) payload.max_tokens = body.max_completion_tokens;
  if (payload.tools) payload.tools = payload.tools.map((t: any) => t?.name ? { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } } : t);
  return applyCustomJson(payload, body);
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
  if (signal.aborted) controller.abort();
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
    const baseUrl = getBaseUrl(item.upstream);
    const endpoint = isAnthropic
      ? `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/messages`
      : `${baseUrl}/chat/completions`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.ok || ![408, 409, 429, 500, 502, 503, 504].includes(res.status) || attempt === 1) break;
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 250 * (attempt + 1);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, waitMs);
        const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (!res || !res.ok) {
      const detail = res ? (await res.text()).slice(0, 600) : "request failed";
      const err: any = new Error(`${item.provider} ${res?.status || 0}: ${detail}`);
      err.status = res?.status || 0;
      throw err;
    }
    const data = await res.json();
    const extracted = isAnthropic ? extractAnthropic(data) : extractOpenAI(data);
    if (!extracted.answer.trim() && !extracted.toolCalls?.length) throw new Error("empty response");
    return {
      answer: extracted.answer,
      truncated: isTruncated(item.provider, data, extracted.answer),
      finishReason: isAnthropic ? data?.stop_reason : data?.choices?.[0]?.finish_reason,
      toolCalls: extracted.toolCalls,
      rawContent: extracted.rawContent,
      usage: extracted.usage
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
    if (result.toolCalls?.length) return { answer, turns };
    if (result.rawContent?.some((x: any) => x?.type === "thinking" || x?.type === "redacted_thinking")) {
      throw new ComboContinuationError("thinking response cannot be safely reconstructed for continuation", answer, turns);
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
  if (result.toolCalls?.length) return { answer: result.answer, turns: 0 };
  if (result.truncated && result.rawContent?.some((x: any) => x?.type === "thinking" || x?.type === "redacted_thinking")) {
    throw new ComboContinuationError("thinking response cannot be safely reconstructed for continuation", result.answer, 0);
  }
  return continueCandidate(item, body, signal, result.answer, 0);
}

async function judgeAnswers(config: any, answers: Candidate[], originalBody: any, clientKey: ClientKey | null, signal: AbortSignal): Promise<string> {
  if (!config.judge) return answers[0]?.answer || "";
  const judgeUpstream = [...getActiveUpstreamKeys("openai"), ...getActiveUpstreamKeys("anthropic")]
    .find((u) => u.id === config.judge.upstreamId && u.provider === config.judge.provider && allowed(clientKey, u));
  if (!judgeUpstream) return answers[0]?.answer || "";

  const originalMessages = Array.isArray(originalBody?.messages) ? originalBody.messages : [];
  const compactMessages = JSON.stringify(originalMessages).slice(0, 30000);
  const prompt = [
    "You are the final answer judge for a multi-model AI gateway.",
    "Produce ONE best final answer to the user's request using the candidate answers below.",
    "Do not mention the gateway, candidates, providers, or judging process.",
    "",
    "USER REQUEST:",
    compactMessages,
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
      r.status === "fulfilled" && (r.value?.answer || r.value?.toolCalls?.length)
        ? [{ ...candidates[i], answer: r.value.answer, turns: r.value.turns, toolCalls: r.value.toolCalls, rawContent: r.value.rawContent, usage: r.value.usage }]
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
  const selectedToolCalls = answers[0]!.toolCalls;
  if (config.mode === "judge" && config.judge && !selectedToolCalls?.length && answers.every((a) => !a.toolCalls?.length)) {
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
      developer: config.developer,
      content: selectedToolCalls?.length
        ? selectedToolCalls.map((tc) => {
            let input: any = {};
            try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = { raw: tc.function.arguments || "" }; }
            return { type: "tool_use", id: tc.id, name: tc.function.name, input };
          })
        : [{ type: "text", text: finalAnswer }],
      stop_reason: selectedToolCalls?.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    };
    if (body?.stream) {
      const chunks = [
        `event: message_start\ndata: ${JSON.stringify({ type:"message_start", message:{ ...response, usage:{input_tokens:inputTokens,output_tokens:outputTokens} } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({type:"content_block_start",index:0,content_block:{type:"text",text:""}})}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({type:"content_block_delta",index:0,delta:{type:"text_delta",text:finalAnswer}})}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({type:"content_block_stop",index:0})}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({type:"message_delta",delta:{stop_reason:selectedToolCalls?.length ? "tool_use" : "end_turn",stop_sequence:null},usage:{output_tokens:outputTokens}})}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({type:"message_stop"})}\n\n`
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
    developer: config.developer,
    choices: [{ index:0, message:{ role:"assistant", content:finalAnswer }, finish_reason:"stop" }],
    usage: { prompt_tokens:0, completion_tokens:0, total_tokens:0 },
    system_fingerprint: "meow-combo"
  };
  if (body?.stream) {
    const chunks = `data: ${JSON.stringify({id:response.id,object:"chat.completion.chunk",created:response.created,model:publicModel,choices:[{index:0,delta:{role:"assistant",content:finalAnswer},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:response.id,object:"chat.completion.chunk",created:response.created,model:publicModel,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:response.usage})}\n\ndata: [DONE]\n\n`;
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
