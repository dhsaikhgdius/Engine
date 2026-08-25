import { z } from "zod";
import type { ModelContent, ModelDriver, ModelMessage } from "@director/model-provider/runtime";

/**
 * Structured LLM calls for the film planning agents.
 *
 * The target schema is embedded into the system prompt as JSON Schema, the
 * reply is parsed with a fence- and trailing-comma-tolerant extractor,
 * validated with zod, and failed attempts are retried with the validation
 * error appended so the model can correct itself.
 */

/** Parameters for a single structured LLM completion. */
export type StructuredCallRequest = {
  system: string;
  user: string | ModelContent[];
  signal?: AbortSignal;
  maxAttempts?: number;
  temperature?: number;
};

/**
 * Formats a Zod schema as JSON Schema instructions for the system prompt.
 *
 * @param schema - The Zod schema to describe.
 * @returns A prompt fragment instructing the model to reply with JSON conforming to the schema.
 */
export function formatInstructions(schema: z.ZodType): string {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
  return [
    "Respond with a single JSON document and nothing else — no prose, no markdown fence.",
    `The JSON must conform to this JSON Schema:\n${jsonSchema}`,
  ].join("\n");
}

/**
 * Extracts the first balanced JSON object or array from text, tolerating
 * surrounding prose and markdown fences.
 *
 * @param text - Raw model output.
 * @returns The JSON substring, or null when no balanced JSON block is found.
 */
export function extractJsonCandidate(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, (_match, inner: string) => inner);
  const start = unfenced.search(/[[{]/);
  if (start === -1) return null;
  const open = unfenced[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return unfenced.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parses JSON from raw model output, first extracting a candidate JSON block
 * and falling back to stripping trailing commas.
 *
 * @param text - Raw model output.
 * @returns The parsed JSON value.
 * @throws When the reply contains no JSON document or is unparseable.
 */
export function parseJsonTolerant(text: string): unknown {
  const candidate = extractJsonCandidate(text);
  if (candidate === null) throw new Error("reply contained no JSON document");
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(withoutTrailingCommas) as unknown;
  }
}

function toUserMessage(user: string | ModelContent[]): ModelMessage {
  return {
    role: "user",
    content: typeof user === "string" ? [{ type: "text", text: user }] : user,
  };
}

/**
 * The target schema is embedded into the system prompt as JSON Schema, the
 * reply is parsed with a fence- and trailing-comma-tolerant extractor,
 * validated with zod, and failed attempts are retried with the validation
 * error appended so the model can correct itself.
 */
export class FilmStructuredCaller {
  constructor(
    private readonly driver: ModelDriver,
    private readonly model: string,
    private readonly defaults: { temperature?: number; maxOutputTokens?: number } = {},
  ) {}

  /**
   * Completes a free-text prompt and returns the raw text.
   *
   * @param request - The structured call request.
   * @returns The model's text response.
   * @throws When the model returns an empty completion.
   */
  async completeText(request: StructuredCallRequest): Promise<string> {
    const completion = await this.driver.complete({
      model: this.model,
      messages: [{ role: "system", content: [{ type: "text", text: request.system }] }, toUserMessage(request.user)],
      temperature: request.temperature ?? this.defaults.temperature,
      maxOutputTokens: this.defaults.maxOutputTokens,
      signal: request.signal,
    });
    const text = completion.message.content
      .filter((item): item is Extract<ModelContent, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (!text) throw new Error(`${this.model} returned an empty completion`);
    return text;
  }

  /**
   * Completes a structured prompt and returns a validated typed object.
   * Failed parses are retried up to maxAttempts times with the validation
   * error fed back to the model.
   *
   * @param schema - The Zod schema to validate against.
   * @param request - The structured call request.
   * @returns The validated parsed object.
   * @throws When all retry attempts are exhausted.
   */
  async completeStructured<Schema extends z.ZodType>(
    schema: Schema,
    request: StructuredCallRequest,
  ): Promise<z.infer<Schema>> {
    const maxAttempts = Math.max(1, Math.min(5, request.maxAttempts ?? 3));
    const messages: ModelMessage[] = [
      { role: "system", content: [{ type: "text", text: request.system }] },
      toUserMessage(request.user),
    ];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      request.signal?.throwIfAborted();
      const completion = await this.driver.complete({
        model: this.model,
        messages,
        temperature: request.temperature ?? this.defaults.temperature,
        maxOutputTokens: this.defaults.maxOutputTokens,
        signal: request.signal,
      });
      const text = completion.message.content
        .filter((item): item is Extract<ModelContent, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      try {
        const parsed = schema.safeParse(parseJsonTolerant(text));
        if (parsed.success) return parsed.data;
        lastError = new Error(z.prettifyError(parsed.error));
      } catch (error) {
        lastError = error;
      }
      messages.push(
        { role: "assistant", content: [{ type: "text", text: text.slice(0, 24_000) || "(empty)" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Your previous reply was not valid: ${
                lastError instanceof Error ? lastError.message.slice(0, 2_000) : String(lastError)
              }\nReply again with only the corrected JSON document.`,
            },
          ],
        },
      );
    }
    throw new Error(
      `structured completion failed after ${maxAttempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
