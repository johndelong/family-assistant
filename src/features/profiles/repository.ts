import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { assistantProfiles, householdProfiles, personProfiles } from "../../db/schema.js";

export interface AssistantProfileRecord {
  key: string;
  instructions: string;
  updatedAt: Date;
}

export interface HouseholdProfileRecord {
  householdId: string;
  instructions: string;
  updatedAt: Date;
}

export interface PersonProfileRecord {
  personId: string;
  instructions: string;
  updatedAt: Date;
}

export class ProfileRepository {
  static readonly DEFAULT_ASSISTANT_PROFILE = [
    "You are a warm, practical household assistant for a real family.",
    "Be kind, clear, and emotionally intelligent without sounding artificial.",
    "Adjust tone to the person you are speaking with while staying grounded and trustworthy.",
    "Prefer concise, useful responses over long speeches.",
    "When giving reminders or guidance, sound supportive rather than bossy.",
    "For children, keep language age-appropriate, encouraging, and safe."
  ].join(" ");

  constructor(private readonly db: NodePgDatabase) {}

  async getAssistantProfile(): Promise<AssistantProfileRecord> {
    const [record] = await this.db.select().from(assistantProfiles).where(eq(assistantProfiles.key, "default")).limit(1);

    if (record) {
      return record;
    }

    return {
      key: "default",
      instructions: ProfileRepository.DEFAULT_ASSISTANT_PROFILE,
      updatedAt: new Date(0)
    };
  }

  async setAssistantProfile(instructions: string): Promise<AssistantProfileRecord> {
    const record: AssistantProfileRecord = {
      key: "default",
      instructions,
      updatedAt: new Date()
    };

    await this.db
      .insert(assistantProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: assistantProfiles.key,
        set: {
          instructions: record.instructions,
          updatedAt: record.updatedAt
        }
      });

    return record;
  }

  async getHouseholdProfile(householdId: string): Promise<HouseholdProfileRecord | undefined> {
    const [record] = await this.db
      .select()
      .from(householdProfiles)
      .where(eq(householdProfiles.householdId, householdId))
      .limit(1);

    return record;
  }

  async setHouseholdProfile(householdId: string, instructions: string): Promise<HouseholdProfileRecord> {
    const record: HouseholdProfileRecord = {
      householdId,
      instructions,
      updatedAt: new Date()
    };

    await this.db
      .insert(householdProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: householdProfiles.householdId,
        set: {
          instructions: record.instructions,
          updatedAt: record.updatedAt
        }
      });

    return record;
  }

  async getPersonProfile(personId: string): Promise<PersonProfileRecord | undefined> {
    const [record] = await this.db
      .select()
      .from(personProfiles)
      .where(eq(personProfiles.personId, personId))
      .limit(1);

    return record;
  }

  async setPersonProfile(personId: string, instructions: string): Promise<PersonProfileRecord> {
    const record: PersonProfileRecord = {
      personId,
      instructions,
      updatedAt: new Date()
    };

    await this.db
      .insert(personProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: personProfiles.personId,
        set: {
          instructions: record.instructions,
          updatedAt: record.updatedAt
        }
      });

    return record;
  }
}
