import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import { ProfileRepository } from "../profiles/repository.js";

interface ProfileUpdateResult {
  scope: "assistant" | "household" | "person";
  updatedAt: string;
}

type ProfileUpdateInput = {
  instructions: string;
};

const profileUpdateSchema = z.object({
  instructions: z.string().min(1)
});

const profileUpdateJsonSchema = {
  type: "object",
  properties: {
    instructions: {
      type: "string",
      description: "A concise canonical description of the preferences or style to persist"
    }
  },
  required: ["instructions"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function createPersonProfileSetTool(profiles: ProfileRepository): Tool<ProfileUpdateInput, ProfileUpdateResult> {
  return {
    id: "profile.set_person_preferences",
    description: "Persist concise preferences for the current person after they explicitly state or confirm them",
    inputSchema: profileUpdateSchema,
    inputJsonSchema: profileUpdateJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<ProfileUpdateResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to update person preferences");
      }

      const record = await profiles.setPersonProfile(context.person.id, input.instructions.trim());
      return {
        scope: "person",
        updatedAt: record.updatedAt.toISOString()
      };
    }
  };
}

export function createHouseholdProfileSetTool(profiles: ProfileRepository): Tool<ProfileUpdateInput, ProfileUpdateResult> {
  return {
    id: "profile.set_household_preferences",
    description: "Persist household-wide preferences or norms after an admin clearly states or confirms they apply to the family",
    inputSchema: profileUpdateSchema,
    inputJsonSchema: profileUpdateJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "admin_only",
    targetScope: "household",
    async execute(input, context): Promise<ProfileUpdateResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to update household preferences");
      }

      if (context.person.role !== "admin") {
        throw new Error("Only an admin can update household preferences");
      }

      const record = await profiles.setHouseholdProfile(context.person.householdId, input.instructions.trim());
      return {
        scope: "household",
        updatedAt: record.updatedAt.toISOString()
      };
    }
  };
}

export function createAssistantProfileSetTool(profiles: ProfileRepository): Tool<ProfileUpdateInput, ProfileUpdateResult> {
  return {
    id: "profile.set_assistant_style",
    description: "Update the assistant's overall style and personality when an admin explicitly requests a change",
    inputSchema: profileUpdateSchema,
    inputJsonSchema: profileUpdateJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "admin_only",
    targetScope: "system",
    async execute(input, context): Promise<ProfileUpdateResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to update assistant style");
      }

      if (context.person.role !== "admin") {
        throw new Error("Only an admin can update assistant style");
      }

      const record = await profiles.setAssistantProfile(input.instructions.trim());
      return {
        scope: "assistant",
        updatedAt: record.updatedAt.toISOString()
      };
    }
  };
}
