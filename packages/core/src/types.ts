import type { IncomingMessage, Server as HttpServer } from 'node:http';

export type UserId = string;

/**
 * Constrains an application's event-name → payload map, e.g.:
 *
 * ```ts
 * type Events = { 'comment.created': { commentId: string }; 'export.ready': { url: string } };
 * const netifly = createNetifly<Events>({ ... });
 * netifly.send(userId, 'export.ready', { url }); // type-checked
 * ```
 *
 * Exported as a plain, unopinionated alias (rather than something
 * core-specific) so a future `@netiflyjs/client`/`@netiflyjs/react` package
 * can import and share the exact same `Events` type for typed handlers on
 * the receiving end, without depending on anything else from this package.
 */
export type EventMap = Record<string, unknown>;

export const ENVELOPE_VERSION = 1;

export interface Envelope<T = unknown> {
  v: typeof ENVELOPE_VERSION;
  id: string;
  type: string;
  data: T;
  ts: number;
}

export type ResolveUserId = (
  req: IncomingMessage
) => UserId | null | undefined | Promise<UserId | null | undefined>;

/**
 * Controls the CSWSH origin check on WebSocket upgrades. Omit to allow only
 * same-host origins (Origin's host must match the request's Host header).
 * An array matches strings exactly and tests RegExp entries against the
 * header; a function gets full control, including over a missing Origin
 * (every other form allows a missing Origin by default); `'*'` disables the
 * check entirely.
 */
export type AllowedOrigins =
  | (string | RegExp)[]
  | ((origin: string | undefined) => boolean)
  | '*';

export interface CreateNetiflyOptions<Events extends EventMap = EventMap> {
  server: HttpServer;
  resolveUserId: ResolveUserId;
  redisUrl?: string;
  path?: string;
  allowedOrigins?: AllowedOrigins;
  /**
   * Max inbound WebSocket frame size, in bytes. Netifly ignores client→server
   * messages entirely, so this exists purely to bound memory/DoS exposure
   * from the `ws` default of 100 MiB. `ws` enforces this itself, closing the
   * connection with code 1009 ("Message Too Big") on an oversized frame.
   * Defaults to 4096 (4 KB).
   */
  maxPayload?: number;
  /**
   * Max bytes allowed in a connection's outbound send buffer (`ws.bufferedAmount`)
   * before it's considered stalled. Checked on every `send()` delivery; a
   * connection over the limit is skipped and closed rather than left to
   * accumulate unbounded server memory. Defaults to 1_048_576 (1 MB).
   */
  maxBufferedBytes?: number;
  /**
   * Max concurrent WebSocket connections for one `userId`, enforced on this
   * instance only (see `ConnectionRegistry` — it tracks local connections
   * only, so this is not a cluster-wide cap). Defaults to 10.
   */
  maxConnectionsPerUser?: number;
  /**
   * Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of
   * the default `netifly:user:<id>`. Set this when multiple apps (or
   * environments, e.g. staging vs. prod) share one Redis instance — common
   * on Upstash/Redis Cloud free tiers — so they don't receive each other's
   * notifications. Defaults to unset (no namespace).
   */
  namespace?: string;
  /**
   * Optional runtime validation hook, called with the resolved `(type, data)`
   * pair for every `send()`/`sendOr()` call, before the envelope is built or
   * published — a place to plug in Zod, Valibot, or any other schema
   * validator. Throwing from `validate` aborts the send: nothing is
   * published, and the error propagates straight out of the `send()`/
   * `sendOr()` call (it is not caught or wrapped).
   */
  validate?: <K extends keyof Events & string>(type: K, data: Events[K]) => void;
}

/** Emitted via the `reject` event when an upgrade is rejected. */
export type RejectInfo =
  | {
      reason: 'origin';
      status: number;
      origin: string | undefined;
      req: IncomingMessage;
    }
  | {
      reason: 'maxConnectionsPerUser';
      status: number;
      userId: UserId;
      req: IncomingMessage;
    }
  | {
      reason: 'auth';
      status: 401;
      error: Error | undefined;
      req: IncomingMessage;
    };

/** Emitted via the `dropped` event when a queued delivery is skipped for a connection. */
export interface DroppedInfo {
  userId: UserId;
  reason: 'maxBufferedBytes';
}

/**
 * Result of a `send()`/`sendOr()` call. `instances` is the number of server
 * instances that held a live connection for the user at publish time (Redis
 * PUBLISH's own subscriber count), and `delivered` is just `instances > 0`.
 *
 * Caveat: this means the message reached a server process holding a live
 * socket for that user — not that the user actually saw it rendered on
 * screen. Delivery acknowledgements/read-receipts are out of scope here and
 * may be a future addition.
 */
