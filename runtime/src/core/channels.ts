export type ChannelType = "websocket" | "telegram";

export interface ChannelRecipient {
  channelType: ChannelType;
  externalId: string;
}

export interface InboundMessage {
  channelType: ChannelType;
  externalUserId: string;
  chatId?: string;
  text: string;
  receivedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  text: string;
}

export interface ChannelAdapter {
  type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(recipient: ChannelRecipient, message: OutboundMessage): Promise<void>;
  normalizeInboundMessage(raw: unknown): Promise<InboundMessage>;
}

