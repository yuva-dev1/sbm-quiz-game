/**
 * Scores whether a generated quiz question is actually supported by the
 * course-note text it was supposed to be grounded in, using autoevals'
 * (https://github.com/braintrustdata/autoevals) RAGAS-style Faithfulness
 * metric — an LLM-as-judge check for whether the claim's assertions appear
 * in the source, not just whether they sound plausible.
 *
 * The judge runs on whatever LLM_BACKEND selects (see llmBackend.ts): the
 * self-hosted endpoint (default) or OpenRouter. In the default "local" mode
 * the judge model IS the drafter model (one 4B model on the box) — a model
 * grading its own output is more lenient than an independent judge, and
 * autoevals' Faithfulness prompt doesn't always parse cleanly against a
 * model that small. When the judge call fails or returns no numeric score,
 * scoreFaithfulness fails open (returns null → the caller skips the check)
 * and logs it, so a validator outage never silently drops an otherwise-good
 * question and the skipped-check rate stays visible in Cloud Run logs.
 */

import OpenAI from "openai";
import { Faithfulness } from "autoevals";
import { llmClientConfig } from "@/lib/llmBackend";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const { baseURL, apiKey, apiKeyEnvHint } = llmClientConfig();
    if (!apiKey) throw new Error(`${apiKeyEnvHint} is not set.`);
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}

/**
 * Returns a 0-1 faithfulness score, or null when there's nothing to check
 * (no source text for this scope) or the judge call itself failed — a
 * validator outage shouldn't silently drop an otherwise-valid question, so
 * callers should treat null as "skip this check" rather than "failed it."
 */
export async function scoreFaithfulness(claim: string, sourceText: string, judgeModel: string): Promise<number | null> {
  if (!sourceText.trim()) return null;

  try {
    const result = await Faithfulness({
      output: claim,
      context: sourceText,
      model: judgeModel,
      client: getClient(),
    });
    if (typeof result.score === "number") return result.score;
    console.warn(
      `[faithfulness] judge "${judgeModel}" returned no numeric score — failing open, grounding check skipped ` +
        `for this question (autoevals' Faithfulness can fail to parse against a small local model).`
    );
    return null;
  } catch (error) {
    console.warn(
      `[faithfulness] judge "${judgeModel}" call failed — failing open, grounding check skipped for this ` +
        `question: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
