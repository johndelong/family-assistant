import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import { PersonPreferenceRepository } from "../preferences/repository.js";

interface RuntimePreferenceStatusResult {
  personId: string;
  showProgress: boolean;
  updatedAt: string;
}

interface SetProgressVisibilityInput {
  enabled: boolean;
}

const emptyObjectJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} satisfies Record<string, unknown>;

const setProgressVisibilitySchema = z.object({
  enabled: z.boolean()
});

const setProgressVisibilityJsonSchema = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      description: "Whether visible progress updates should be shown for this person during longer requests"
    }
  },
  required: ["enabled"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function createRuntimePreferenceStatusTool(
  runtimePreferences: PersonPreferenceRepository
): Tool<Record<string, never>, RuntimePreferenceStatusResult> {
  return {
    id: "preference.get_runtime_preferences",
    description: "Inspect the current person's runtime preferences, including whether visible progress updates are enabled",
    inputSchema: z.object({}),
    inputJsonSchema: emptyObjectJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(_input, context): Promise<RuntimePreferenceStatusResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to inspect runtime preferences");
      }

      const record = await runtimePreferences.getPersonPreferences(context.person.id);
      return {
        personId: record.personId,
        showProgress: record.showProgress,
        updatedAt: record.updatedAt.toISOString()
      };
    }
  };
}

export function createSetProgressVisibilityTool(
  runtimePreferences: PersonPreferenceRepository
): Tool<SetProgressVisibilityInput, RuntimePreferenceStatusResult> {
  return {
    id: "preference.set_progress_visibility",
    description: "Enable or disable visible progress updates for the current person, such as channel messages that say what the assistant is working on",
    inputSchema: setProgressVisibilitySchema,
    inputJsonSchema: setProgressVisibilityJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<RuntimePreferenceStatusResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to update runtime preferences");
      }

      const record = await runtimePreferences.setShowProgress(context.person.id, input.enabled);
      return {
        personId: record.personId,
        showProgress: record.showProgress,
        updatedAt: record.updatedAt.toISOString()
      };
    }
  };
}
