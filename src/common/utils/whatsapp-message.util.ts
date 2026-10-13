export const STATUS_BROADCAST_CHAT_ID = 'status@broadcast';

export function isStatusBroadcastMessage(message: { chatId?: string; from?: string; to?: string }): boolean {
  return [message.chatId, message.from, message.to].some(value => value === STATUS_BROADCAST_CHAT_ID);
}
