import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SessionStatusEvent {
  sessionId: string;
  status: string;
  timestamp: string;
}

interface QRCodeEvent {
  sessionId: string;
  qrCode: string;
  timestamp: string;
}

export interface MessageEvent {
  sessionId: string;
  message: Record<string, unknown>;
  timestamp: string;
}

interface WebSocketEvents {
  onSessionStatus?: (event: SessionStatusEvent) => void;
  onQRCode?: (event: QRCodeEvent) => void;
  onMessage?: (event: MessageEvent) => void;
}

interface WSEventEnvelope {
  type: 'event';
  payload: {
    event: string;
    sessionId: string;
    data: Record<string, unknown>;
  };
  timestamp: string;
}

// Use current origin for WebSocket (goes through nginx proxy in Docker)
// Falls back to env var or localhost for development
const SOCKET_URL = import.meta.env.VITE_WS_URL || window.location.origin;

export function useWebSocket(events: WebSocketEvents = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { onSessionStatus, onQRCode, onMessage } = events;

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    // Get API key from sessionStorage (same as api.ts)
    const apiKey = sessionStorage.getItem('openwa_api_key');

    if (!apiKey) {
      console.warn('[WebSocket] No API key found, skipping connection');
      return;
    }

    socketRef.current = io(`${SOCKET_URL}/events`, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      auth: {
        apiKey,
      },
      extraHeaders: {
        'X-API-Key': apiKey,
      },
      query: {
        apiKey,
      },
    });

    socketRef.current.on('connect', () => {
      console.log('[WebSocket] Connected');
      setIsConnected(true);
      socketRef.current?.emit('message', {
        type: 'subscribe',
        sessionId: '*',
        events: ['*'],
        requestId: crypto.randomUUID(),
      });
    });

    socketRef.current.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      setIsConnected(false);
    });

    socketRef.current.on('connect_error', error => {
      console.warn('[WebSocket] Connection error:', error.message);
    });
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [connect]);

  // Register event handlers
  useEffect(() => {
    if (!socketRef.current) return;

    const socket = socketRef.current;

    const handleServerMessage = (message: WSEventEnvelope) => {
      if (message.type !== 'event') return;

      const { event, sessionId, data } = message.payload;

      if (event === 'session.status' && onSessionStatus) {
        onSessionStatus({
          sessionId,
          status: String(data.status ?? ''),
          timestamp: message.timestamp,
        });
      }

      if (event === 'session.qr' && onQRCode) {
        onQRCode({
          sessionId,
          qrCode: String(data.qrCode ?? ''),
          timestamp: message.timestamp,
        });
      }

      if ((event === 'message.received' || event === 'message.sent') && onMessage) {
        onMessage({
          sessionId,
          message: data,
          timestamp: message.timestamp,
        });
      }
    };

    socket.on('message', handleServerMessage);

    return () => {
      socket.off('message', handleServerMessage);
    };
  }, [onSessionStatus, onQRCode, onMessage]);

  return { isConnected };
}
