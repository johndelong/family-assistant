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
  inputJsonSchema?: Record<string, unknown>;
  requiredCapabilities?: string[];
  exposure: ToolExposure;
  approvalPolicy: ApprovalPolicy;
  targetScope: TargetScope;
  execute(input: TInput, context: RequestContext): Promise<TOutput>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool<unknown, unknown>>();
  #availabilityResolver?: (toolId: string) => boolean;

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
    this.#tools.set(tool.id, tool as Tool<unknown, unknown>);
  }

  setAvailabilityResolver(resolver: (toolId: string) => boolean): void {
    this.#availabilityResolver = resolver;
  }

  get(toolId: string): Tool<unknown, unknown> | undefined {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      return undefined;
    }

    return this.#isAvailable(toolId) ? tool : undefined;
  }

  list(): Tool<unknown, unknown>[] {
    return Array.from(this.#tools.values()).filter((tool) => this.#isAvailable(tool.id));
  }

  listConversationTools(): Tool<unknown, unknown>[] {
    return this.list().filter((tool) => tool.exposure === "conversation");
  }

  async execute(toolId: string, input: unknown, context: RequestContext): Promise<unknown> {
    if (!this.#isAvailable(toolId)) {
      throw new Error(`Tool is disabled: ${toolId}`);
    }

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

  #isAvailable(toolId: string): boolean {
    return this.#availabilityResolver ? this.#availabilityResolver(toolId) : true;
  }
}
