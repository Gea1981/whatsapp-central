import { ConfigService } from '@nestjs/config';
import { FindOperator, Repository } from 'typeorm';
import { MessageRetentionService } from './message-retention.service';
import { Message } from './entities/message.entity';

describe('MessageRetentionService', () => {
  let repository: jest.Mocked<Pick<Repository<Message>, 'find' | 'delete'>>;

  beforeEach(() => {
    repository = {
      find: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolver => {
      resolve = resolver;
    });
    return { promise, resolve };
  }

  function createService(retentionDays: number): MessageRetentionService {
    const configService = {
      get: jest.fn().mockReturnValue(retentionDays),
    } as unknown as ConfigService;

    return new MessageRetentionService(repository as unknown as Repository<Message>, configService);
  }

  it('deletes messages older than the configured cutoff', async () => {
    repository.find.mockResolvedValueOnce([{ id: 'old-1' } as Message]);
    const service = createService(30);
    const now = new Date('2026-10-13T12:00:00.000Z');

    await service.deleteExpiredMessages(now);

    const findOptions = repository.find.mock.calls[0][0];
    const where = findOptions?.where as { createdAt: FindOperator<Date> };
    expect(where.createdAt.type).toBe('lessThan');
    expect(where.createdAt.value).toEqual(new Date('2026-09-13T12:00:00.000Z'));
    expect(repository.delete).toHaveBeenCalledWith(['old-1']);
  });

  it('does nothing when retention is disabled with zero days', async () => {
    const service = createService(0);

    const deleted = await service.deleteExpiredMessages(new Date('2026-10-13T12:00:00.000Z'));

    expect(deleted).toBe(0);
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('deletes expired messages in bounded batches', async () => {
    const firstBatch = Array.from({ length: 500 }, (_, index) => ({ id: `old-${index}` }) as Message);
    repository.find.mockResolvedValueOnce(firstBatch).mockResolvedValueOnce([{ id: 'old-500' } as Message]);
    repository.delete.mockResolvedValueOnce({ affected: 500, raw: [] }).mockResolvedValueOnce({ affected: 1, raw: [] });
    const service = createService(30);

    const deleted = await service.deleteExpiredMessages(new Date('2026-10-13T12:00:00.000Z'));

    expect(repository.find).toHaveBeenCalledTimes(2);
    expect(repository.delete).toHaveBeenCalledTimes(2);
    expect(repository.find).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 500 }));
    expect(repository.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 500 }));
    expect(deleted).toBe(501);
  });

  it('cancels the daily cleanup timer during shutdown', async () => {
    jest.useFakeTimers();
    repository.find.mockResolvedValue([]);
    const service = createService(30);

    service.onApplicationBootstrap();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(repository.find).toHaveBeenCalledTimes(1);
  });

  it('does not overlap daily cleanup executions', async () => {
    jest.useFakeTimers();
    const pendingFind = deferred<Message[]>();
    repository.find.mockReturnValueOnce(pendingFind.promise);
    const service = createService(30);

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(repository.find).toHaveBeenCalledTimes(1);

    pendingFind.resolve([]);
    await service.onModuleDestroy();
  });

  it('waits for an active cleanup before completing shutdown', async () => {
    const pendingFind = deferred<Message[]>();
    repository.find.mockReturnValueOnce(pendingFind.promise);
    const service = createService(30);
    let shutdownCompleted = false;

    service.onApplicationBootstrap();
    const shutdown = Promise.resolve(service.onModuleDestroy()).then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();

    expect(shutdownCompleted).toBe(false);

    pendingFind.resolve([]);
    await shutdown;
    expect(shutdownCompleted).toBe(true);
  });
});
