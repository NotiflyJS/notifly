import { fullJitterDelay, planReconnect } from './reconnect';
import type {
  CloseInfo,
  ConnectionState,
  Envelope,
  EventMap,
  NetiflyClientOptions,
  TokenMode,
} from './types';

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_TOKEN_QUERY_PARAM = 'token';
const DEFAULT_TOKEN_PROTOCOL_PREFIX = 'netifly.token.';

type Unsubscribe = () => void;
type MessageHandler = (data: unknown, envelope: Envelope) => void;

/**
 * Appends a query parameter by string surgery rather than via `URL`: `URL` is
 * only partially implemented in some React Native runtimes, and this keeps
 * the client working anywhere a `WebSocket` exists.
 */
function withQueryParam(url: string, key: string, value: string): string {
  const separator = url.indexOf('?') === -1 ? '?' : '&';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * A Netifly WebSocket client for browsers, React Native, and Node 22+ — no
 * dependencies, built on the standard `WebSocket` global.
 *
 * ```ts
 * const client = createNetiflyClient<Events>({
 *   url: 'wss://api.example.com/netifly',
 *   getToken: () => session.accessToken,
 * });
 * client.on('export.ready', ({ url }) => toast(`Export ready: ${url}`));
 * client.connect();
 * ```
 *
 * Two separate event channels, deliberately kept apart:
 * - `on(type, handler)` / `onAny(handler)` — application messages, typed
 *   against the shared `Events` map.
 * - `onStateChange` / `onClose` / `onError` — this client's own lifecycle,
 *   which is never confused with an application event name.
 */
export class NetiflyClient<Events extends EventMap = EventMap> {
  private readonly url: string;
  private readonly getToken: NetiflyClientOptions['getToken'];
  private readonly tokenMode: TokenMode;
  private readonly tokenQueryParam: string;
  private readonly tokenProtocolPrefix: string;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxReconnectAttempts: number;

  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly anyHandlers = new Set<(envelope: Envelope) => void>();
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>();
  private readonly closeHandlers = new Set<(info: CloseInfo) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();

  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  /**
   * Bumped on every connection attempt and on `close()`, so callbacks from a
   * socket (or an in-flight `getToken()`) the client has already moved on
   * from are ignored instead of driving state.
   */
  private generation = 0;
  /** True while the app, not the network, is the reason there's no socket. */
  private intentional = true;
  private currentState: ConnectionState = 'closed';
  private currentEventId: string | undefined;
  private negotiatedProtocol = '';

  constructor(options: NetiflyClientOptions) {
    this.url = options.url;
    this.getToken = options.getToken;
    this.tokenMode = options.tokenMode ?? 'query';
    this.tokenQueryParam = options.tokenQueryParam ?? DEFAULT_TOKEN_QUERY_PARAM;
    this.tokenProtocolPrefix = options.tokenProtocolPrefix ?? DEFAULT_TOKEN_PROTOCOL_PREFIX;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
  }

  /** Current connection state. Also observable via `onStateChange()`. */
  get state(): ConnectionState {
    return this.currentState;
  }

  /**
   * The `id` of the most recent envelope received, or `undefined` if none has
   * arrived yet. Tracked for future replay-on-reconnect support (v0.4) — the
   * client does not resume from it yet, but an app can persist it today.
   */
  get lastEventId(): string | undefined {
    return this.currentEventId;
  }

  /** The subprotocol the server selected, or `''` if none was negotiated. */
  get protocol(): string {
    return this.negotiatedProtocol;
  }

  /**
   * Opens the connection (and keeps it open, reconnecting as needed). Safe to
   * call when already connected or connecting — it's a no-op then. Registering
   * handlers before calling this avoids missing anything.
   */
  connect(): void {
    if (this.socket || this.timer) {
      return;
    }
    this.intentional = false;
    this.attempt = 0;
    void this.openSocket();
  }

  /**
   * Closes the connection for good: cancels any pending reconnect timer and
   * closes the socket. This never triggers a reconnect, whatever close code
   * results. Call `connect()` again to start over.
   */
  close(code = 1000, reason?: string): void {
    this.intentional = true;
    this.generation += 1;
    this.clearTimer();

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {
        // Already closing/closed, or an invalid code — nothing to do.
      }
    }
    this.setState('closed');
  }

  /**
   * Subscribes to one application event type, typed against `Events`.
   * Returns an unsubscribe function.
   */
  on<K extends keyof Events & string>(
    type: K,
    handler: (data: Events[K], envelope: Envelope<Events[K]>) => void
  ): Unsubscribe {
    const entry = handler as unknown as MessageHandler;
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(entry);
    return () => {
      this.handlers.get(type)?.delete(entry);
    };
  }

  /** Subscribes to every envelope received, whatever its type. */
  onAny(handler: (envelope: Envelope) => void): Unsubscribe {
    return this.subscribe(this.anyHandlers, handler);
  }

  /** Subscribes to connection state changes (a client lifecycle event). */
  onStateChange(handler: (state: ConnectionState) => void): Unsubscribe {
    return this.subscribe(this.stateHandlers, handler);
  }

  /**
   * Subscribes to the underlying socket's close events — the raw close code,
   * for apps that want to log or react to it themselves.
   */
  onClose(handler: (info: CloseInfo) => void): Unsubscribe {
    return this.subscribe(this.closeHandlers, handler);
  }

  /**
   * Subscribes to client-side errors: a rejected `getToken()`, an unparseable
   * message, a throwing handler, or giving up after `maxReconnectAttempts`.
   */
  onError(handler: (error: Error) => void): Unsubscribe {
    return this.subscribe(this.errorHandlers, handler);
  }

  private subscribe<T>(set: Set<T>, handler: T): Unsubscribe {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private async openSocket(): Promise<void> {
    const generation = ++this.generation;
    this.setState('connecting');

    let url = this.url;
    let protocols: string[] | undefined;

    if (this.getToken) {
      let token: string;
      try {
        token = await this.getToken();
      } catch (error) {
        this.emitError(toError(error));
        // Only this attempt's own failure may drive a retry: close() (or
        // another connect()) may have superseded it while we awaited.
        if (generation === this.generation) {
          this.scheduleReconnect('backoff');
        }
        return;
      }
      if (generation !== this.generation) {
        return;
      }
      if (this.tokenMode === 'subprotocol') {
        protocols = [`${this.tokenProtocolPrefix}${token}`];
      } else {
        url = withQueryParam(url, this.tokenQueryParam, token);
      }
    }

    let socket: WebSocket;
    try {
      socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    } catch (error) {
      // A malformed URL, or a runtime with no WebSocket at all.
      this.emitError(toError(error));
      this.scheduleReconnect('backoff');
      return;
    }
    this.socket = socket;

    let opened = false;
    let settled = false;

    /** Runs exactly once per socket: this connection is over, decide what next. */
    const settle = (info: CloseInfo): void => {
      if (settled) return;
      settled = true;
      this.socket = undefined;
      this.negotiatedProtocol = '';
      this.emitClose(info);

      if (this.intentional) {
        this.setState('closed');
        return;
      }

      const plan = planReconnect(opened, info.code);
      if (plan === 'none') {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect(plan);
    };

    socket.addEventListener('open', () => {
      if (generation !== this.generation) return;
      opened = true;
      this.attempt = 0;
      this.negotiatedProtocol = socket.protocol;
      this.setState('open');
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      if (generation !== this.generation) return;
      this.handleMessage(event.data);
    });

    socket.addEventListener('error', () => {
      if (generation !== this.generation) return;
      // Runtime compatibility, verified by experiment: Node 22's bundled
      // undici (6.x) fires ONLY 'error' — never 'close' — when a connection
      // fails *before* the handshake completes (connection refused, DNS
      // failure). Browsers and Node 24+ (undici 7.x) follow the spec and
      // also fire 'close' with 1006. Without settling here, a client whose
      // server is unreachable would sit in 'connecting' forever instead of
      // retrying, on this package's own minimum Node version.
      //
      // 1006 is synthesized to match what a spec-compliant runtime reports
      // for exactly this case, and nothing is lost by it: a socket that
      // never opened has no trustworthy code anyway (see planReconnect).
      //
      // A socket that HAS opened is left to its own 'close' event, which
      // every runtime fires (an abrupt mid-connection drop still produces
      // 1006 on undici 6) and which carries the real close code — that code
      // is the whole basis of the 1000/1005/1012 policy, so it must not be
      // pre-empted by an 'error' that carries no detail at all.
      if (!opened) {
        settle({ code: 1006, reason: '', wasClean: false });
      }
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (generation !== this.generation) return;
      settle({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
  }

  private scheduleReconnect(plan: 'immediate-jitter' | 'backoff'): void {
    if (this.intentional) {
      return;
    }

    let delay: number;
    if (plan === 'immediate-jitter') {
      // A 1012 restart is not a fault, so it never counts towards the ramp:
      // the attempt counter resets and the delay is drawn from the base
      // window alone. (Today that coincides with the first backoff step,
      // since a successful open also resets the counter — keeping the branch
      // explicit makes the 1012 contract independent of that.)
      this.attempt = 0;
      delay = fullJitterDelay(0, this.baseDelayMs, this.maxDelayMs);
    } else {
      if (this.attempt >= this.maxReconnectAttempts) {
        this.emitError(
          new Error(
            `Netifly: giving up after ${this.attempt} reconnect attempts (maxReconnectAttempts)`
          )
        );
        this.setState('closed');
        return;
      }
      delay = fullJitterDelay(this.attempt, this.baseDelayMs, this.maxDelayMs);
      this.attempt += 1;
    }

    this.setState('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.openSocket();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private handleMessage(raw: unknown): void {
    // Netifly only ever sends text frames (a JSON envelope).
    if (typeof raw !== 'string') {
      return;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      this.emitError(toError(error));
      return;
    }

    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return;
    }
    if (typeof envelope.id === 'string') {
      this.currentEventId = envelope.id;
    }

    const handlers = this.handlers.get(envelope.type);
    if (handlers) {
      for (const handler of [...handlers]) {
        this.safely(() => handler(envelope.data, envelope));
      }
    }
    for (const handler of [...this.anyHandlers]) {
      this.safely(() => handler(envelope));
    }
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    for (const handler of [...this.stateHandlers]) {
      this.safely(() => handler(state));
    }
  }

  private emitClose(info: CloseInfo): void {
    for (const handler of [...this.closeHandlers]) {
      this.safely(() => handler(info));
    }
  }

  /** Runs an application callback without letting it break the client. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.emitError(toError(error));
    }
  }

  private emitError(error: Error): void {
    for (const handler of [...this.errorHandlers]) {
      try {
        handler(error);
      } catch {
        // An error handler that throws is on its own — swallowing here is the
        // only way to avoid recursing back into emitError forever.
      }
    }
  }
}

/** Factory counterpart to `new NetiflyClient(...)`, mirroring `createNetifly()`. */
export function createNetiflyClient<Events extends EventMap = EventMap>(
  options: NetiflyClientOptions
): NetiflyClient<Events> {
  return new NetiflyClient<Events>(options);
}
