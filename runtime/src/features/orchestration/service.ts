import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import type { ToolRegistry } from "../../core/tools.js";
import { randomUUID } from "node:crypto";
import type { DirectActionTrace } from "../direct-actions/executor.js";
import type { McpPromptService } from "../integrations/mcp-prompt-service.js";
import { LlmService } from "../llm/service.js";
import type { MemoryRetrievalService, RetrievedMemory } from "../memory/retrieval-service.js";
import type { MonitorEventHub } from "../monitor/hub.js";
import type { PersonRepository } from "../persons/repository.js";
import type { PromptProfileContext, PromptProfileService } from "../profiles/prompt-profile-service.js";
import type { SessionContext, SessionService } from "../sessions/service.js";
import type { StructuredExecutionRunRepository } from "../structured-execution/repository.js";
import type { StructuredExecutionService } from "../structured-execution/service.js";
import { validateWorkflowState } from "../structured-execution/service.js";
import type { TraceWriter } from "../tracing/writer.js";

export interface OrchestratedResponse {
  route: "direct_response" | "tool_execution" | "llm_response";
  content: string;
  model?: string;
  awaitingApproval?: {
    runId: string;
    resumeToken: string;
  };
  trace?: {
    directAction?: DirectActionTrace;
    integrationPrompts?: Array<{
      connectionId: string;
      integrationKey: string;
      promptName: string;
    }>;
    usedTools?: string[];
    toolTrace?: Array<{
      toolName: string;
      arguments: string;
      output?: string;
      error?: string;
    }>;
    timing?: {
      llmStartedAt?: string;
      llmCompletedAt?: string;
      firstToolCallAt?: string;
      firstToolCallMs?: number;
      totalLlmMs?: number;
      toolCalls?: Array<{
        toolName: string;
        startedAt: string;
        completedAt: string;
        durationMs: number;
        success: boolean;
      }>;
    };
    toolSelectionTrace?: Array<{
      toolId: string;
      score: number;
      selected: boolean;
    }>;
    relevantMemories?: RetrievedMemory[];
    profileContext?: PromptProfileContext;
    sessionContext?: SessionContext;
  };
}

