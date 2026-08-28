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
 */
export async function completeChat(model: string, messages: ChatMessage[]): Promise<string> {
  const { backend, baseURL, apiKey, apiKeyEnvHint, timeoutMs, extraHeaders } = llmClientConfig();
  if (!apiKey) throw new OpenRouterError(`${apiKeyEnvHint} is not set.`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenRouterError(`LLM endpoint returned no content for ${model}.`);
  return content;
}
