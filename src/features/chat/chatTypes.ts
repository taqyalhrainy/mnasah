export type ChatSettings = { readReceipts: boolean; showPresence: boolean; notifications: boolean; sounds: boolean };
export type ChatAttachment = { id: string; name: string; size: number; preview_type: string };
export type ChatMessage = { id: string; author_id: string; body: string; media_url: string; attachments: ChatAttachment[]; created: number; reply: Pick<ChatMessage, 'id' | 'body' | 'media_url' | 'attachments' | 'author_id'> | null; reactions: { emoji: string; count: number; mine: boolean }[] };
export type ChatThread = {
  id: string; created: number;
  peer: { id: string; name: string; role: string; status: 'online' | 'away' | 'offline' | 'hidden'; lastSeen: number | null };
  muted: boolean; blocked: boolean; unavailable: boolean; hidden: boolean; typing: boolean; historyAfter: number;
  peerReadAt: number | null; unread: number; lastMessage: Pick<ChatMessage, 'id' | 'body' | 'media_url' | 'attachments' | 'created' | 'author_id'> | null;
};
export type ThreadResult = { thread: ChatThread; messages: ChatMessage[]; hasMore: boolean };
