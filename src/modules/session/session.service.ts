import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource, MoreThanOrEqual } from 'typeorm';
import { rm } from 'fs/promises';
import * as path from 'path';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { IWhatsAppEngine, EngineStatus, IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
      SessionStatus.FAILED,
    ];
    const autoStartStatuses = [...activeStatuses, SessionStatus.DISCONNECTED];
    const sessionsToStart = await this.sessionRepository.find({
      where: { status: In(autoStartStatuses) },
    });

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }

    if (sessionsToStart.length > 0) {
      this.logger.log(`Scheduling ${sessionsToStart.length} session(s) to auto-start after backend startup`, {
        action: 'startup_autostart_scheduled',
        affected: sessionsToStart.length,
      });

      setTimeout(() => {
        void this.autoStartSessions(sessionsToStart);
      }, 3000);
    }
  }

  private async autoStartSessions(sessions: Session[]): Promise<void> {
    for (const session of sessions) {
      if (session.config?.autoStart === false) {
        this.logger.log(`Skipping auto-start for session: ${session.name}`, {
          sessionId: session.id,
          action: 'startup_autostart_skipped',
        });
        continue;
      }

      if (this.engines.has(session.id)) {
        continue;
      }

      try {
        await this.start(session.id);
        this.logger.log(`Auto-started session after backend startup: ${session.name}`, {
          sessionId: session.id,
          action: 'startup_autostart',
        });
      } catch (error) {
        this.logger.warn('Failed to auto-start session after backend startup', {
          sessionId: session.id,
          sessionName: session.name,
          error: error instanceof Error ? error.message : String(error),
          action: 'startup_autostart_failed',
        });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Clean up all engines on shutdown
    for (const [sessionId, engine] of this.engines) {
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      await engine.destroy();
    }
    this.engines.clear();

    // Clear all reconnect timers
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Stop engine if running
    const engine = this.engines.get(id);
    if (engine) {
      await engine.destroy();
      this.engines.delete(id);
    }

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });
    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    const existingEngine = this.engines.get(id);
    if (existingEngine) {
      const existingStatus = existingEngine.getStatus();
      if ([EngineStatus.FAILED, EngineStatus.DISCONNECTED].includes(existingStatus)) {
        try {
          await existingEngine.destroy();
        } catch (error) {
          this.logger.warn('Failed to destroy stale engine before restart', {
            sessionId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.engines.delete(id);
      } else {
        throw new BadRequestException('Session is already started');
      }
    }

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = session.config as {
      maxReconnectAttempts?: number;
      reconnectBaseDelay?: number;
    } | null;
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      maxAttempts: config?.maxReconnectAttempts ?? 5,
      baseDelay: config?.reconnectBaseDelay ?? 5000,
    });

    await this.initializeEngine(id, session);
    return this.findOne(id);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);

    try {
      await engine.initialize({
        onQRCode: (): void => {
          this.logger.log('QR code generated', {
            sessionId: id,
            action: 'qr_generated',
          });

          // Execute hook for QR event
          void this.hookManager.execute(
            'session:qr',
            { sessionId: id },
            {
              sessionId: id,
              source: 'Engine',
            },
          );

          this.eventsGateway.emitQRCode(id, engine.getQRCode() ?? '');
          this.eventsGateway.emitSessionStatus(id, SessionStatus.QR_READY);
          void this.updateStatus(id, SessionStatus.QR_READY);
        },
        onReady: (phone: string, pushName: string): void => {
          this.logger.log(`Session ready: ${phone}`, {
            sessionId: id,
            phone,
            pushName,
            action: 'ready',
          });

          // Execute hook for ready event
          void this.hookManager.execute(
            'session:ready',
            { phone, pushName },
            {
              sessionId: id,
              source: 'Engine',
            },
          );

          // Reset reconnect attempts on successful connection
          const reconnectState = this.reconnectStates.get(id);
          if (reconnectState) {
            reconnectState.attempts = 0;
          }

          void this.sessionRepository.update(id, {
            status: SessionStatus.READY,
            phone,
            pushName,
            connectedAt: new Date(),
            lastActiveAt: new Date(),
          });
          this.eventsGateway.emitSessionStatus(id, SessionStatus.READY, { phone, pushName });
        },
        onMessage: (message): void => {
          void this.handleEngineMessage(id, message);
        },
        onDisconnected: (reason: string): void => {
          void this.handleEngineDisconnected(id, session, reason);
        },
        onStateChanged: (engineState: EngineStatus): void => {
          const statusMap: Record<EngineStatus, SessionStatus> = {
            [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
            [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
            [EngineStatus.QR_READY]: SessionStatus.QR_READY,
            [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
            [EngineStatus.READY]: SessionStatus.READY,
            [EngineStatus.FAILED]: SessionStatus.FAILED,
          };
          const newStatus = statusMap[engineState];
          if (newStatus) {
            void this.updateStatus(id, newStatus);
          }
        },
      });
    } catch (error) {
      try {
        await engine.destroy();
      } catch (destroyError) {
        this.logger.warn('Failed to destroy engine after initialization error', {
          sessionId: id,
          error: destroyError instanceof Error ? destroyError.message : String(destroyError),
        });
      }
      this.engines.delete(id);
      this.cancelReconnect(id);
      await this.updateStatus(id, SessionStatus.FAILED);
      throw error;
    }

    await this.updateStatus(id, SessionStatus.INITIALIZING);
  }

  private async handleEngineDisconnected(id: string, session: Session, reason: string): Promise<void> {
    this.logger.warn(`Session disconnected: ${reason}`, {
      sessionId: id,
      reason,
      action: 'disconnected',
    });

    await this.hookManager.execute(
      'session:disconnected',
      { reason },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    this.eventsGateway.emitSessionStatus(id, SessionStatus.DISCONNECTED, { reason });

    if (reason.toUpperCase() === 'LOGOUT') {
      const engine = this.engines.get(id);
      if (engine) {
        try {
          await engine.destroy();
        } catch (error) {
          this.logger.warn('Failed to destroy logged-out engine', {
            sessionId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.engines.delete(id);
      }

      await this.clearLocalAuthData(session);
    }

    if (reason.toUpperCase() === 'LOGOUT') {
      // LOGOUT means the phone explicitly invalidated the auth data.
      // Recreate the engine immediately so the UI/front can receive a fresh QR.
      await this.start(id);
      return;
    }

    // Attempt to reconnect for transient disconnects.
    this.scheduleReconnect(id, session);
  }

  private async clearLocalAuthData(session: Session): Promise<void> {
    const sessionDataPath = process.env.SESSION_DATA_PATH || './data/sessions';
    const authPath = path.resolve(sessionDataPath, `session-${session.name}`);

    try {
      await rm(authPath, { recursive: true, force: true });
      this.logger.log('Cleared local auth data after logout', {
        sessionId: session.id,
        sessionName: session.name,
        action: 'auth_data_cleared',
      });
    } catch (error) {
      this.logger.warn('Failed to clear local auth data after logout', {
        sessionId: session.id,
        sessionName: session.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleEngineMessage(id: string, message: IncomingMessage): Promise<void> {
    const direction = message.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
    const status = message.fromMe ? MessageStatus.SENT : MessageStatus.DELIVERED;
    const eventName = message.fromMe ? 'message.sent' : 'message.received';
    const hookName = message.fromMe ? 'message:sent' : 'message:received';
    const emitMessage = message.fromMe
      ? this.eventsGateway.emitMessageSent.bind(this.eventsGateway)
      : this.eventsGateway.emitMessage.bind(this.eventsGateway);

    this.logger.debug(`${message.fromMe ? 'Outgoing' : 'Incoming'} message observed from engine`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      to: message.to,
      chatId: message.chatId,
      action: message.fromMe ? 'message_sent_observed' : 'message_received',
    });

    const messageRepository = this.dataSource.getRepository(Message);

    const existing = await messageRepository.findOne({
      where: { sessionId: id, waMessageId: message.id },
    });

    if (existing) {
      return;
    }

    await this.sessionRepository.update(id, { lastActiveAt: new Date() });

    const savedMessage = await messageRepository.save({
      sessionId: id,
      waMessageId: message.id,
      chatId: message.chatId,
      from: message.from,
      to: message.to,
      body: message.body,
      type: message.type,
      direction,
      timestamp: message.timestamp,
      status,
      metadata: {
        fromMe: message.fromMe,
        isGroup: message.isGroup,
        media: message.media,
        quotedMessage: message.quotedMessage,
      },
    });

    const messageData = {
      ...message,
      id: savedMessage.id,
      waMessageId: message.id,
      direction,
      status,
    };

    const { continue: shouldContinue, data: finalMessage } = await this.hookManager.execute(hookName, messageData, {
      sessionId: id,
      source: 'Engine',
    });

    if (!shouldContinue) {
      return;
    }

    await this.webhookService.dispatch(id, eventName, this.sanitizeWebhookMessagePayload(finalMessage));
    emitMessage(id, finalMessage);
  }

  private sanitizeWebhookMessagePayload(message: Record<string, unknown>): Record<string, unknown> {
    return this.stripMediaData(message);
  }

  private stripMediaData(value: unknown): Record<string, unknown> {
    if (!this.isRecord(value)) {
      return {};
    }

    const sanitized: Record<string, unknown> = { ...value };

    if (this.isRecord(value.media)) {
      sanitized.media = this.stripMediaDataFromMedia(value.media);
    }

    if (this.isRecord(value.metadata)) {
      const metadata: Record<string, unknown> = { ...value.metadata };
      if (this.isRecord(value.metadata.media)) {
        metadata.media = this.stripMediaDataFromMedia(value.metadata.media);
      }
      sanitized.metadata = metadata;
    }

    return sanitized;
  }

  private stripMediaDataFromMedia(media: Record<string, unknown>): Record<string, unknown> {
    const { data, ...mediaWithoutData } = media;

    if (typeof data !== 'string') {
      return mediaWithoutData;
    }

    return {
      ...mediaWithoutData,
      data: undefined,
      dataOmitted: true,
      dataSize: data.length,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private scheduleReconnect(id: string, session: Session): void {
    const state = this.reconnectStates.get(id);
    if (!state) return;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const delay = state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000;
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await oldEngine.destroy();
        this.engines.delete(id);
      }

      // Re-initialize
      await this.initializeEngine(id, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    const engine = this.engines.get(id);

    if (engine) {
      await engine.disconnect();
      this.engines.delete(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    let engine = this.engines.get(id);

    if (!engine) {
      if ([SessionStatus.DISCONNECTED, SessionStatus.FAILED].includes(session.status)) {
        await this.startForQRCode(id, session);
        engine = this.engines.get(id);
      }

      if (!engine) {
        throw new BadRequestException('Session is not started and could not be initialized.');
      }
    }

    const qrCode = await this.waitForQRCode(engine, session);

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: (await this.findOne(id)).status,
    };
  }

  private async waitForQRCode(engine: IWhatsAppEngine, session: Session): Promise<string | null> {
    const attempts = 20;
    const delayMs = 500;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const qrCode = engine.getQRCode();
      if (qrCode) {
        return qrCode;
      }

      if (engine.getStatus() === EngineStatus.READY || session.status === SessionStatus.READY) {
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return engine.getQRCode();
  }

  private async startForQRCode(id: string, session: Session): Promise<void> {
    try {
      await this.start(id);
    } catch (error) {
      this.logger.warn('Failed to auto-start session for QR; clearing auth data and retrying once', {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.clearLocalAuthData(session);
      await this.start(id);
    }
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    messagesToday: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const messagesToday = await this.dataSource.getRepository(Message).count({
      where: { createdAt: MoreThanOrEqual(startOfToday) },
    });

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      messagesToday,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
