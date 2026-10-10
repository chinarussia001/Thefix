export const VYCE_BASE_URL = "https://vyceai.com/v1";
export const SUPPORTED_MODELS = Object.freeze([
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", role: "default" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", role: "fallback" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", role: "final-fallback" },
]);
export const MODEL_PRICE_SNAPSHOT = Object.freeze({
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "deepseek-v4-flash": { input: 0.22, output: 0.66 },
  "gpt-6-luna": { input: 2, output: 2 },
});
export const PRICING_BASIS = "Estimate from the user-provided model pricing snapshot; not live-verified.";

export function estimateCostUsd(model, inputTokens, outputTokens) {
  const price = MODEL_PRICE_SNAPSHOT[model];
  if (!price) throw new Error(`No reference pricing is configured for model ${model}.`);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export class ProviderError extends Error {
  constructor(message, { status = 0, code = "provider_error", retryAfter = 0 } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class VyceClient {
  constructor({ apiKey = process.env.VYCE_API_KEY, fetchImpl = fetch, baseUrl = VYCE_BASE_URL } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  requireKey() {
    if (!this.apiKey) throw new ProviderError("Vyce AI is not configured. Set VYCE_API_KEY in the backend environment.", { code: "not_configured" });
  }

  async request(path, body, { timeoutMs = 90000, signal } = {}) {
    this.requireKey();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new ProviderError("Vyce AI request timed out.", { code: "timeout" });
      }
      throw new ProviderError(`Could not reach Vyce AI: ${error instanceof Error ? error.message : String(error)}`, { code: "network_error" });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(`Vyce AI returned malformed JSON (HTTP ${response.status}).`, { status: response.status, code: "malformed_response" });
    }
    if (!response.ok) {
      const providerCode = String(payload?.error?.code || payload?.error?.type || "");
      const rawMessage = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      const message = this.apiKey ? rawMessage.split(this.apiKey).join("[redacted]") : rawMessage;
      const code = /context_length|maximum_context|context_window|too_many_tokens/i.test(providerCode + rawMessage) ? "context_window"
        : response.status === 401 ? "invalid_credentials"
        : response.status === 402 ? "insufficient_balance"
          : response.status === 429 ? "rate_limited"
            : response.status === 404 ? "model_unavailable"
              : response.status >= 500 ? "provider_unavailable"
                : providerCode || "request_rejected";
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      throw new ProviderError(`Vyce AI rejected the request (${response.status}): ${message}`, {
        status: response.status, code, retryAfter,
      });
    }
    return payload;
  }

  async models() {
    const response = await this.request("/models");
    if (!Array.isArray(response?.data)) {
      throw new ProviderError("Vyce AI returned a model catalogue without a valid data array.", { code: "malformed_response" });
    }
    const available = new Set((Array.isArray(response?.data) ? response.data : [])
      .map((item) => typeof item?.id === "string" ? item.id : ""));
    return SUPPORTED_MODELS.map((model) => ({ ...model, available: available.has(model.id) }));
  }

  async complete({ model, messages, tools, signal }) {
    const payload = await this.request("/chat/completions", {
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }, { signal });
    const choice = payload?.choices?.[0];
    if (!choice?.message || typeof choice.message !== "object") {
      throw new ProviderError("Vyce AI returned a completion without a valid message.", { code: "malformed_response" });
    }
    if (choice.message.tool_calls !== undefined && !Array.isArray(choice.message.tool_calls)) {
      throw new ProviderError("Vyce AI returned tool calls in an invalid format.", { code: "malformed_response" });
    }
    const usage = payload.usage ?? null;
    if (usage !== null) {
      if (typeof usage !== "object" || Array.isArray(usage)) {
        throw new ProviderError("Vyce AI returned usage metadata in an invalid format.", { code: "malformed_response" });
      }
      for (const field of ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens"]) {
        if (usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || usage[field] < 0)) {
          throw new ProviderError(`Vyce AI returned an invalid ${field} usage value.`, { code: "malformed_response" });
        }
      }
    }
    return { message: choice.message, usage };
  }
}
