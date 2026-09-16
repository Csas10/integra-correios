export interface InboundConversationMessage {
  readonly externalMessageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly receivedAt: string;
  readonly subject: string;
  readonly textBody: string;
}

export interface ConversationReceipt {
  readonly conversationId: string;
  readonly acceptedAt: string;
}

export interface ConversationGateway {
  ingest(message: InboundConversationMessage): Promise<ConversationReceipt>;
}
