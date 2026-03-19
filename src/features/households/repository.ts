import { eq, asc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { households } from "../../db/schema.js";
import type { Household } from "../../core/domain.js";

export class HouseholdRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async create(name: string): Promise<Household> {
    const household: Household = {
      id: randomUUID(),
      name,
      createdAt: new Date()
    };

    await this.db.insert(households).values(household);
    return household;
  }

  async list(): Promise<Household[]> {
    return this.db.select().from(households).orderBy(asc(households.createdAt));
  }

  async findById(id: string): Promise<Household | undefined> {
    const [household] = await this.db.select().from(households).where(eq(households.id, id)).limit(1);
    return household;
  }
}
