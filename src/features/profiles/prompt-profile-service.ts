import type { Person } from "../../core/domain.js";
import { ProfileRepository } from "./repository.js";

export interface PromptProfileContext {
  assistantStyle: string;
  householdPreferences?: string;
  personPreferences?: string;
}

export class PromptProfileService {
  constructor(private readonly profiles: ProfileRepository) {}

  async buildContextForPerson(person: Person): Promise<PromptProfileContext> {
    const [assistantProfile, householdProfile, personProfile] = await Promise.all([
      this.profiles.getAssistantProfile(),
      this.profiles.getHouseholdProfile(person.householdId),
      this.profiles.getPersonProfile(person.id)
    ]);

    return {
      assistantStyle: assistantProfile.instructions,
      ...(householdProfile ? { householdPreferences: householdProfile.instructions } : {}),
      ...(personProfile ? { personPreferences: personProfile.instructions } : {})
    };
  }
}
