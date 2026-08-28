import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeChat, OpenRouterError } from "@/lib/openrouter";

// completeChat's endpoint / key / headers are decided by @/lib/llmBackend
// from these env vars, so each test starts from a clean slate and sets only
// what it needs.
const MANAGED_ENV = [
  "LLM_BACKEND",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_TIMEOUT_MS",
  "OPENROUTER_API_KEY",
] as const;

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("completeChat", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of MANAGED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("local backend (default when LLM_BACKEND is unset)", () => {
    it("throws when LLM_API_KEY is not set", async () => {
      await expect(completeChat("qwen3-4b-local", [])).rejects.toThrow(OpenRouterError);
    });

    it("posts to LLM_BASE_URL/chat/completions with the LLM_API_KEY bearer token", async () => {
      process.env.LLM_API_KEY = "local-token";
      process.env.LLM_BASE_URL = "https://llm-box.example.ts.net/v1";
      const fetchMock = stubFetch({ choices: [{ message: { content: '{"ok":true}' } }] });

      const content = await completeChat("qwen3-4b-local", [{ role: "user", content: "hi" }]);

      expect(content).toBe('{"ok":true}');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://llm-box.example.ts.net/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer local-token");
    });

    it("strips a trailing slash from LLM_BASE_URL", async () => {
      process.env.LLM_API_KEY = "local-token";
      process.env.LLM_BASE_URL = "https://llm-box.example.ts.net/v1/";
      const fetchMock = stubFetch({ choices: [{ message: { content: "{}" } }] });

      await completeChat("qwen3-4b-local", []);

      expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
        "https://llm-box.example.ts.net/v1/chat/completions"
      );
    });

    it("falls back to the built-in base URL when LLM_BASE_URL is unset", async () => {
      process.env.LLM_API_KEY = "local-token";
      const fetchMock = stubFetch({ choices: [{ message: { content: "{}" } }] });

      await completeChat("qwen3-4b-local", []);

      expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toMatch(/^https:\/\/.+\/v1\/chat\/completions$/);
    });
  });

  describe("openrouter backend (LLM_BACKEND=openrouter)", () => {
    beforeEach(() => {
      process.env.LLM_BACKEND = "openrouter";
    });

    it("throws when OPENROUTER_API_KEY is not set", async () => {
      await expect(completeChat("openai/gpt-4o-mini", [])).rejects.toThrow(OpenRouterError);
    });

    it("posts to the OpenRouter endpoint with the OPENROUTER_API_KEY bearer token", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const fetchMock = stubFetch({ choices: [{ message: { content: '{"ok":true}' } }] });

      const content = await completeChat("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);

      expect(content).toBe('{"ok":true}');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    });
  });

  describe("response handling", () => {
    beforeEach(() => {
      process.env.LLM_API_KEY = "local-token";
    });

    it("throws OpenRouterError on a non-2xx response", async () => {
      stubFetch("server error", 500);
      await expect(completeChat("qwen3-4b-local", [])).rejects.toThrow(OpenRouterError);
    });

    it("throws OpenRouterError when the response has no message content", async () => {
      stubFetch({ choices: [] });
      await expect(completeChat("qwen3-4b-local", [])).rejects.toThrow(OpenRouterError);
    });
  });
});
