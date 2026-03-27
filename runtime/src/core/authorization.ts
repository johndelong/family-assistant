import type { CorePermission, Person } from "./domain.js";

export type CapabilityName = string;

const memberDefaults: readonly CorePermission[] = ["config.self", "approval.respond"];
const limitedDefaults: readonly CorePermission[] = ["config.self"];

export function hasCorePermission(person: Person, permission: CorePermission): boolean {
  if (person.role === "admin") {
    return true;
  }

  if (person.role === "member") {
    return memberDefaults.includes(permission);
  }

  return limitedDefaults.includes(permission);
}
