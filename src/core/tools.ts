import { ZodError, type ZodSchema } from "zod";
import type { Person } from "./domain.js";

export type ToolExposure = "conversation" | "cli_only";
export type ApprovalPolicy = "never" | "confirm" | "admin_only";
export type TargetScope = "self" | "household" | "owner_shared" | "system";

export interface RequestContext {
  requestId: string;
  invocationSource: "conversation" | "cli" | "automation";
  person?: Person;
}

export interface Tool<TInput, TOutput> {
  id: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  requiredCapabilities?: string[];
  exposure: ToolExposure;
  approvalPolicy: ApprovalPolicy;
  targetScope: TargetScope;
  execute(input: TInput, context: RequestContext): Promise<TOutput>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool<unknown, unknown>>();

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
    this.#tools.set(tool.id, tool as Tool<unknown, unknown>);
  }

  get(toolId: string): Tool<unknown, unknown> | undefined {
    return this.#tools.get(toolId);
  }

  list(): Tool<unknown, unknown>[] {
    return Array.from(this.#tools.values());
  }

  async execute(toolId: string, input: unknown, context: RequestContext): Promise<unknown> {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolId}`);
    }

    try {
      const parsedInput = tool.inputSchema.parse(input);
      return await tool.execute(parsedInput, context);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(`Invalid tool input for ${toolId}: ${error.message}`);
      }

      throw error;
    }
  }
}