export interface SendResult {
  delivered: boolean;
  instances: number;
}

export interface SendOrOptions {
  /** Called (and awaited, if it returns a promise) when the send was not delivered anywhere. */
  offline: () => void | Promise<void>;
}

export interface NetiflyInstance<Events extends EventMap = EventMap> {
  send<T>(userId: UserId, payload: T): Promise<SendResult>;
  send<K extends keyof Events & string>(userId: UserId, type: K, data: Events[K]): Promise<SendResult>;
  /**
   * Like `send()`, but calls (and awaits) `options.offline()` when the
   * message wasn't delivered to any connection anywhere in the cluster.
   * Resolves with the same `SendResult` either way.
   */
  sendOr<T>(userId: UserId, payload: T, options: SendOrOptions): Promise<SendResult>;
  sendOr<K extends keyof Events & string>(
    userId: UserId,
    type: K,
    data: Events[K],
    options: SendOrOptions
  ): Promise<SendResult>;
  disconnect(userId: UserId): void;
  on(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'reject', listener: (info: RejectInfo) => void): this;
  on(event: 'dropped', listener: (info: DroppedInfo) => void): this;
  once(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'reject', listener: (info: RejectInfo) => void): this;
  once(event: 'dropped', listener: (info: DroppedInfo) => void): this;
  close(): Promise<void>;
  /**
   * Whether `userId` has a live connection anywhere in the cluster, derived
   * from Redis `PUBSUB NUMSUB` on that user's channel. Accurate only within
   * the heartbeat interval: an unclean disconnect (network drop, laptop lid
   * closed) leaves the channel subscribed until the ping/pong heartbeat
   * notices and terminates the dead socket, so this can report `true` for up
   * to roughly one heartbeat interval after a connection has actually died.
   */
  isOnline(userId: UserId): Promise<boolean>;
  /**
   * Same as `isOnline`, batched: one `PUBSUB NUMSUB` call for every `userId`
   * instead of one round-trip each. Same heartbeat-interval accuracy caveat
   * applies. Resolves `{}` for an empty array without a Redis round-trip.
   */
  whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>>;
  /**
   * Local-only fast path: whether `userId` has a live connection on *this*
   * instance specifically, with no Redis round-trip. Synchronous, unlike
   * `isOnline`/`whoIsOnline`, which check presence across the whole cluster.
   */
  isConnectedHere(userId: UserId): boolean;
}

export interface CreateNetiflyPublisherOptions<Events extends EventMap = EventMap> {
  redisUrl?: string;
  /**
   * Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of
   * the default `netifly:user:<id>` — must match the `namespace` used by the
   * `createNetifly()` server(s) this publisher should reach. Defaults to
   * unset (no namespace).
   */
  namespace?: string;
  /**
   * Same runtime validation hook as `CreateNetiflyOptions.validate` — a
   * publisher can enforce the same contract a server does, since the two are
   * meant to be interchangeable (see `NetiflyPublisher`). Called with the
   * resolved `(type, data)` pair before publishing; a throw aborts the send
   * and propagates straight out of `send()`.
   */
  validate?: <K extends keyof Events & string>(type: K, data: Events[K]) => void;
}

/**
 * A send-only, presence-aware handle to Netifly's Redis pub/sub layer, for
 * processes that don't hold any WebSocket connections themselves — BullMQ
 * workers, cron jobs, Lambda/Vercel functions, and other backend services
 * that need to notify a user without running a `createNetifly()` server.
 *
 * Opens only a Redis publisher connection (no subscriber, no WebSocket
 * server), so it's cheap to construct in short-lived environments — pair
 * with `close()` when the process is about to exit (e.g. at the end of a
 * serverless invocation).
 */
export interface NetiflyPublisher<Events extends EventMap = EventMap> {
  send<T>(userId: UserId, payload: T): Promise<SendResult>;
  send<K extends keyof Events & string>(userId: UserId, type: K, data: Events[K]): Promise<SendResult>;
  /**
   * Whether `userId` has a live connection anywhere in the cluster. Same
   * semantics/accuracy caveat as `NetiflyInstance.isOnline`.
   */
  isOnline(userId: UserId): Promise<boolean>;
  /** Same as `isOnline`, batched. Same semantics as `NetiflyInstance.whoIsOnline`. */
  whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>>;
  /** Disconnects the publisher's Redis connection. */
  close(): Promise<void>;
}
