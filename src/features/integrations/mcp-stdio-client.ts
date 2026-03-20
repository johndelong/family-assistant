import { spawn } from "node:child_process";
import { once } from "node:events";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpStdioConnectionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export class McpStdioClient {
  async listTools(options: McpStdioConnectionOptions): Promise<McpToolDefinition[]> {
    const session = await McpStdioSession.start(options);

    try {
      const result = await session.request("tools/list");
      const tools = ((result as { tools?: unknown[] }).tools ?? []) as Array<Record<string, unknown>>;

      return tools.map((tool) => ({
        name: String(tool.name),
        ...(tool.description ? { description: String(tool.description) } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object"
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {})
      }));
    } finally {
      await session.stop();
    }
  }

  async callTool(options: McpStdioConnectionOptions, input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    const session = await McpStdioSession.start(options);

    try {
      return await session.request("tools/call", {
        name: input.name,
        arguments: input.arguments
      });
    } finally {
      await session.stop();
    }
  }
}

class McpStdioSession {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  readonly #buffer: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #requestTimeoutMs: number;
  #nextId = 1;

  private constructor(child: ReturnType<typeof spawn>, requestTimeoutMs: number) {
    this.#child = child;
    this.#requestTimeoutMs = requestTimeoutMs;
    if (!this.#child.stdout || !this.#child.stdin || !this.#child.stderr) {
      throw new Error("MCP stdio process did not expose stdin/stdout/stderr");
    }

    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#onStdout(chunk);
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrChunks.push(chunk);
    });
    this.#child.on("error", (error) => {
      this.#rejectAllPending(new Error(`Failed to start MCP process: ${error.message}`));
    });
    this.#child.on("close", (code, signal) => {
      const stderr = this.#stderrSummary();
      this.#rejectAllPending(new Error(
        `MCP process exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"})${stderr ? `: ${stderr}` : ""}`
      ));
    });
  }

  static async start(options: McpStdioConnectionOptions): Promise<McpStdioSession> {
    const child = spawn(options.command, options.args ?? [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const session = new McpStdioSession(child, options.requestTimeoutMs ?? 30_000);
    await session.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: {
        name: "family-assistant",
        version: "0.1.0"
      },
      capabilities: {}
    });
    session.notify("notifications/initialized");
    return session;
  }

  async stop(): Promise<void> {
    this.#child.stdin?.end();
    this.#child.kill();
    try {
      await once(this.#child, "close");
    } catch {
      return;
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {})
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.#requestTimeoutMs);

      this.#pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });

    this.#child.stdin?.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      ...(params ? { params } : {})
    };

    this.#child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#buffer.push(chunk);
    const combined = this.#buffer.join("");
    const lines = combined.split("\n");
    this.#buffer.length = 0;

    const remainder = lines.pop();
    if (remainder) {
      this.#buffer.push(remainder);
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (typeof message.id !== "number") {
        continue;
      }

      const pending = this.#pending.get(message.id);
      if (!pending) {
        continue;
      }

      this.#pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
        continue;
      }

      pending.resolve(message.result);
    }
  }

  #rejectAllPending(error: Error): void {
    for (const [id, pending] of this.#pending.entries()) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #stderrSummary(): string {
    const stderr = this.#stderrChunks.join("").trim();
    if (!stderr) {
      return "";
    }

    return stderr.length > 600 ? `${stderr.slice(0, 597)}...` : stderr;
  }
}
