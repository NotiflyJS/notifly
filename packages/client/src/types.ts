/**
 * The wire types below are a deliberate, minimal duplication of
 * `@netiflyjs/core`'s `EventMap`/`Envelope`.
 *
 * They are NOT imported from core on purpose: core pulls in `ws` and
 * `ioredis`, which have no business inside a ~2 KB browser bundle, and this
 * package ships with zero runtime dependencies. The shapes here must stay in
 * sync with core's — the `{ v, id, type, data, ts }` envelope is the "stable
 * message envelope" wire contract established in NOT-12, documented in the
 * README, and both sides rely on it. Changing it is a breaking change for
 * both packages at once.
 */

/** Envelope format version currently produced by `@netiflyjs/core`. */
export const ENVELOPE_VERSION = 1;

/**
 * Constrains an application's event-name → payload map. Share the exact same
 * type your server passes to `createNetifly<Events>()`:
 *
 * ```ts
 * type Events = { 'export.ready': { url: string } };
 * const client = createNetiflyClient<Events>({ url });
 * client.on('export.ready', (data) => data.url); // typed
 * ```
 */
export type EventMap = Record<string, unknown>;

/**
 * A message as it arrives on the wire. `v` is typed as `number` rather than
 * the literal `1`: a client in the wild may well outlive the server version
 * it talks to, so it must be able to parse (and let the app inspect) an
 * envelope version it doesn't know about.
 */
export interface Envelope<T = unknown> {
  v: number;
  id: string;
  type: string;
  data: T;
  ts: number;
}

/**
 * - `connecting` — a WebSocket handshake is in flight (first attempt or a retry).
 * - `open` — connected; messages are flowing.
 * - `reconnecting` — disconnected, waiting out a backoff delay before retrying.
 * - `closed` — not connected and not going to reconnect on its own.
 */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

/** How a `getToken()` token is presented to the server. */
export type TokenMode = 'query' | 'subprotocol';

/** The subset of a `CloseEvent` the client surfaces via `onClose()`. */
export interface CloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface NetiflyClientOptions {
  /** The Netifly WebSocket endpoint, e.g. `wss://api.example.com/netifly`. */
  url: string;
  /**
   * Resolves the auth token for each connection attempt — called again on
   * every reconnect, so a short-lived token can be refreshed rather than
   * reused until it expires. Omit it entirely for cookie-based auth.
   */
  getToken?: () => string | Promise<string>;
  /**
   * `'query'` (default) appends the token to the URL as a query parameter;
   * `'subprotocol'` sends it as a WebSocket subprotocol. Browsers cannot set
   * request headers on a WebSocket handshake, so these are the only two
   * places a bearer token can go. See the README for the trade-offs.
   */
  tokenMode?: TokenMode;
  /** Query parameter name used by `tokenMode: 'query'`. Defaults to `'token'`. */
  tokenQueryParam?: string;
  /**
   * Prefix for the subprotocol used by `tokenMode: 'subprotocol'`, so the
   * server can recognise it among any other offered protocols. Defaults to
   * `'netifly.token.'`, i.e. the client offers `netifly.token.<token>`.
   */
  tokenProtocolPrefix?: string;
  /** Base delay for the full-jitter backoff, in ms. Defaults to `500`. */
  baseDelayMs?: number;
  /** Cap on the backoff window, in ms. Defaults to `30_000`. */
  maxDelayMs?: number;
  /**
   * Max consecutive reconnect attempts before the client gives up and goes
   * `closed` (reporting an error). Defaults to `Infinity` — the right default
   * for a long-lived app that should recover from an outage of any length.
   */
  maxReconnectAttempts?: number;
}
