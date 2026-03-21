import type { Person } from "../../core/domain.js";
import { ProfileRepository, type AssistantIdentityRecord } from "./repository.js";

export interface PromptProfileContext {
  assistantIdentity: AssistantIdentityRecord;
  assistantStyle: string;
  householdPreferences?: string;
  personPreferences?: string;
}

export class PromptProfileService {
  constructor(private readonly profiles: ProfileRepository) {}

  async buildContextForPerson(person: Person): Promise<PromptProfileContext> {
    const [assistantIdentity, assistantProfile, householdProfile, personProfile] = await Promise.all([
      this.profiles.getAssistantIdentity(),
      this.profiles.getAssistantProfile(),
      this.profiles.getHouseholdProfile(person.householdId),
      this.profiles.getPersonProfile(person.id)
    ]);

    return {
      assistantIdentity,
      assistantStyle: assistantProfile.instructions,
      ...(householdProfile ? { householdPreferences: householdProfile.instructions } : {}),
      ...(personProfile ? { personPreferences: personProfile.instructions } : {})
    };
  }
}
