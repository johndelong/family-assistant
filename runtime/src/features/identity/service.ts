import type { InboundMessage } from "../../core/channels.js";
import type { ChannelIdentity, PairingRequest, Person } from "../../core/domain.js";
import { IdentityRepository } from "./repository.js";
import { PersonRepository } from "../persons/repository.js";

export type IdentityResolution =
  | {
      status: "resolved";
      person: Person;
      identity: ChannelIdentity;
    }
  | {
      status: "unpaired";
      pairingRequest: PairingRequest;
    };

export class IdentityResolutionService {
  constructor(
    private readonly identities: IdentityRepository,
    private readonly persons: PersonRepository
  ) {}

  async resolveInboundMessage(message: InboundMessage): Promise<IdentityResolution> {
    const identity = await this.identities.findLinkedIdentity({
      channelType: message.channelType,
      externalId: message.externalUserId
    });

    if (identity) {
      const person = await this.persons.findById(identity.personId);
      if (!person) {
        throw new Error(`Linked person not found for identity ${identity.id}`);
      }

      return {
        status: "resolved",
        person,
        identity
      };
    }

    const displayLabel = extractDisplayLabel(message);
    const pairingInput: {
      channelType: InboundMessage["channelType"];
      externalId: string;
      displayLabel?: string;
      ttlMinutes: number;
    } = {
      channelType: message.channelType,
      externalId: message.externalUserId,
      ttlMinutes: 15
    };

    if (displayLabel) {
      pairingInput.displayLabel = displayLabel;
    }

    const pairingRequest = await this.identities.findOrCreateActivePairingRequest(pairingInput);

    return {
      status: "unpaired",
      pairingRequest
    };
  }
}

function extractDisplayLabel(message: InboundMessage): string | undefined {
  const username = message.metadata?.username;
  if (typeof username === "string" && username.length > 0) {
    return username;
  }

  return message.chatId;
}
