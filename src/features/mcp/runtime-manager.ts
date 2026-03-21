import { spawn } from "node:child_process";
import { once } from "node:events";
import type { IntegrationConnection } from "../../core/domain.js";

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

export interface McpRuntimeManagerOptions {
  defaultRequestTimeoutMs?: number;
}

export class McpRuntimeManager {
  readonly #sessions = new Map<string, ManagedMcpSession>();
  readonly #defaultRequestTimeoutMs: number;

  constructor(options?: McpRuntimeManagerOptions) {
    this.#defaultRequestTimeoutMs = options?.defaultRequestTimeoutMs ?? 120_000;
  }

  async listTools(connection: IntegrationConnection): Promise<McpToolDefinition[]> {
    const session = await this.ensureSession(connection);
    const result = await session.request("tools/list");
    const tools = ((result as { tools?: unknown[] }).tools ?? []) as Array<Record<string, unknown>>;

    return tools.map((tool) => ({
      name: String(tool.name),
      ...(tool.description ? { description: String(tool.description) } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object"
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {})
    }));
  }

  async callTool(connection: IntegrationConnection, input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    const session = await this.ensureSession(connection);
    return session.request("tools/call", {
      name: input.name,
      arguments: input.arguments
    });
  }

  async ensureSession(connection: IntegrationConnection): Promise<ManagedMcpSession> {
    const existing = this.#sessions.get(connection.id);
    if (existing && existing.isAlive()) {
      return existing;
    }

    if (existing) {
      this.#sessions.delete(connection.id);
      await existing.stop();
    }

    const session = await ManagedMcpSession.start(connection, this.#defaultRequestTimeoutMs);
    this.#sessions.set(connection.id, session);
    return session;
  }

  async stopSession(connectionId: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (!session) {
      return;
    }

    this.#sessions.delete(connectionId);
    await session.stop();
  }

  async stopAll(): Promise<void> {
    const sessions = Array.from(this.#sessions.values());
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.stop()));
  }
}

class ManagedMcpSession {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  readonly #buffer: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #requestTimeoutMs: number;
  #nextId = 1;
  #alive = true;

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
      this.#alive = false;
      this.#rejectAllPending(new Error(`Failed to start MCP process: ${error.message}`));
    });
    this.#child.on("close", (code, signal) => {
      this.#alive = false;
      const stderr = this.#stderrSummary();
      this.#rejectAllPending(new Error(
        `MCP process exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"})${stderr ? `: ${stderr}` : ""}`
      ));
    });
  }

  static async start(connection: IntegrationConnection, requestTimeoutMs: number): Promise<ManagedMcpSession> {
    const transport = parseMcpTransport(connection);
    const child = spawn(transport.command, transport.args ?? [], {
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      ...(transport.env ? { env: { ...process.env, ...transport.env } } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const session = new ManagedMcpSession(child, requestTimeoutMs);
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

  isAlive(): boolean {
    return this.#alive && !this.#child.killed;
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
    if (!this.isAlive()) {
      throw new Error("MCP session is not alive");
    }

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
    if (!this.isAlive()) {
      return;
    }

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

function parseMcpTransport(connection: IntegrationConnection): {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
} {
  const metadata = connection.metadata ?? {};
  const command = metadata.command;
  const args = metadata.args;
  const cwd = metadata.cwd;
  const env = metadata.env;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`MCP connection ${connection.id} is missing metadata.command`);
  }

  if (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== "string"))) {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.args`);
  }

  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.cwd`);
  }

  if (
    env !== undefined &&
    (
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== "string")
    )
  ) {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.env`);
  }

  return {
    command,
    ...(Array.isArray(args) ? { args: args as string[] } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(env ? { env: env as Record<string, string> } : {})
  };
}
