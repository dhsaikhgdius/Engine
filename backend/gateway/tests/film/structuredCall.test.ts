import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelCompletionRequest, ModelDriver } from "@director/model-provider/runtime";
import { extractJsonCandidate, FilmStructuredCaller, formatInstructions, parseJsonTolerant } from "../../film/structuredCall";

function scriptedDriver(replies: string[]): ModelDriver & { requests: ModelCompletionRequest[] } {
  const requests: ModelCompletionRequest[] = [];
  return {
    id: "scripted",
    kind: "openai-chat-compatible",
    requests,
    async complete(request) {
      requests.push(request);
      const reply = replies.shift() ?? "";
      return {
        id: null,
        model: null,
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
        finishReason: "stop",
        rawFinishReason: null,
        usage: null,
      };
    },
  };
}

describe("structuredCall", () => {
  it("extracts balanced JSON from fences, prose and nested strings", () => {
    expect(extractJsonCandidate('Sure! ```json\n{"a": 1}\n``` done')).toBe('{"a": 1}');
    expect(extractJsonCandidate('prefix {"a": {"b": "}"}, "c": [1, 2]} suffix')).toBe('{"a": {"b": "}"}, "c": [1, 2]}');
    expect(extractJsonCandidate("no json here")).toBeNull();
  });

  it("tolerates trailing commas", () => {
    expect(parseJsonTolerant('{"items": [1, 2,],}')).toEqual({ items: [1, 2] });
  });

  it("embeds a JSON Schema into format instructions", () => {
    const schema = z.object({ name: z.string() });
    expect(formatInstructions(schema)).toContain('"name"');
  });

  it("retries with validation feedback until the reply conforms", async () => {
    const schema = z.object({ count: z.number().int() });
    const driver = scriptedDriver(['{"count": "three"}', 'oops {"count": 3} trailing']);
    const caller = new FilmStructuredCaller(driver, "test-model");
    const result = await caller.completeStructured(schema, { system: "system", user: "user" });
    expect(result).toEqual({ count: 3 });
    expect(driver.requests).toHaveLength(2);
    const retryMessages = driver.requests[1].messages;
    const lastUser = retryMessages[retryMessages.length - 1];
    expect(JSON.stringify(lastUser.content)).toContain("not valid");
  });

  it("fails after exhausting attempts", async () => {
    const driver = scriptedDriver(["not json", "still not json"]);
    const caller = new FilmStructuredCaller(driver, "test-model");
    await expect(
      caller.completeStructured(z.object({ a: z.string() }), { system: "s", user: "u", maxAttempts: 2 }),
    ).rejects.toThrow(/failed after 2 attempts/);
  });
});
