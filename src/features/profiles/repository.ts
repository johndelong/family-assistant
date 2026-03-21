import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { assistantIdentity, assistantProfiles, householdProfiles, personProfiles } from "../../db/schema.js";

export interface AssistantProfileRecord {
  key: string;
  instructions: string;
  updatedAt: Date;
}

export interface AssistantIdentityRecord {
  key: string;
  name: string;
  roleDescription: string;
  introductionPolicy: "first_message_or_when_asked";
  signatureName?: string;
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

  static readonly DEFAULT_ASSISTANT_IDENTITY: AssistantIdentityRecord = {
    key: "default",
    name: "Rhys",
    roleDescription: "A warm, practical household assistant for a real family.",
    introductionPolicy: "first_message_or_when_asked",
    signatureName: "Rhys",
    updatedAt: new Date(0)
  };

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

  async getAssistantIdentity(): Promise<AssistantIdentityRecord> {
    const [record] = await this.db
      .select()
      .from(assistantIdentity)
      .where(eq(assistantIdentity.key, "default"))
      .limit(1);

    if (record) {
      return {
        key: record.key,
        name: record.name,
        roleDescription: record.roleDescription,
        introductionPolicy: record.introductionPolicy as "first_message_or_when_asked",
        ...(record.signatureName ? { signatureName: record.signatureName } : {}),
        updatedAt: record.updatedAt
      };
    }

    return ProfileRepository.DEFAULT_ASSISTANT_IDENTITY;
  }

  async setAssistantIdentity(input: {
    name: string;
    roleDescription: string;
    introductionPolicy?: "first_message_or_when_asked";
    signatureName?: string;
  }): Promise<AssistantIdentityRecord> {
    const record: AssistantIdentityRecord = {
      key: "default",
      name: input.name.trim(),
      roleDescription: input.roleDescription.trim(),
      introductionPolicy: input.introductionPolicy ?? "first_message_or_when_asked",
      ...(input.signatureName?.trim() ? { signatureName: input.signatureName.trim() } : {}),
      updatedAt: new Date()
    };

    await this.db
      .insert(assistantIdentity)
      .values({
        key: record.key,
        name: record.name,
        roleDescription: record.roleDescription,
        introductionPolicy: record.introductionPolicy,
        signatureName: record.signatureName ?? null,
        updatedAt: record.updatedAt
      })
      .onConflictDoUpdate({
        target: assistantIdentity.key,
        set: {
          name: record.name,
          roleDescription: record.roleDescription,
          introductionPolicy: record.introductionPolicy,
          signatureName: record.signatureName ?? null,
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
