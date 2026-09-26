import Redis from 'ioredis';
import { monotonicFactory } from 'ulid';
import { channelName } from './redisRouter';
import { ENVELOPE_VERSION } from './types';
import type {
  CreateNetiflyPublisherOptions,
  Envelope,
  NetiflyPublisher,
  SendResult,
  UserId,
} from './types';

class NetiflyPublisherImpl implements NetiflyPublisher {
  private readonly redis: Redis;
  private readonly namespace: string | undefined;
  private readonly ulid = monotonicFactory();
  private closed = false;

  constructor(options: CreateNetiflyPublisherOptions) {
    this.namespace = options.namespace;

    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        'Netifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNetiflyPublisher() or set the REDIS_URL environment variable.'
      );
    }

    // lazyConnect: true means ioredis doesn't open the connection until the
    // first command is issued, rather than immediately at construction —
    // good for serverless cold starts, where a publisher might be
    // constructed but never actually used in a given invocation.
    this.redis = new Redis(redisUrl, { lazyConnect: true });
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error('Netifly: cannot use publisher after close()');
    }
  }

  private channelFor(userId: UserId): string {
    return channelName(userId, this.namespace);
  }

  private buildEnvelope<T>(type: string, data: T): Envelope<T> {
    return { v: ENVELOPE_VERSION, id: this.ulid(), type, data, ts: Date.now() };
  }

  async send<T>(userId: UserId, payload: T): Promise<SendResult>;
  async send<T>(userId: UserId, type: string, data: T): Promise<SendResult>;
  async send<T>(userId: UserId, ...rest: [T] | [string, T]): Promise<SendResult> {
    this.assertNotClosed();

    const envelope =
      rest.length === 2 ? this.buildEnvelope(rest[0], rest[1]) : this.buildEnvelope('message', rest[0]);

    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }

    const instances = await this.redis.publish(this.channelFor(userId), serialized);
    return { delivered: instances > 0, instances };
  }

  async isOnline(userId: UserId): Promise<boolean> {
    this.assertNotClosed();
    return (await this.numSubscribers(userId)) > 0;
  }

  async whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>> {
    this.assertNotClosed();
    if (userIds.length === 0) return {};

    const channels = userIds.map((userId) => this.channelFor(userId));
    const reply = (await this.redis.call('PUBSUB', 'NUMSUB', ...channels)) as (string | number)[];

    const online: Record<UserId, boolean> = {};
    userIds.forEach((userId, index) => {
      online[userId] = (reply[index * 2 + 1] as number) > 0;
    });
    return online;
  }

  private async numSubscribers(userId: UserId): Promise<number> {
    const [, count] = (await this.redis.call('PUBSUB', 'NUMSUB', this.channelFor(userId))) as [
      string,
      number,
    ];
    return count;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.redis.disconnect();
  }
}

export function createNetiflyPublisher(options: CreateNetiflyPublisherOptions): NetiflyPublisher {
  return new NetiflyPublisherImpl(options);
}
