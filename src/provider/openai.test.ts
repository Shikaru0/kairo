import { expect, test } from "bun:test";
import { ollama } from "./ollama.ts";
import type { ChatRequest } from "./provider.ts";

/** Fake OpenAI-compatible endpoint that records the request body it received. */
function fakeServer() {
  let received: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = await req.json();
      const enc = (chunk: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc({ choices: [{ index: 0, delta: { content: "ok" } }] }));
          c.enqueue(enc({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received: () => received, stop: () => server.stop() };
}

test("reasoning is replayed to the model in assistant content", async () => {
  const fake = fakeServer();
  const request: ChatRequest = {
    model: "test",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "the answer",
        reasoning: "I reasoned about this",
        toolCalls: [{ id: "1", name: "read", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "1", content: "file contents" },
    ],
  };

  for await (const _ of ollama(fake.url).stream(request)) {
    // drain
  }
  fake.stop();

  const sent = fake.received().messages[2];
  expect(sent.content).toContain("I reasoned about this");
  expect(sent.content).toContain("the answer");
  expect(sent.tool_calls).toHaveLength(1);
});
