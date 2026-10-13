import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Message } from './entities/message.entity';

const RETENTION_BATCH_SIZE = 500;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MessageRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MessageRetentionService.name);
  private cleanupTimer?: NodeJS.Timeout;
  private activeCleanup: Promise<void> | null = null;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.startCleanup();
    this.cleanupTimer = setInterval(() => void this.startCleanup(), RETENTION_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    await this.activeCleanup;
  }

  async deleteExpiredMessages(now: Date = new Date()): Promise<number> {
    const retentionDays = this.configService.get<number>('message.retentionDays', 30);
    if (retentionDays === 0) {
      return 0;
    }

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    let deleted = 0;

    while (true) {
      const messages = await this.messageRepository.find({
        select: { id: true },
        where: { createdAt: LessThan(cutoff) },
        order: { createdAt: 'ASC' },
        take: RETENTION_BATCH_SIZE,
      });

      if (messages.length === 0) {
        break;
      }

      const ids = messages.map(message => message.id);
      const result = await this.messageRepository.delete(ids);
      const affected = result.affected ?? ids.length;
      deleted += affected;

      if (affected === 0 || messages.length < RETENTION_BATCH_SIZE) {
        break;
      }
    }

    return deleted;
  }

  private startCleanup(): Promise<void> {
    if (this.activeCleanup) {
      return this.activeCleanup;
    }

    const cleanup = this.runScheduledCleanup();
    this.activeCleanup = cleanup;
    void cleanup.finally(() => {
      if (this.activeCleanup === cleanup) {
        this.activeCleanup = null;
      }
    });
    return cleanup;
  }

  private async runScheduledCleanup(): Promise<void> {
    try {
      const deleted = await this.deleteExpiredMessages();
      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} expired messages`);
      }
    } catch (error) {
      this.logger.error('Failed to delete expired messages', error instanceof Error ? error.stack : String(error));
    }
  }
}
