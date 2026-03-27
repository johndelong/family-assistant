import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import type { Person, PersonRole } from "../../core/domain.js";
import { persons } from "../../db/schema.js";

function mapPerson(row: typeof persons.$inferSelect): Person {
  return {
    id: row.id,
    householdId: row.householdId,
    name: row.name,
    role: row.role as PersonRole,
    createdAt: row.createdAt
  };
}

export class PersonRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async create(input: { householdId: string; name: string; role: PersonRole }): Promise<Person> {
    const person: Person = {
      id: randomUUID(),
      householdId: input.householdId,
      name: input.name,
      role: input.role,
      createdAt: new Date()
    };

    await this.db.insert(persons).values(person);
    return person;
  }

  async list(householdId?: string): Promise<Person[]> {
    if (householdId) {
      const rows = await this.db.select().from(persons).where(eq(persons.householdId, householdId)).orderBy(asc(persons.createdAt));
      return rows.map(mapPerson);
    }

    const rows = await this.db.select().from(persons).orderBy(asc(persons.createdAt));
    return rows.map(mapPerson);
  }

  async findById(id: string): Promise<Person | undefined> {
    const [person] = await this.db.select().from(persons).where(eq(persons.id, id)).limit(1);
    return person ? mapPerson(person) : undefined;
  }

  async findByName(name: string): Promise<Person | undefined> {
    const [person] = await this.db.select().from(persons).where(eq(persons.name, name)).limit(1);
    return person ? mapPerson(person) : undefined;
  }
}
