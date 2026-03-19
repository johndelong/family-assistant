import type { AcceptedRequest } from "./service.js";

export function formatAcceptedRequestForUser(outcome: AcceptedRequest): string {
  if (outcome.status === "unpaired") {
    return `${outcome.message}\nPairing code expires at ${outcome.expiresAt}.`;
  }

  return outcome.message;
}
