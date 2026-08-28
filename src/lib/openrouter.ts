/**
 * Thin client for an OpenAI-compatible chat-completions endpoint. No SDK —
 * the schema is a straight superset of OpenAI's, so a single fetch call is
 * simpler than a dependency.
 *
 * Which endpoint it hits is decided entirely by LLM_BACKEND (see
 * llmBackend.ts): the self-hosted server (default) or OpenRouter. The name
 * "openrouter" / "OpenRouterError" is kept for continuity with callers —
 * despite it, this fronts whichever backend is configured.
 */

import { llmClientConfig } from "@/lib/llmBackend";
import { estimateTokens, recordLlmCall, type LlmCallType } from "@/lib/llmTelemetry";

export type ChatMessage = { role: "system" | "user"; content: string };

export class OpenRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/**
 * Sends one chat-completion request to the given model and returns the
 * assistant message's raw text content. Requests JSON-object output —
 * callers are still responsible for validating the shape of what comes
 * back, since "valid JSON" and "matches our schema" are different things.
 *
 * `callType` is observability only (see llmTelemetry.ts): it tags the
 * per-call token/latency record so a per-quiz summary can break spend down
 * by draft vs. repair vs. judge. It never changes the request.
 */
export async function completeChat(
  model: string,
  messages: ChatMessage[],
  callType: LlmCallType = "unknown"
): Promise<string> {
  const { backend, baseURL, apiKey, apiKeyEnvHint, timeoutMs, extraHeaders } = llmClientConfig();
  if (!apiKey) throw new OpenRouterError(`${apiKeyEnvHint} is not set.`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new OpenRouterError(
      error instanceof Error && error.name === "AbortError"
        ? `LLM request to ${model} timed out after ${timeoutMs}ms.`
        : `Could not reach the ${backend} LLM endpoint: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OpenRouterError(`LLM endpoint returned HTTP ${response.status} for ${model}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenRouterError(`LLM endpoint returned no content for ${model}.`);

  const serverPrompt = data.usage?.prompt_tokens;
  const serverCompletion = data.usage?.completion_tokens;
  const hasServerUsage = typeof serverPrompt === "number" && typeof serverCompletion === "number";
  recordLlmCall({
    callType,
    promptTokens: hasServerUsage ? serverPrompt : estimateTokens(messages.map((m) => m.content).join("\n")),
    completionTokens: hasServerUsage ? serverCompletion : estimateTokens(content),
    latencyMs: Date.now() - startedAt,
    estimated: !hasServerUsage,
  });
  return content;
}
