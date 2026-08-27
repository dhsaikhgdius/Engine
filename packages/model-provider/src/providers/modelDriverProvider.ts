/**
 * Adapter from the canonical wire ModelDriver to the public ModelProvider
 * surface. All built-in providers funnel through this file, so the high-level
 * chat()/streamChat() semantics (message flattening, timeout handling, finish
 * reason mapping) are defined exactly once regardless of the underlying API
 * protocol.
 */
import type { ChatChunk, ChatMessage, ChatOptions, ChatResult, ModelDescriptor, ModelProvider } from "../types";
import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelDriver,
  ModelFinishReason,
  ModelMessage,
  ModelToolCallContent,
} from "../runtime/modelDriver";

type DriverProviderOptions = {
  descriptor: ModelDescriptor;
  driver: ModelDriver;
  label?: string;
  timeoutMs: number;
};

/**
 * Builds the public provider API over one canonical wire driver.
 *
 * `complete`/`stream` pass straight through (the caller owns the request
 * shape and cancellation); `chat`/`streamChat` add the convenience layer:
 * plain-string messages, an injected system prompt, and a provider-level
 * timeout composed with the caller's AbortSignal. A driver without native
 * streaming still satisfies `stream`/`streamChat` by degrading to one
 * buffered completion.
 */
export function createModelDriverProvider({
  descriptor,
  driver,
  label,
  timeoutMs,
}: DriverProviderOptions): ModelProvider {
  return {
    id: driver.id,
    descriptor,
    label: label ?? descriptor.label,
    complete: (request) => driver.complete(request),
    stream: (request, callbacks) => (driver.stream ? driver.stream(request, callbacks) : driver.complete(request)),
    async chat(messages, options) {
      return withRequestTimeout(options?.signal, timeoutMs, async (signal) =>
        toChatResult(await driver.complete(toCompletionRequest(descriptor.model, messages, options, signal))),
      );
    },
    streamChat(messages, options) {
      return streamDriverChat(
        driver,
        toCompletionRequest(descriptor.model, messages, options),
        options?.signal,
        timeoutMs,
      );
    },
  };
}

// Lifts plain chat strings into the canonical content-array request shape.
// Optional fields are spread conditionally so the wire request never carries
// explicit `undefined` keys (some providers reject them).
function toCompletionRequest(
  defaultModel: string,
  messages: readonly ChatMessage[],
  options?: ChatOptions,
  signal?: AbortSignal,
): ModelCompletionRequest {
  const modelMessages: ModelMessage[] = messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
  if (options?.system) {
    modelMessages.unshift({ role: "system", content: [{ type: "text", text: options.system }] });
  }
  return {
    model: options?.model ?? defaultModel,
    messages: modelMessages,
    ...(options?.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    ...(options?.tools?.length
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.parameters,
          })),
        }
      : {}),
    ...(options?.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(signal === undefined ? {} : { signal }),
  };
}

// Flattens the canonical completion for chat() callers: text blocks join to
// one string, tool calls keep only successfully parsed object arguments
// (malformed JSON degrades to {} — chat() consumers are not equipped to
// handle raw strings; the low-level API preserves them).
function toChatResult(completion: ModelCompletion): ChatResult {
  const toolCalls = completion.message.content
    .filter((item): item is ModelToolCallContent => item.type === "tool-call")
    .map((item) => ({
      id: item.id,
      name: item.name,
      arguments: objectArguments(item.arguments),
    }));
  return {
    content: completionText(completion),
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: toChatFinishReason(completion.finishReason),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

function completionText(completion: ModelCompletion) {
  return completion.message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function objectArguments(value: ModelToolCallContent["arguments"]): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toChatFinishReason(reason: ModelFinishReason): ChatResult["finishReason"] {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "length" || reason === "content-filter" || reason === "error") return reason;
  return "stop";
}

/**
 * Push-to-pull bridge: the driver reports deltas via callbacks, but
 * streamChat consumers want an AsyncIterable. Chunks are buffered in a queue
 * and the generator sleeps on a `wake` promise between pushes.
 *
 * The final chunk reconciles buffered stream text against the completed
 * message (`finalText.startsWith(streamedText)` → emit only the missing
 * tail) so consumers that concatenate deltas never see duplicated text, even
 * when a driver returns a fuller final message than it streamed. Tool calls
 * are only emitted on that final chunk, with raw string arguments, because
 * partial tool-call JSON is useless mid-stream. If the consumer abandons the
 * iterator early, the `finally` block aborts the underlying request instead
 * of letting it run to completion unobserved.
 */
async function* streamDriverChat(
  driver: ModelDriver,
  request: ModelCompletionRequest,
  sourceSignal: AbortSignal | undefined,
  timeoutMs: number,
): AsyncIterable<ChatChunk> {
  const timeout = requestTimeout(sourceSignal, timeoutMs);
  const queue: ChatChunk[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown;
  let streamedText = "";
  const push = (chunk: ChatChunk) => {
    queue.push(chunk);
    wake?.();
    wake = null;
  };

  const run = (
    driver.stream
      ? driver.stream(
          { ...request, signal: timeout.signal },
          {
            onTextDelta: (delta) => {
              streamedText += delta;
              push({ delta });
            },
            onReasoningDelta: (reasoningDelta) => push({ delta: "", reasoningDelta }),
          },
        )
      : driver.complete({ ...request, signal: timeout.signal })
  )
    .then((completion) => {
      const finalText = completionText(completion);
      const delta = finalText.startsWith(streamedText) ? finalText.slice(streamedText.length) : finalText;
      const toolCalls = completion.message.content
        .filter((item): item is ModelToolCallContent => item.type === "tool-call")
        .map((item) => ({
          id: item.id,
          name: item.name,
          arguments: item.rawArguments ?? JSON.stringify(item.arguments),
        }));
      push({
        delta,
        ...(toolCalls.length ? { toolCalls } : {}),
        finishReason: toChatFinishReason(completion.finishReason),
      });
    })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      finished = true;
      timeout.dispose();
      wake?.();
      wake = null;
    });

  try {
    while (!finished || queue.length) {
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await run;
    if (failure) throw failure;
  } finally {
    if (!finished) timeout.abort();
    timeout.dispose();
  }
}

async function withRequestTimeout<T>(
  sourceSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = requestTimeout(sourceSignal, timeoutMs);
  try {
    return await run(timeout.signal);
  } finally {
    timeout.dispose();
  }
}

/**
 * Composes the caller's AbortSignal with the provider timeout into a single
 * signal. Abort reasons are distinguishable downstream: caller aborts forward
 * their original reason, the timer produces a TimeoutError, and an abandoned
 * stream produces an AbortError. `dispose` must always run to clear the timer
 * and detach the listener, or long-lived caller signals would accumulate
 * listeners across requests.
 */
function requestTimeout(sourceSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) forwardAbort();
  else sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Model request timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    abort: () => controller.abort(new DOMException("Model stream closed", "AbortError")),
    dispose: () => {
      clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}
