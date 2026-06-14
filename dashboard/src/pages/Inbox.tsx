import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Loader2, MessageCircle, RefreshCw, Send, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useWebSocket, type MessageEvent } from '../hooks/useWebSocket';
import { messageApi, type StoredMessage } from '../services/api';
import './Inbox.css';

interface ChatSummary {
  chatId: string;
  lastMessage: StoredMessage;
  messages: StoredMessage[];
  incomingCount: number;
}

const MAX_MESSAGES = 200;

function getMessageTime(message: StoredMessage): number {
  const rawTimestamp = Number(message.timestamp);
  if (Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
  }

  return new Date(message.createdAt).getTime();
}

function formatChatName(chatId: string): string {
  return chatId
    .replace('@c.us', '')
    .replace('@lid', '')
    .replace('@g.us', ' · group');
}

function formatMessageTime(message: StoredMessage): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(getMessageTime(message)));
}

function getMessagePreview(message: StoredMessage): string {
  if (message.body?.trim()) return message.body;
  return `[${message.type || 'message'}]`;
}

export function Inbox() {
  const { t } = useTranslation();
  useDocumentTitle(t('inbox.title'));
  const { canWrite } = useRole();
  const { error: showError } = useToast();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const readySessions = useMemo(() => sessions.filter(session => session.status === 'ready'), [sessions]);

  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedChatId, setSelectedChatId] = useState('');
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const preferredSession = readySessions[0] ?? sessions[0];
    if (!selectedSessionId && preferredSession) {
      setSelectedSessionId(preferredSession.id);
    }
  }, [readySessions, selectedSessionId, sessions]);

  const fetchMessages = useCallback(async () => {
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }

    setLoadingMessages(true);
    try {
      const history = await messageApi.list(selectedSessionId, { limit: MAX_MESSAGES });
      setMessages(history.messages);
    } catch (error) {
      showError(t('inbox.toasts.loadFailed'), error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedSessionId, showError, t]);

  useEffect(() => {
    void fetchMessages();
  }, [fetchMessages]);

  const { isConnected } = useWebSocket({
    onMessage: useCallback(
      (event: MessageEvent) => {
        if (event.sessionId === selectedSessionId) {
          void fetchMessages();
        }
      },
      [fetchMessages, selectedSessionId],
    ),
  });

  const chats = useMemo<ChatSummary[]>(() => {
    const grouped = new Map<string, ChatSummary>();

    messages.forEach(message => {
      const current = grouped.get(message.chatId);
      if (!current) {
        grouped.set(message.chatId, {
          chatId: message.chatId,
          lastMessage: message,
          messages: [message],
          incomingCount: message.direction === 'incoming' ? 1 : 0,
        });
        return;
      }

      current.messages.push(message);
      if (getMessageTime(message) > getMessageTime(current.lastMessage)) {
        current.lastMessage = message;
      }
      if (message.direction === 'incoming') {
        current.incomingCount += 1;
      }
    });

    return Array.from(grouped.values()).sort((left, right) => (
      getMessageTime(right.lastMessage) - getMessageTime(left.lastMessage)
    ));
  }, [messages]);

  useEffect(() => {
    if (!selectedChatId && chats[0]) {
      setSelectedChatId(chats[0].chatId);
      return;
    }

    if (selectedChatId && !chats.some(chat => chat.chatId === selectedChatId)) {
      setSelectedChatId(chats[0]?.chatId ?? '');
    }
  }, [chats, selectedChatId]);

  const selectedChat = chats.find(chat => chat.chatId === selectedChatId);
  const threadMessages = useMemo(
    () => [...(selectedChat?.messages ?? [])].sort((left, right) => getMessageTime(left) - getMessageTime(right)),
    [selectedChat],
  );

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const canSend = canWrite && !!selectedSessionId && !!selectedChatId && !!replyText.trim() && !sending;

  const sendReply = async () => {
    if (!canSend) return;

    setSending(true);
    try {
      await messageApi.sendText(selectedSessionId, selectedChatId, replyText.trim());
      setReplyText('');
      await fetchMessages();
    } catch (error) {
      showError(t('inbox.toasts.sendFailed'), error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setSending(false);
    }
  };

  const handleReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendReply();
    }
  };

  if (loadingSessions) {
    return (
      <div className="inbox-page inbox-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="inbox-page">
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />

      <section className="inbox-toolbar">
        <div className="form-group inbox-session-picker">
          <label>{t('inbox.session')}</label>
          <select value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)}>
            {sessions.length === 0 && <option value="">{t('inbox.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name} · {t(`sessionStatus.${session.status}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="inbox-source-card">
          <Wifi size={18} />
          <div>
            <strong>{isConnected ? t('inbox.realtimeConnected') : t('inbox.realtimeDisconnected')}</strong>
            <span>{t('inbox.sourceHint')}</span>
          </div>
        </div>

        <button className="inbox-refresh-btn" type="button" onClick={() => void fetchMessages()} disabled={!selectedSessionId}>
          {loadingMessages ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
          {t('common.refresh')}
        </button>
      </section>

      <section className="inbox-layout">
        <aside className="chat-list-panel">
          <div className="chat-list-header">
            <h2>{t('inbox.chats')}</h2>
            <span>{t('inbox.chatCount', { count: chats.length })}</span>
          </div>

          {loadingMessages ? (
            <div className="inbox-empty-state">
              <Loader2 className="animate-spin" size={24} />
              <p>{t('inbox.loadingMessages')}</p>
            </div>
          ) : chats.length === 0 ? (
            <div className="inbox-empty-state">
              <MessageCircle size={32} />
              <p>{t('inbox.noMessages')}</p>
              <span>{t('inbox.noMessagesHint')}</span>
            </div>
          ) : (
            <div className="chat-list">
              {chats.map(chat => (
                <button
                  key={chat.chatId}
                  type="button"
                  className={`chat-list-item ${chat.chatId === selectedChatId ? 'active' : ''}`}
                  onClick={() => setSelectedChatId(chat.chatId)}
                >
                  <div className="chat-avatar">{formatChatName(chat.chatId).charAt(0).toUpperCase()}</div>
                  <div className="chat-list-content">
                    <div className="chat-list-title-row">
                      <strong>{formatChatName(chat.chatId)}</strong>
                      <span>{formatMessageTime(chat.lastMessage)}</span>
                    </div>
                    <p>{getMessagePreview(chat.lastMessage)}</p>
                  </div>
                  {chat.incomingCount > 0 && <span className="chat-badge">{chat.incomingCount}</span>}
                </button>
              ))}
            </div>
          )}
        </aside>

        <article className="chat-thread-panel">
          {selectedChat ? (
            <>
              <header className="chat-thread-header">
                <div>
                  <h2>{formatChatName(selectedChat.chatId)}</h2>
                  <span>{selectedSession?.name ?? t('inbox.session')}</span>
                </div>
                <code>{selectedChat.chatId}</code>
              </header>

              <div className="chat-thread">
                {threadMessages.map(message => (
                  <div key={message.id} className={`message-row ${message.direction}`}>
                    <div className="message-bubble">
                      <p>{getMessagePreview(message)}</p>
                      <span>
                        {formatMessageTime(message)} · {t(`inbox.directions.${message.direction}`)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <footer className="reply-bar">
                <textarea
                  value={replyText}
                  onChange={event => setReplyText(event.target.value)}
                  onKeyDown={handleReplyKeyDown}
                  placeholder={canWrite ? t('inbox.replyPlaceholder') : t('inbox.viewOnly')}
                  disabled={!canWrite || sending}
                  rows={2}
                />
                <button type="button" onClick={() => void sendReply()} disabled={!canSend}>
                  {sending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                  {t('inbox.send')}
                </button>
              </footer>
            </>
          ) : (
            <div className="chat-thread-empty">
              <MessageCircle size={42} />
              <h2>{t('inbox.selectChatTitle')}</h2>
              <p>{t('inbox.selectChatHint')}</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
