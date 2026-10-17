import { expect, test } from "bun:test";
import { ollama } from "./ollama.ts";
import type { ChatRequest, Chunk } from "./provider.ts";

/** Fake /api/chat that records the request body and replays a scripted NDJSON stream. */
function fakeServer(parts: unknown[]) {
  let received: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = await req.json();
      const body = parts.map((part) => `${JSON.stringify(part)}\n`).join("");
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received: () => received, stop: () => server.stop() };
}

async function collect(provider: ReturnType<typeof ollama>, request: ChatRequest) {
  const chunks: Chunk[] = [];
  for await (const chunk of provider.stream(request)) chunks.push(chunk);
  return chunks;
}

test("asks for a real context window and streams thinking, text and tool calls", async () => {
  const fake = fakeServer([
    { message: { thinking: "let me look" } },
    { message: { content: "reading" } },
    { message: { tool_calls: [{ function: { name: "read", arguments: { path: "a.ts" } } }] } },
    { done: true, done_reason: "stop" },
  ]);
  const provider = ollama(fake.url, { contextSize: 65536 });

  const chunks = await collect(provider, {
    model: "m",
    thinking: "high",
    temperature: 0.3,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
  });
  fake.stop();

  expect(fake.received().options).toEqual({ num_ctx: 65536, temperature: 0.3 });
  expect(fake.received().think).toBe("high");
  expect(fake.received().tools).toEqual([
    { type: "function", function: { name: "read", description: "Read a file.", parameters: { type: "object" } } },
  ]);
  expect(chunks).toEqual([
    { type: "reasoning", text: "let me look" },
    { type: "text", text: "reading" },
    { type: "toolCall", call: { id: "call_1_0", name: "read", arguments: '{"path":"a.ts"}' } },
    { type: "finish", reason: "stop" },
  ]);
});

test("replays reasoning as thinking and resolves tool results by name", async () => {
  const fake = fakeServer([{ message: { content: "done" } }, { done: true, done_reason: "stop" }]);
  const provider = ollama(fake.url);

  await collect(provider, {
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning: "I thought about it", toolCalls: [{ id: "call_1_0", name: "read", arguments: '{"path":"a.ts"}' }] },
      { role: "tool", toolCallId: "call_1_0", content: "file contents" },
    ],
  });
  fake.stop();

  const messages = fake.received().messages;
  const assistant = messages[1];
  const result = messages[2];
  expect(assistant.thinking).toBe("I thought about it");
  expect(assistant.tool_calls[0].function).toEqual({ name: "read", arguments: { path: "a.ts" } });
  expect(result).toEqual({ role: "tool", content: "file contents", tool_name: "read" });
});

test("surfaces an ollama error instead of hanging", async () => {
  const fake = fakeServer([{ error: "model not found" }]);
  const provider = ollama(fake.url);

  await expect(collect(provider, { model: "m", messages: [] })).rejects.toThrow("model not found");
  fake.stop();
});
