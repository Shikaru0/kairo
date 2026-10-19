import { spawn } from "node:child_process";

/**
 * A validated server to connect to, with `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
 * already expanded by the loader. The loader also owns every rejection a bad
 * entry can earn; this file only speaks MCP.
 */
export type ServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { type: "streamable-http"; url: string; headers: Record<string, string> };

/** One tool an MCP server offers, in the shape the model is told about. */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments, passed through as the model's parameter schema. */
  inputSchema?: Record<string, unknown>;
}

/** A connected MCP server. */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** What the server said about itself during the handshake, if anything. */
  instructions?: string;
  stop(): void;
}

/** How long one handshake or listing may take; a server that hangs must not hang startup. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long one tool call may take: real work can run for a while. */
const CALL_TIMEOUT_MS = 60_000;
/** How much of a server's stderr is kept to explain why it died. */
const STDERR_KEEP = 2_000;
/** The MCP revision this client speaks; the server answers with the one it supports. */
const PROTOCOL = "2025-11-25";

/**
 * JSON-RPC 2.0 over one transport. Requests are matched to replies by id, so a
 * server that answers nothing fails its own request instead of wedging the turn.
 */
class Rpc {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly send: (json: string) => void) {}

  request(method: string, params: unknown, timeout = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Feed one received document; anything that is not a reply to us is ignored. */
  receive(text: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "server error"));
    else entry.resolve(message.result);
  }

  /** Every waiting request fails at once when the transport dies. */
  fail(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

/** A JSON-RPC connection plus the way to tear it down. */
interface Transport {
  rpc: Rpc;
  stop(): void;
}

/** A subprocess speaking newline-delimited JSON-RPC on its own stdio. */
function stdio(config: Extract<ServerConfig, { type: "stdio" }>): Transport {
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const rpc = new Rpc((json) => child.stdin?.write(`${json}\n`));

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) rpc.receive(line);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });

  const stop = () => child.kill();
  // A server that dies takes its outstanding calls with it, with its stderr as the reason.
  child.on("exit", () => rpc.fail(new Error(`server exited${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
  child.on("error", (error) => rpc.fail(error));
  // The child would outlive the client otherwise, since it holds the pipe rather than the terminal.
  process.on("exit", stop);

  return { rpc, stop };
}

/** A remote server over the MCP Streamable HTTP transport: every message is its own POST. */
async function http(config: Extract<ServerConfig, { type: "streamable-http" }>): Promise<Transport> {
  /** The session the server handed back on initialize; later requests must echo it. */
  let session: string | undefined;
  let rpc: Rpc;

  const post = async (json: string): Promise<void> => {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        ...config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: json,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const assigned = response.headers.get("mcp-session-id");
    if (assigned) session = assigned;
    if (!response.ok) {
      rpc.fail(new Error(`server returned ${response.status} ${response.statusText}`));
      return;
    }
    // A notification is answered with 202 and no body at all.
    if (response.status === 202 || response.status === 204) return;
    for (const payload of payloads(await response.text())) rpc.receive(payload);
  };

  rpc = new Rpc((json) => {
    // The reply is delivered to this same POST, so send and receive cannot be split.
    void post(json).catch((error: unknown) => rpc.fail(error instanceof Error ? error : new Error(String(error))));
  });

  return { rpc, stop: () => {} };
}

/** The JSON documents inside a reply body: either bare JSON or the `data:` lines of an SSE stream. */
function payloads(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return [trimmed];
  return trimmed
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter(Boolean);
}

/**
 * Open a server and take it through the MCP handshake. A server that fails here
 * is reported by the caller and skipped; the rest of the plugin still loads.
 */
export async function connect(config: ServerConfig): Promise<McpSession> {
  const transport = config.type === "stdio" ? stdio(config) : await http(config);
  let instructions: string | undefined;
  try {
    const initialized = (await transport.rpc.request(
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "kairo", version: "0.1.0" } },
      CONNECT_TIMEOUT_MS,
    )) as { instructions?: unknown };
    // A server may explain how to use its tools; the system prompt is where that belongs.
    if (typeof initialized?.instructions === "string") instructions = initialized.instructions.trim() || undefined;
    transport.rpc.notify("notifications/initialized", {});
  } catch (error) {
    transport.stop();
    throw error;
  }

  return {
    instructions,
    async listTools() {
      // Servers page long tool lists; a cursor means there is another page.
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await transport.rpc.request("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS)) as {
          tools?: McpTool[];
          nextCursor?: string;
        };
        tools.push(...(result.tools ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      return tools.filter((tool) => typeof tool?.name === "string" && tool.name);
    },
    async call(name, args) {
      const result = (await transport.rpc.request("tools/call", { name, arguments: args })) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .map((part) => part?.text)
        .filter((part): part is string => typeof part === "string")
        .join("\n");
      // A reported error is a tool failure, so the turn counts it like any other failed call.
      if (result.isError) throw new Error(text || `${name} failed`);
      return text || JSON.stringify(result);
    },
    stop: transport.stop,
  };
}
