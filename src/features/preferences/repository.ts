import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { personPreferences } from "../../db/schema.js";

export interface PersonPreferenceRecord {
  personId: string;
  showProgress: boolean;
  updatedAt: Date;
}

export class PersonPreferenceRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async getPersonPreferences(personId: string): Promise<PersonPreferenceRecord> {
    const [record] = await this.db
      .select()
      .from(personPreferences)
      .where(eq(personPreferences.personId, personId))
      .limit(1);

    if (record) {
      return {
        personId: record.personId,
        showProgress: record.showProgress === "true",
        updatedAt: record.updatedAt
      };
    }

    return {
      personId,
      showProgress: false,
      updatedAt: new Date(0)
    };
  }

  async setShowProgress(personId: string, showProgress: boolean): Promise<PersonPreferenceRecord> {
    const record: PersonPreferenceRecord = {
      personId,
      showProgress,
      updatedAt: new Date()
    };

    await this.db
      .insert(personPreferences)
      .values({
        personId: record.personId,
        showProgress: String(record.showProgress),
        updatedAt: record.updatedAt
      })
      .onConflictDoUpdate({
        target: personPreferences.personId,
        set: {
          showProgress: String(record.showProgress),
          updatedAt: record.updatedAt
        }
      });

    return record;
  }
}
