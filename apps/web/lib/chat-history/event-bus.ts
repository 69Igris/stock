/**
 * Cross-tab + same-tab event bus for chat-history list invalidation.
 *
 * Used to refresh the sidebar / chat-history page when:
 * - A new chat is created in any tab
 * - An existing chat is opened (background revalidate)
 * - A chat is archived/unarchived/deleted/renamed
 *
 * BroadcastChannel handles cross-tab; an EventTarget mirror lets the
 * originating tab listen too (BroadcastChannel skips the sender).
 */

export type ChatHistoryEvent =
  | { type: "chat-created"; chatId: string }
  | { type: "chat-opened"; chatId: string }
  | { type: "chat-mutated"; chatId?: string };

const CHANNEL_NAME = "usemoney:chat-history";

type Listener = (event: ChatHistoryEvent) => void;
const localListeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      const event = e.data as ChatHistoryEvent;
      localListeners.forEach((fn) => fn(event));
    };
  }
  return channel;
}

export function emitChatHistoryEvent(event: ChatHistoryEvent): void {
  // Same-tab subscribers
  localListeners.forEach((fn) => fn(event));
  // Cross-tab broadcast
  getChannel()?.postMessage(event);
}

export function subscribeChatHistoryEvents(listener: Listener): () => void {
  localListeners.add(listener);
  // Lazily open the channel so SSR doesn't try to instantiate it
  getChannel();
  return () => {
    localListeners.delete(listener);
  };
}
