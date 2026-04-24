import type { ChannelAdapter, ChannelRecipient, OutboundMessage } from "../core/channels.js";

export class ChannelRouter {
  readonly #adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.#adapters.set(adapter.type, adapter);
  }

  unregister(channelType: string): void {
    this.#adapters.delete(channelType);
  }

  has(channelType: string): boolean {
    return this.#adapters.has(channelType);
  }

  async sendMessage(recipient: ChannelRecipient, message: OutboundMessage): Promise<void> {
    const adapter = this.#adapters.get(recipient.channelType);
    if (!adapter) {
      throw new Error(`No channel adapter registered for ${recipient.channelType}`);
    }

    await adapter.sendMessage(recipient, message);
  }
}