export class OrchestrationService {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly llmService?: LlmService,
    private readonly memoryRetrievalService?: MemoryRetrievalService,
    private readonly promptProfileService?: PromptProfileService,
    private readonly sessionService?: SessionService,
    private readonly mcpPromptService?: McpPromptService,
    private readonly structuredExecutionService?: StructuredExecutionService,
    private readonly structuredExecutionRuns?: StructuredExecutionRunRepository,
    private readonly persons?: PersonRepository,
    private readonly traceWriter?: TraceWriter,
    private readonly monitorHub?: MonitorEventHub
  ) {}

  async processResolvedMessage(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
    onProgress?: ((message: string) => Promise<void>) | undefined;
  }): Promise<OrchestratedResponse> {
    const rawText = input.message.text.trim();
    if (this.llmService) {
      const profileContext = this.promptProfileService
        ? await this.promptProfileService.buildContextForPerson(input.person)
        : undefined;
      const sessionContext = this.sessionService
        ? await this.sessionService.loadContext({
            person: input.person,
            message: input.message
          })
        : undefined;
      const relevantMemories = this.memoryRetrievalService
        ? await this.memoryRetrievalService.retrieveForMessage({
            person: input.person,
            messageText: input.message.text,
            limit: 5
          })
        : [];
      const structuredExecution = this.structuredExecutionService?.resolve({
        messageText: input.message.text,
        sessionContext,
        tools: this.toolRegistry.listConversationTools()
      }) ?? null;
      const structuredRun = structuredExecution && this.structuredExecutionRuns
        ? await this.structuredExecutionRuns.createRun({
            requestId: input.requestId,
            personId: input.person.id,
            skillName: structuredExecution.skillName,
            runtime: structuredExecution.runtime,
            messageText: input.message.text,
            trace: structuredExecution.trace as unknown as Record<string, unknown>
          })
        : undefined;
      if (structuredRun) {
        this.monitorHub?.publish({
          type: "structured_execution.run",
          event: {
            id: structuredRun.id,
            ...(structuredRun.requestId ? { requestId: structuredRun.requestId } : {}),
            skillName: structuredRun.skillName,
            runtime: structuredRun.runtime,
            status: structuredRun.status,
            messageText: structuredRun.messageText,
            updatedAt: structuredRun.updatedAt.toISOString()
          }
        });
      }

      if (structuredExecution?.runtime === "workflow" && this.structuredExecutionService) {
        await input.onProgress?.(
          structuredExecution.progressMessage ?? "Thinking through that..."
        );

        const workflowResult = await this.structuredExecutionService.execute({
          plan: structuredExecution,
          requestId: input.requestId,
          person: input.person,
          messageText: input.message.text,
          toolRegistry: this.toolRegistry,
          ...(sessionContext ? { sessionContext } : {})
        });

        if (workflowResult) {
          if (sessionContext) {
            await this.sessionService?.recordTurn({
              sessionId: sessionContext.session.id,
              userMessage: input.message.text,
              assistantMessage: workflowResult.content
            });
          }

          if (workflowResult.status === "awaiting_approval" && structuredRun) {
            const pausedRun = await this.structuredExecutionRuns?.pauseRun({
              id: structuredRun.id,
              currentStepId: workflowResult.currentStepId,
              state: workflowResult.state as unknown as Record<string, unknown>,
              trace: workflowResult.trace as unknown as Record<string, unknown>,
              result: workflowResult.content
            }).catch(() => undefined);

            if (pausedRun) {
              this.monitorHub?.publish({
                type: "structured_execution.run",
                event: {
                  id: pausedRun.id,
                  ...(pausedRun.requestId ? { requestId: pausedRun.requestId } : {}),
                  skillName: pausedRun.skillName,
                  runtime: pausedRun.runtime,
                  status: pausedRun.status,
                  messageText: pausedRun.messageText,
                  updatedAt: pausedRun.updatedAt.toISOString(),
                  ...(pausedRun.result ? { result: pausedRun.result } : {})
                }
              });
              await this.traceWriter?.write({
                timestamp: new Date().toISOString(),
                requestId: input.requestId,
                stage: "structured_execution.paused",
                payload: {
                  runId: pausedRun.id,
                  skillName: structuredExecution.skillName,
                  runtime: structuredExecution.runtime,
                  currentStepId: workflowResult.currentStepId,
                  awaitingApproval: true
                }
              }).catch(() => undefined);
            }

            return {
              route: "tool_execution",
              content: workflowResult.content,
              ...(pausedRun?.resumeToken
                ? {
                    awaitingApproval: {
                      runId: pausedRun.id,
                      resumeToken: pausedRun.resumeToken
                    }
                  }
                : {}),
              trace: {
                directAction: workflowResult.trace,
                relevantMemories,
                ...(sessionContext ? { sessionContext } : {}),
                ...(profileContext ? { profileContext } : {})
              }
            };
          }

          if (structuredRun) {
            await this.structuredExecutionRuns?.completeRun({
              id: structuredRun.id,
              status: workflowResult.status === "failed" ? "failed" : "completed",
              trace: workflowResult.trace as unknown as Record<string, unknown>,
              result: workflowResult.content
            }).catch(() => undefined);
            this.monitorHub?.publish({
              type: "structured_execution.run",
              event: {
                id: structuredRun.id,
                ...(structuredRun.requestId ? { requestId: structuredRun.requestId } : {}),
                skillName: structuredRun.skillName,
                runtime: structuredRun.runtime,
                status: workflowResult.status === "failed" ? "failed" : "completed",
                messageText: structuredRun.messageText,
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                result: workflowResult.content
              }
            });
          }

          await this.traceWriter?.write({
            timestamp: new Date().toISOString(),
            requestId: input.requestId,
            stage: "structured_execution.completed",
            payload: {
              ...(structuredRun ? { runId: structuredRun.id } : {}),
              skillName: structuredExecution.skillName,
              runtime: structuredExecution.runtime,
              status: workflowResult.status
            }
          }).catch(() => undefined);

          return {
            route: "tool_execution",
            content: workflowResult.content,
            trace: {
              directAction: workflowResult.trace,
              relevantMemories,
              ...(sessionContext ? { sessionContext } : {}),
              ...(profileContext ? { profileContext } : {})
            }
          };
        }

        if (structuredRun) {
          await this.structuredExecutionRuns?.completeRun({
            id: structuredRun.id,
            status: "failed",
            trace: structuredExecution.trace as unknown as Record<string, unknown>,
            result: "Workflow execution returned no result."
          }).catch(() => undefined);
          this.monitorHub?.publish({
            type: "structured_execution.run",
            event: {
              id: structuredRun.id,
              ...(structuredRun.requestId ? { requestId: structuredRun.requestId } : {}),
              skillName: structuredRun.skillName,
              runtime: structuredRun.runtime,
              status: "failed",
              messageText: structuredRun.messageText,
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              result: "Workflow execution returned no result."
            }
          });
        }
      }

      await input.onProgress?.(
        structuredExecution?.progressMessage ?? "Thinking through that..."
      );

      const integrationPromptSections = structuredExecution && this.mcpPromptService && structuredExecution.integrationPrompts === "matched_tools"
        ? await this.mcpPromptService.buildPromptSections({
            toolIds: structuredExecution.toolIds,
            maxPromptsPerConnection: 2
          })
        : [];

      const response = await this.llmService.respondWithTools({
        requestId: input.requestId,
        person: input.person,
        message: input.message,
        toolRegistry: this.toolRegistry,
        ...(structuredExecution ? { allowedToolIds: structuredExecution.toolIds } : {}),
        ...(integrationPromptSections.length > 0
          ? { integrationPromptSections: integrationPromptSections.map((item) => item.content) }
          : {}),
        relevantMemories,
        profileContext,
        sessionContext,
        onProgress: input.onProgress
      });
      const finalText = response.text;

      if (sessionContext) {
        await this.sessionService?.recordTurn({
          sessionId: sessionContext.session.id,
          userMessage: input.message.text,
          assistantMessage: finalText
        });
      }

      if (structuredRun) {
        await this.structuredExecutionRuns?.completeRun({
          id: structuredRun.id,
          status: "completed",
          ...(structuredExecution
            ? { trace: structuredExecution.trace as unknown as Record<string, unknown> }
            : {}),
          result: finalText
        }).catch(() => undefined);
        this.monitorHub?.publish({
          type: "structured_execution.run",
          event: {
            id: structuredRun.id,
            ...(structuredRun.requestId ? { requestId: structuredRun.requestId } : {}),
            skillName: structuredRun.skillName,
            runtime: structuredRun.runtime,
            status: "completed",
            messageText: structuredRun.messageText,
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            result: finalText
          }
        });
      }

      return {
        route: "llm_response",
        content: finalText,
        model: response.model,
        trace: {
          ...(structuredExecution
            ? {
                directAction: structuredExecution.trace
              }
            : {}),
          ...(integrationPromptSections.length > 0
            ? {
                integrationPrompts: integrationPromptSections.map((item) => ({
                  connectionId: item.connectionId,
                  integrationKey: item.integrationKey,
                  promptName: item.promptName
                }))
              }
            : {}),
          usedTools: response.usedTools,
          toolTrace: response.toolTrace,
          ...(response.timing ? { timing: response.timing } : {}),
          toolSelectionTrace: response.toolSelectionTrace,
          relevantMemories,
          ...(sessionContext ? { sessionContext } : {}),
          ...(profileContext ? { profileContext } : {})
        }
      };
    }

    return {
      route: "direct_response",
      content: `I recognized you as ${input.person.name} and received your message: "${input.message.text}". Tool routing and LLM orchestration are the next layer to add.`
    };
  }

  async resumeStructuredExecution(input: {
    resumeToken: string;
    approved: boolean;
  }): Promise<{
    status: "awaiting_approval" | "completed" | "failed";
    runId: string;
    content: string;
    trace?: DirectActionTrace;
    resumeToken?: string;
  }> {
    if (!this.structuredExecutionRuns || !this.structuredExecutionService || !this.persons) {
      throw new Error("Structured execution resume is not configured.");
    }

    const run = await this.structuredExecutionRuns.findByResumeToken(input.resumeToken);
    if (!run) {
      throw new Error(`Structured execution run not found for token ${input.resumeToken}.`);
    }

    if (run.status !== "awaiting_approval") {
      throw new Error(`Structured execution run ${run.id} is not awaiting approval.`);
    }

    if (!run.personId) {
      throw new Error(`Structured execution run ${run.id} is missing a person context.`);
    }

    if (!run.currentStepId || !run.state) {
      throw new Error(`Structured execution run ${run.id} is missing pause state.`);
    }

    const person = await this.persons.findById(run.personId);
    if (!person) {
      throw new Error(`Person not found for structured execution run ${run.id}.`);
    }

    const plan = this.structuredExecutionService.resolveBySkillName({
      skillName: run.skillName,
      tools: this.toolRegistry.listConversationTools()
    });
    if (!plan || plan.runtime !== "workflow") {
      throw new Error(`Structured execution workflow not found for skill ${run.skillName}.`);
    }

    await this.structuredExecutionRuns.markRunning({
      id: run.id,
      ...(run.trace ? { trace: run.trace } : {})
    });
    this.monitorHub?.publish({
      type: "structured_execution.run",
      event: {
        id: run.id,
        ...(run.requestId ? { requestId: run.requestId } : {}),
        skillName: run.skillName,
        runtime: run.runtime,
        status: "running",
        messageText: run.messageText,
        updatedAt: new Date().toISOString()
      }
    });

    const resumeRequestId = run.requestId ?? randomUUID();

    await this.traceWriter?.write({
      timestamp: new Date().toISOString(),
      requestId: resumeRequestId,
      stage: "structured_execution.resumed",
      payload: {
        runId: run.id,
        skillName: run.skillName,
        approved: input.approved
      }
    }).catch(() => undefined);

    const resumed = await this.structuredExecutionService.execute({
      plan,
      requestId: resumeRequestId,
      person,
      messageText: run.messageText,
      toolRegistry: this.toolRegistry,
      resume: {
        currentStepId: run.currentStepId,
        state: validateWorkflowState(run.state),
        ...(run.trace ? { trace: run.trace as unknown as DirectActionTrace } : {}),
        approvalDecision: input.approved
      }
    });

    if (!resumed) {
      await this.structuredExecutionRuns.completeRun({
        id: run.id,
        status: "failed",
        ...(run.trace ? { trace: run.trace } : {}),
        result: "Workflow execution returned no result after resume."
      });

      return {
        status: "failed",
        runId: run.id,
        content: "I couldn't resume that workflow."
      };
    }

    if (resumed.status === "awaiting_approval") {
      const pausedRun = await this.structuredExecutionRuns.pauseRun({
        id: run.id,
        currentStepId: resumed.currentStepId,
        state: resumed.state as unknown as Record<string, unknown>,
        trace: resumed.trace as unknown as Record<string, unknown>,
        result: resumed.content
      });
      this.monitorHub?.publish({
        type: "structured_execution.run",
        event: {
          id: pausedRun.id,
          ...(pausedRun.requestId ? { requestId: pausedRun.requestId } : {}),
          skillName: pausedRun.skillName,
          runtime: pausedRun.runtime,
          status: pausedRun.status,
          messageText: pausedRun.messageText,
          updatedAt: pausedRun.updatedAt.toISOString(),
          ...(pausedRun.result ? { result: pausedRun.result } : {})
        }
      });

      await this.traceWriter?.write({
        timestamp: new Date().toISOString(),
        requestId: resumeRequestId,
        stage: "structured_execution.paused",
        payload: {
          runId: pausedRun.id,
          skillName: run.skillName,
          runtime: run.runtime,
          currentStepId: resumed.currentStepId,
          awaitingApproval: true
        }
      }).catch(() => undefined);

      return {
        status: "awaiting_approval",
        runId: pausedRun.id,
        content: resumed.content,
        trace: resumed.trace,
        ...(pausedRun.resumeToken ? { resumeToken: pausedRun.resumeToken } : {})
      };
    }

    await this.structuredExecutionRuns.completeRun({
      id: run.id,
      status: resumed.status === "failed" ? "failed" : "completed",
      trace: resumed.trace as unknown as Record<string, unknown>,
      result: resumed.content
    });
    this.monitorHub?.publish({
      type: "structured_execution.run",
      event: {
        id: run.id,
        ...(run.requestId ? { requestId: run.requestId } : {}),
        skillName: run.skillName,
        runtime: run.runtime,
        status: resumed.status === "failed" ? "failed" : "completed",
        messageText: run.messageText,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: resumed.content
      }
    });

    await this.traceWriter?.write({
      timestamp: new Date().toISOString(),
      requestId: resumeRequestId,
      stage: "structured_execution.completed",
      payload: {
        runId: run.id,
        skillName: run.skillName,
        runtime: run.runtime,
        status: resumed.status
      }
    }).catch(() => undefined);

    return {
      status: resumed.status,
      runId: run.id,
      content: resumed.content,
      trace: resumed.trace
    };
  }

  async executeStructuredWorkflowTarget(input: {
    requestId: string;
    person: Person;
    skillName: string;
    messageText: string;
  }): Promise<{
    status: "completed" | "failed" | "awaiting_approval";
    content: string;
    trace?: DirectActionTrace;
  }> {
    if (!this.structuredExecutionService) {
      throw new Error("Structured execution is not configured.");
    }

    const plan = this.structuredExecutionService.resolveBySkillName({
      skillName: input.skillName,
      tools: this.toolRegistry.listConversationTools()
    });

    if (!plan || plan.runtime !== "workflow") {
      throw new Error(`Workflow extension not found for skill ${input.skillName}.`);
    }

    const result = await this.structuredExecutionService.execute({
      plan,
      requestId: input.requestId,
      person: input.person,
      messageText: input.messageText,
      toolRegistry: this.toolRegistry
    });

    if (!result) {
      return {
        status: "failed",
        content: "Workflow execution returned no result."
      };
    }

    return {
      status: result.status,
      content: result.content,
      ...(result.trace ? { trace: result.trace } : {})
    };
  }
}
