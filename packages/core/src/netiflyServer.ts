import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { monotonicFactory } from 'ulid';
import { ConnectionRegistry } from './connectionRegistry';
import { RedisRouter } from './redisRouter';
import { startHeartbeat } from './heartbeat';
import { ENVELOPE_VERSION } from './types';
import type {
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  Envelope,
  NetiflyInstance,
  RejectInfo,
  SendOrOptions,
  SendResult,
  UserId,
} from './types';

const DEFAULT_PATH = '/netifly';
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PAYLOAD = 4096;
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const DEFAULT_MAX_CONNECTIONS_PER_USER = 10;
const DEFAULT_DRAIN_MS = 5000;

class NetiflyServerImpl extends EventEmitter implements NetiflyInstance {
  private readonly wss: WebSocketServer;
  private readonly registry: ConnectionRegistry<WebSocket>;
  private readonly router: RedisRouter;
  private readonly resolveUserId: CreateNetiflyOptions['resolveUserId'];
  private readonly path: string;
  private readonly allowedOrigins: AllowedOrigins | undefined;
  private readonly maxPayload: number;
  private readonly maxBufferedBytes: number;
  private readonly maxConnectionsPerUser: number;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly ulid = monotonicFactory();
  private closed = false;

  constructor(options: CreateNetiflyOptions) {
    super();
    this.resolveUserId = options.resolveUserId;
    this.path = options.path ?? DEFAULT_PATH;
    this.allowedOrigins = options.allowedOrigins;
    this.maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;

    this.registry = new ConnectionRegistry<WebSocket>({});

    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        'Netifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNetifly() or set the REDIS_URL environment variable.'
      );
    }

    this.router = new RedisRouter({
      redisUrl,
      onMessage: (userId, rawMessage) => this.deliverLocally(userId, rawMessage),
      onError: (error) => this.emitError(error),
      namespace: options.namespace,
    });

    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    this.heartbeatTimer = startHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      getClients: () => this.wss.clients,
    });

    options.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== this.path) {
      return;
    }

    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin, req)) {
      // socket.end() (rather than write() + destroy()) lets the response
      // flush before the socket closes — matches ws's own abortHandshake().
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'origin', status: 403, origin, req });
      return;
    }

    let userId: unknown;
    let authError: Error | undefined;
    try {
      userId = await this.resolveUserId(req);
    } catch (error) {
      authError = error instanceof Error ? error : new Error(String(error));
      userId = null;
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'auth', status: 401, error: authError, req });
      return;
    }

    const resolvedUserId = userId;

    // Per-instance only: ConnectionRegistry tracks connections held by this
    // process alone, so in a multi-instance deployment a single userId could
    // still hold up to maxConnectionsPerUser connections on *each* instance,
    // not maxConnectionsPerUser cluster-wide. Same caveat as disconnect()
    // above/README — this bounds abuse per process, not globally.
    if (this.registry.getConnections(resolvedUserId).size >= this.maxConnectionsPerUser) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      this.emitReject({ reason: 'maxConnectionsPerUser', status: 429, userId: resolvedUserId, req });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.registerConnection(resolvedUserId, ws);
    });
  }

  // Awaiting the Redis SUBSCRIBE before registering the connection (rather
  // than firing it in the background) minimizes the window where a send()
  // that races a brand-new connection would be dropped.
  //
  // Every connection subscribes and unsubscribes for itself exactly once,
  // regardless of how many other connections exist for the same user:
  // RedisRouter ref-counts subscriptions per userId, so overlapping
  // connections can never unsubscribe out from under one another (NOT-5).
  // ConnectionRegistry state is deliberately not consulted here — it only
  // reflects fully-registered connections, not ones still mid-subscribe.
  private async registerConnection(userId: UserId, ws: WebSocket): Promise<void> {
    // Tracks whether this connection's subscribe is "ours to unsubscribe" —
    // i.e. whether the 'close' listener below still needs to pair it with an
    // unsubscribe(), or whether the post-await code already handled it.
    let subscribed = false;

    // Attached before the subscribe await below so that a socket which
    // disconnects during that window is still observed: without these
    // listeners in place first, an early 'close' would fire on a socket we
    // haven't started tracking yet, and we'd never find out.
    ws.on('error', (error) => this.emitError(error));
    ws.on('close', () => {
      this.registry.remove(userId, ws);
      if (subscribed) {
        subscribed = false;
        this.emit('disconnect', userId);
        this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      }
    });

    try {
      await this.router.subscribe(userId);
    } catch (error) {
      this.emitError(error);
      ws.terminate();
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      // Closed while the SUBSCRIBE was in flight. The 'close' listener above
      // already ran (before `subscribed` was set, so it didn't pair an
      // unsubscribe) — do it here instead.
      this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      return;
    }

    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
  }

  private isOriginAllowed(origin: string | undefined, req: IncomingMessage): boolean {
    if (this.allowedOrigins === '*') {
      return true;
    }

    if (typeof this.allowedOrigins === 'function') {
      return this.allowedOrigins(origin);
    }

    // Non-browser clients (raw ws connections, server-to-server) don't send
    // an Origin header at all — allowed by default for every form except the
    // function predicate above, which the caller can use to require one.
    if (origin === undefined) {
      return true;
    }

    if (Array.isArray(this.allowedOrigins)) {
      return this.allowedOrigins.some((entry) => {
        if (typeof entry === 'string') {
          return entry === origin;
        }
        // Reset lastIndex first: a g/y-flagged RegExp is stateful, and
        // reusing one across calls would otherwise alternate match results.
        entry.lastIndex = 0;
        return entry.test(origin);
      });
    }

    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // Emits 'error' only when a consumer is actually listening. NetiflyServerImpl
  // is a plain EventEmitter, and Node throws synchronously when 'error' is
  // emitted with no listener attached — that would crash the host process for
  // something as routine as a transient Redis hiccup or a flaky client socket,
  // which contradicts this library's goal of surfacing errors rather than
  // taking the host down.
  private emitError(error: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitReject(info: RejectInfo): void {
    this.emit('reject', info);
  }

  private deliverLocally(userId: UserId, rawMessage: string): void {
    for (const ws of this.registry.getConnections(userId)) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      // A slow/stalled client (not reading fast enough, or at all) would
      // otherwise let ws.send() queue data in bufferedAmount forever, growing
      // server memory unbounded. Once a connection is over the threshold we
      // stop sending to it and shed it with 1013 ("Try Again Later") instead
      // — this only affects the one stalled connection, not the rest of the
      // user's connections, which still receive the message normally below.
      if (ws.bufferedAmount > this.maxBufferedBytes) {
        this.emit('dropped', { userId, reason: 'maxBufferedBytes' });
        ws.close(1013, 'Netifly: outbound buffer exceeded maxBufferedBytes');
        continue;
      }
      ws.send(rawMessage);
    }
  }

  async send<T>(userId: UserId, payload: T): Promise<SendResult>;
  async send<T>(userId: UserId, type: string, data: T): Promise<SendResult>;
  async send<T>(userId: UserId, ...rest: [T] | [string, T]): Promise<SendResult> {
    return this.sendInternal(userId, rest);
  }

  async sendOr<T>(userId: UserId, payload: T, options: SendOrOptions): Promise<SendResult>;
  async sendOr<T>(
    userId: UserId,
    type: string,
    data: T,
    options: SendOrOptions
  ): Promise<SendResult>;
  async sendOr<T>(
    userId: UserId,
    ...rest: [T, SendOrOptions] | [string, T, SendOrOptions]
  ): Promise<SendResult> {
    const options = rest[rest.length - 1] as SendOrOptions;
    const sendRest = (rest.length === 3 ? [rest[0], rest[1]] : [rest[0]]) as [T] | [string, T];

    const result = await this.sendInternal(userId, sendRest);
    if (!result.delivered) {
      await options.offline();
    }
    return result;
  }

  private async sendInternal<T>(userId: UserId, rest: [T] | [string, T]): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    const envelope =
      rest.length === 2 ? this.buildEnvelope(rest[0], rest[1]) : this.buildEnvelope('message', rest[0]);
    const instances = await this.router.publish(userId, envelope);
    return { delivered: instances > 0, instances };
  }

  private buildEnvelope<T>(type: string, data: T): Envelope<T> {
    return { v: ENVELOPE_VERSION, id: this.ulid(), type, data, ts: Date.now() };
  }

  async isOnline(userId: UserId): Promise<boolean> {
    return (await this.router.numSubscribers(userId)) > 0;
  }

  async whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>> {
    const counts = await this.router.numSubscribersMany(userIds);
    const online: Record<UserId, boolean> = {};
    for (const userId of userIds) {
      online[userId] = counts[userId] > 0;
    }
    return online;
  }

  isConnectedHere(userId: UserId): boolean {
    return this.registry.hasConnections(userId);
  }

  disconnect(userId: UserId): void {
    for (const ws of this.registry.getConnections(userId)) {
      ws.close();
    }
  }

  async close(options: CloseOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeatTimer);

    const { drainMs = DEFAULT_DRAIN_MS, force = false } = options;

    // WebSocketServer#close's callback only fires once wss.clients is empty
    // — it does not close tracked client sockets itself. With any client
    // still connected, awaiting it below would hang forever, so every
    // tracked client needs to be gone first.
    //
    // By default that's done gracefully: every currently-OPEN client is sent
    // a real close frame with code 1012 ("Service Restart") so it can tell a
    // deploy apart from an abrupt drop and reconnect accordingly, rather than
    // every connection dropping and reconnecting at the same instant. We wait
    // for each socket's own 'close' event (proving it completed its closing
    // handshake) or `drainMs`, whichever comes first, then unconditionally
    // terminate() whatever is still left in wss.clients — stragglers that
    // never acknowledged the close frame — so this can never hang. Passing
    // `force: true` skips the drain entirely and terminate()s everyone
    // immediately, matching the pre-NOT-19 behavior (useful for tests, or an
    // already-degraded process that can't afford to wait).
    if (force || this.wss.clients.size === 0) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    } else {
      const drained = Promise.all(
        Array.from(this.wss.clients)
          .filter((ws) => ws.readyState === WebSocket.OPEN)
          .map(
            (ws) =>
              new Promise<void>((resolve) => {
                ws.once('close', () => resolve());
                ws.close(1012, 'Netifly: server is restarting');
              })
          )
      );
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainMs));
      await Promise.race([drained, timeout]);

      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
    await this.router.close();
    this.registry.clear();
  }
}

export function createNetifly(options: CreateNetiflyOptions): NetiflyInstance {
  return new NetiflyServerImpl(options);
}
