<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">netifly</h1>

<p align="center"><strong>Real-time user notifications for Node, secure by default. Send to a user, not a channel.</strong></p>

Framework-agnostic, real-time per-user notifications for Node.js servers — WebSockets in, Redis pub/sub for horizontal scaling.

[![npm version](https://img.shields.io/npm/v/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)

## ✨ Features

- 🔌 **Framework-agnostic core** — attaches to any Node `http.Server`, so it works under Express, Fastify, Koa, NestJS, or raw `http`.
- ⚡ **Express adapter** (`@netiflyjs/express`) for a one-line setup.
- 📱 **Client SDK** (`@netiflyjs/client`) — ~1.7 KB gzipped, zero dependencies, standard `WebSocket` (browser, React Native, Node 22+), with reconnect-with-full-jitter-backoff and typed handlers built in.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Netifly doesn't care how you authenticate.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.
- 🧩 **Zero opinions on payload shape** — send whatever JSON-serializable data your app needs.
- ✉️ **Stable message envelope** — every message is wrapped in a small `{ v, id, type, data, ts }` envelope with a server-generated, sortable id.

## 🆚 Why Netifly vs. Socket.IO / Pusher

| | **Netifly** | Socket.IO | Pusher |
| --- | --- | --- | --- |
| Routing model | Per-user — `send(userId, payload)` reaches every connection that user has open | Per-room/channel — you manage the user↔socket mapping yourself | Per-channel — you manage the user↔channel mapping yourself |
| Infrastructure | Self-hosted, backed by your own Redis | Self-hosted, backed by your own adapter (Redis, etc.) | Third-party hosted service |
| Pricing | Free — you only pay for your own Redis | Free — you only pay for your own infra | Per-message / per-connection billing |
| Data path | Never leaves your infrastructure | Never leaves your infrastructure | Passes through a third party |

Netifly is deliberately narrow: no rooms, no presence, no broadcast — just "deliver this payload to this user, wherever they're connected." Reach for Socket.IO if you need room-based fan-out to anonymous clients; reach for Pusher if a managed service and its recurring bill are an acceptable trade for not running your own Redis.

## 📦 Installation

```bash
npm install @netiflyjs/core
# or, for Express apps:
npm install @netiflyjs/core @netiflyjs/express
# and, in your frontend (or any WebSocket client):
npm install @netiflyjs/client
```

## 🚀 Quickstart

### Plain Node `http`

```ts
import http from 'node:http';
import { createNetifly } from '@netiflyjs/core';

const server = http.createServer((req, res) => res.end('ok'));

const netifly = createNetifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // your own auth
});

server.listen(3000);

// Anywhere in your app:
netifly.send(userId, 'comment.created', { commentId: 42 });
```

### Express

```ts
import express from 'express';
import { attachNetifly } from '@netiflyjs/express';

const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  netifly.send(comment.authorId, 'comment.created', comment);
  res.status(201).json(comment);
});

server.listen(3000);
```

`attachNetifly` also mounts a middleware that exposes the same instance as `req.netifly` on every request, so route handlers defined elsewhere in your app don't need the closed-over `netifly` variable threaded through:

```ts
app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  req.netifly.send(comment.authorId, 'comment.created', comment); // same instance, via req
  res.status(201).json(comment);
});
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely, so `resolveUserId` always receives the raw Node `IncomingMessage`, not an Express `Request`.

> 🛡️ Netifly rejects cross-origin upgrades by default (see [Security](#-security) below) — if you need to accept them (e.g. a token-in-query setup, or a non-browser client that omits `Origin`), configure `allowedOrigins`.

### Recipe: email when offline

`send()` tells you at publish time whether a user was reachable over their live WebSocket connection (see [API Reference](#-api-reference) for the `delivered`/`instances` caveat). `sendOr()` is sugar for the common "fall back to email/push when the user isn't online" pattern, so you don't have to branch on `delivered` yourself:

```ts
await netifly.sendOr(userId, 'invoice.ready', data, {
  offline: () => sendEmail(userId, 'Your invoice is ready', data),
});
```

`offline` is only called — and awaited, if it returns a promise — when nobody held a live connection for `userId` anywhere in your cluster. Either way, `sendOr()` resolves with the same `SendResult` `send()` would have returned.

### Typed events

Give `createNetifly()` an `Events` map — event name → payload shape — and `send()`/`sendOr()` become type-checked against it:

```ts
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

const netifly = createNetifly<Events>({ server, resolveUserId });

netifly.send(userId, 'export.ready', { url });        // ✅ type-checks
netifly.send(userId, 'export.ready', { url: 123 });   // ❌ type error: wrong payload shape
netifly.send(userId, 'not.a.real.event', {});          // ❌ type error: unknown event name
```

`Events` is a plain, exported `EventMap` (`Record<string, unknown>`) — nothing core-specific — so the exact same type can be shared with the client side for typed handlers on the receiving end (see [Client SDK](#-client-sdk--netiflyjsclient)). `createNetiflyPublisher<Events>()` supports the identical pattern (see [Sending from workers / other languages](#-sending-from-workers--other-languages) below). Calling `createNetifly()`/`createNetiflyPublisher()` with no type argument still works exactly as before — every `type` string and `data` shape is accepted, since `Events` defaults to `Record<string, unknown>`.

For runtime enforcement (e.g. with [Zod](https://zod.dev) or [Valibot](https://valibot.dev)), pass a `validate` function:

```ts
import { z } from 'zod';

const schemas = {
  'comment.created': z.object({ commentId: z.string() }),
  'export.ready': z.object({ url: z.string().url() }),
} satisfies Record<keyof Events, z.ZodTypeAny>;

const netifly = createNetifly<Events>({
  server,
  resolveUserId,
  validate: (type, data) => {
    schemas[type].parse(data);
  },
});
```

`validate` is called with the exact `(type, data)` pair for every `send()`/`sendOr()` call, before the envelope is built or published. Throwing from `validate` aborts the send — nothing is published, and the error propagates straight out of the `send()`/`sendOr()` call (it's not caught or wrapped). Omit `validate` entirely and behavior is unchanged from before this option existed.

## 📱 Client SDK — `@netiflyjs/client`

Without a client, every adopter hand-rolls reconnect logic. `@netiflyjs/client` is the receiving end of everything above: **zero runtime dependencies**, ~1.7 KB minified + gzipped, and built on the standard `WebSocket` global — so it runs unchanged in browsers, React Native, and Node 22+ (the first Node release with `WebSocket` available unflagged, hence this package's `engines: { node: ">=22" }` — the rest of the repo still supports Node 18+).

```bash
npm install @netiflyjs/client
```

### Quickstart

```ts
import { createNetiflyClient } from '@netiflyjs/client';

// The same Events map your server passes to createNetifly<Events>()
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

const client = createNetiflyClient<Events>({
  url: 'wss://api.example.com/netifly',
  getToken: () => session.accessToken, // may be async; called on every (re)connect
});

// Application events — typed against Events
client.on('export.ready', ({ url }) => {   // ✅ url: string
  toast(`Your export is ready: ${url}`);
});

// Client lifecycle — deliberately a separate channel from app events,
// so an app event named "state" or "error" can never collide with it
client.onStateChange((state) => {
  // 'connecting' | 'open' | 'reconnecting' | 'closed'
  setBanner(state === 'open' ? null : `Reconnecting…`);
});

client.connect();

// …later, on logout/unmount:
client.close(); // cancels any pending reconnect; never reconnects on its own
```

`on()` returns an unsubscribe function, so it drops straight into a React effect:

```ts
useEffect(() => client.on('comment.created', addComment), []);
```

### Reconnecting

Reconnect delays use the AWS [Full Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) formula — `delay = random(0, min(cap, base * 2^attempt))` — so a fleet of clients coming back after an outage spreads out instead of re-stampeding the server in lockstep waves. `base` is `baseDelayMs` (default `500`) and `cap` is `maxDelayMs` (default `30_000`); the attempt counter resets on every successful connection.

What a disconnect means depends on whether the connection had ever opened:

| Situation | Client behavior |
| --- | --- |
| The handshake never completed (the very first `open` never fired) | Exponential backoff with full jitter — see the caveat below |
| Closed with `1000` (Normal Closure) or `1005` (no status) after being open | Stays `closed`. `netifly.disconnect(userId)` on the server produces `1005`, and that's an intentional server-side disconnect, not a fault |
| Closed with `1012` (Service Restart) after being open | Reconnects **immediately**, with a single jittered delay drawn from the base window only — no exponential ramp. This is what `netifly.close()` sends on a graceful deploy |
| Any other close code after being open (`1001`, `1006`, `1011`, `1013`, …) | Treated as transient: exponential backoff with full jitter |
| Your app called `client.close()` | Never reconnects, whatever close code results |

> ⚠️ **A browser cannot see why a handshake failed.** Per the WHATWG WebSocket spec, a rejected upgrade gives JavaScript no access to the HTTP response: whether Netifly answered `401 Unauthorized`, `403 Forbidden` (origin check), or `429 Too Many Requests`, the client receives the exact same bare `close` event — code `1006`, `wasClean: false` — as it would for an unreachable host or dropped Wi-Fi. Browsers withhold the status deliberately (it would leak cross-origin response details), and Node's native `WebSocket` behaves identically. There is therefore **no spec-compliant way** for this client to treat `401`/`403` as terminal while retrying `429`, and it does not pretend otherwise: every never-opened failure is retried with backoff, because giving up on what was actually a network blip would strand a legitimate user offline. If your app needs auth-aware behavior, detect the invalid session over plain HTTP (where the status code *is* visible) and call `client.close()` yourself. Set `maxReconnectAttempts` if you'd rather the client eventually give up on its own.

### Token auth

Browsers can't set request headers on a WebSocket handshake, so a bearer token has exactly two places to go. `getToken()` is called again before **every** connection attempt, so short-lived tokens are refreshed rather than reused past expiry.

**Query string (default, recommended):**

```ts
createNetiflyClient({ url: 'wss://api.example.com/netifly', getToken: () => token });
// connects to  wss://api.example.com/netifly?token=<token>
```

Server side, `resolveUserId` reads it straight off the raw request:

```ts
resolveUserId: (req) => verifyJwt(new URL(req.url, 'http://x').searchParams.get('token')),
```

Rename the parameter with `tokenQueryParam: 'access_token'`. Keep in mind that URLs are more likely to end up in access logs than headers are — prefer short-lived tokens, and see [Cookie vs. token auth](#cookie-vs-token-auth).

**Subprotocol:**

```ts
createNetiflyClient({ url, getToken: () => token, tokenMode: 'subprotocol' });
// offers Sec-WebSocket-Protocol: netifly.token.<token>
```

```ts
resolveUserId: (req) => {
  const offered = req.headers['sec-websocket-protocol'];
  const match = offered?.split(',').map((p) => p.trim()).find((p) => p.startsWith('netifly.token.'));
  return match ? verifyJwt(match.slice('netifly.token.'.length)) : null;
},
```

This mode **works today** against a `createNetifly()` server, verified by integration test. Some background, since RFC 6455 §4.1 says a strict client must fail the connection if the server doesn't select one of the offered subprotocols: `@netiflyjs/core` passes no `handleProtocols` option to `ws`, and `ws`'s default in that case is to echo back the *first* subprotocol the client offered — so the handshake completes and `client.protocol` reports `netifly.token.<token>`. (If core ever adds a `handleProtocols` callback, it must keep echoing a `netifly.token.*` protocol back, or this mode breaks.) Change the prefix with `tokenProtocolPrefix`. Note that a subprotocol must be a valid HTTP token — no commas or spaces — which JWTs and other base64url tokens satisfy.

Omit `getToken` entirely for cookie-based auth; the browser attaches cookies to the upgrade request on its own (and then the [origin allowlist](#origin-allowlist) is what protects you from CSWSH).

### Replay (`lastEventId`)

`client.lastEventId` is the `id` of the most recent [envelope](#-message-envelope) received — a sortable ULID. The client tracks it but does not yet resume from it; it's here so apps can persist it now, ahead of replay-on-reconnect support.

## 🔐 Redis Configuration

Netifly requires a Redis connection string — never hardcode credentials. Provide it either as an environment variable:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

or explicitly via the `redisUrl` option to `createNetifly()`/`attachNetifly()`, which takes priority over the env var. There is **no default/fallback connection** — if neither `redisUrl` nor `REDIS_URL` is provided, `createNetifly()`/`attachNetifly()` throws a clear error immediately rather than silently connecting to a local Redis instance.

### Sharing one Redis instance across apps or environments

Upstash and Redis Cloud free tiers typically give you a single Redis instance, which people often reuse across multiple apps or environments (e.g. staging and prod). Without a `namespace`, Netifly's per-user channel names (`netifly:user:<id>`) collide across those, and a `userId` that exists in more than one of them will receive the other's notifications. Set `namespace` to scope the channel to `netifly:<namespace>:user:<id>` instead:

```ts
createNetifly({ server, resolveUserId, namespace: 'staging' });
```

## 🛡️ Security

### Origin allowlist

WebSocket handshakes are exempt from the same-origin policy, and browsers *do* send cookies cross-origin on the upgrade request — this is what makes cross-site WebSocket hijacking (CSWSH) possible if `resolveUserId` derives identity from a cookie-based session. Netifly checks the `Origin` header **before** `resolveUserId` ever runs, so a forged cross-site request never reaches your auth code.

By default (no `allowedOrigins` option), Netifly only accepts an `Origin` that matches the request's `Host` header, and rejects everything else with `403 Forbidden`. Non-browser clients that omit `Origin` entirely (raw `ws` clients, server-to-server calls) are allowed through, since they aren't subject to CSWSH.

> ⚠️ **Breaking change:** earlier versions performed no Origin check at all. If your `Origin` legitimately differs from your `Host` — e.g. a reverse proxy or CDN in front that doesn't forward the original `Host`, or your WebSocket endpoint lives on a different subdomain than your app — upgrading will start rejecting those connections until you set `allowedOrigins` explicitly.

To customize this, pass `allowedOrigins` to `createNetifly()`/`attachNetifly()`:

```ts
// An explicit allowlist — strings match exactly, RegExp is tested against the header
allowedOrigins: ['https://app.example.com', /^https:\/\/[a-z]+\.example\.com$/]

// Or a predicate for full control (including rejecting a missing Origin)
allowedOrigins: (origin) => origin !== undefined && origin.endsWith('.example.com')

// Opt out entirely — e.g. for a token-in-query setup where CSWSH doesn't apply.
// Only do this if resolveUserId does NOT rely on cookies.
allowedOrigins: '*'
```

Rejections emit a `reject` event: `netifly.on('reject', ({ reason, status, origin }) => { ... })`.

### Cookie vs. token auth

- **Cookie-based sessions** are convenient but exposed to cross-site WebSocket hijacking — the Origin allowlist above is your defense if you use them.
- **Bearer tokens** (e.g. a short-lived JWT read from a query param or the `Sec-WebSocket-Protocol` header) sidestep cross-origin cookie replay entirely, since the browser only attaches them if your client code puts them there. This is the safer default if you control the client.

Beyond the Origin check, enforcement happens inside `resolveUserId` — Netifly never inspects cookies or tokens itself. Returning a falsy value from `resolveUserId` rejects the connection.

### Limits

Netifly ships with built-in defaults for the three most common abuse vectors — inbound frame size, outbound buffer growth, and connections per user — configurable via `createNetifly()`/`attachNetifly()` options (see [API Reference](#-api-reference)):

- **Inbound frame size** — `maxPayload` (default `4096` bytes) bounds the size of any WebSocket frame a client sends. Netifly ignores client→server messages entirely, so this exists purely to cap memory/DoS exposure from `ws`'s 100 MiB default; an oversized frame closes the connection with code `1009`.
- **Outbound buffer growth** — `maxBufferedBytes` (default `1_048_576`, 1 MB) bounds how much a `send()` is allowed to queue in a single connection's outbound buffer (`ws.bufferedAmount`) before that connection is considered stalled. A connection over the limit is skipped for that delivery, closed with code `1013`, and reported via the `dropped` event — a slow or stuck client can't grow server memory without limit, and it doesn't affect delivery to the user's other, healthy connections.
- **Connections per user** — `maxConnectionsPerUser` (default `10`) caps how many concurrent sockets one `userId` can hold **on a single instance**. Exceeding it rejects the upgrade with `429 Too Many Requests` and a `reject` event (`reason: 'maxConnectionsPerUser'`). This is enforced per-instance only — like `disconnect()` below, `ConnectionRegistry` only tracks local connections, so in a multi-instance deployment a user could still hold `maxConnectionsPerUser` connections on *each* instance, not `maxConnectionsPerUser` cluster-wide. If you need a cluster-wide cap, track a shared counter yourself (e.g. in Redis) and reject in `resolveUserId`.
- **Message rate** — Netifly has no built-in rate limiting on `send()` calls. Validate before calling it, or front the upgrade endpoint with a reverse proxy or API gateway that enforces rate limits.
- **`disconnect(userId)` is local-only** (see [API Reference](#-api-reference)) — it is not a substitute for revoking a compromised session cluster-wide; prefer short-lived tokens `resolveUserId` can reject once revoked.

## ✉️ Message Envelope

This is a **public wire contract**: every message Netifly delivers over the WebSocket — regardless of which `send()` overload produced it — is wrapped in this envelope:

```json
{
  "v": 1,
  "id": "01J6ZQK6NQK4WQ1G7F1QK1TCP0",
  "type": "comment.created",
  "data": { "commentId": 42 },
  "ts": 1727180000000
}
```

| Field | Type | Description |
| --- | --- | --- |
| `v` | `number` | Envelope format version. Currently always `1`. Lets the wire format evolve without breaking existing consumers. |
| `id` | `string` | A server-generated [ULID](https://github.com/ulid/spec) — lexicographically sortable by creation time, useful for dedupe and future replay (`lastEventId`). Guaranteed unique and strictly increasing for sends issued by the same server instance, including multiple sends within the same millisecond. Ordering is **not** guaranteed across different server instances in a cluster, since each instance generates its own ids. |
| `type` | `string` | The event name. Set explicitly via `send(userId, type, data)`, or defaults to `"message"` when using `send(userId, payload)`. |
| `data` | `T` | Your payload, whatever JSON-serializable shape it is. |
| `ts` | `number` | Server timestamp (`Date.now()`) at the moment the envelope was created, in epoch milliseconds. |

Non-Node publishers (e.g. publishing directly to a Netifly Redis channel from another language) should produce messages in this exact shape so clients can parse them consistently.

## 📤 Sending from workers / other languages

Most notifications don't originate in the process handling your HTTP/WebSocket traffic — a BullMQ worker finishes an AI generation, a cron job wraps up a batch export, a Lambda or Vercel function processes a webhook. `createNetifly()` requires an `http.Server`, which none of those have. `createNetiflyPublisher()` does not:

```ts
import { createNetiflyPublisher } from '@netiflyjs/core';

const publisher = createNetiflyPublisher({ redisUrl: process.env.REDIS_URL });

await publisher.send(userId, 'export.ready', { url });
await publisher.isOnline(userId);

await publisher.close(); // short-lived processes (e.g. serverless functions) should close when done
```

It opens only a Redis **publisher** connection — no subscriber, no WebSocket server — and connects lazily (on first use, not at construction), so building one in a handler that might return early, without ever sending anything, costs nothing. A `createNetiflyPublisher()` in one process and a `createNetifly()` server in another are fully interchangeable: they speak the exact same Redis pub/sub wire protocol, so a publisher's `send()` delivers straight to a socket the server is holding, wherever that server happens to be running. See [API Reference](#-api-reference) for the full `NetiflyPublisher` surface.

### Publishing directly, without this library

You don't need `@netiflyjs/core` at all to notify a Netifly user — any language with a Redis client can `PUBLISH` directly, as long as it matches Netifly's wire protocol:

1. **Channel name**: `netifly:user:<id>`, or `netifly:<namespace>:user:<id>` if the `createNetifly()` server(s) you're targeting were configured with a `namespace` (see [Sharing one Redis instance](#sharing-one-redis-instance-across-apps-or-environments)).
2. **Message body**: a JSON-encoded [envelope](#-message-envelope) — `{ v, id, type, data, ts }`. `v` is currently always `1`; `id` should be a unique string, ideally sortable (a ULID, or your own monotonically increasing id); `ts` is epoch milliseconds.

#### Python (`redis-py`)

```python
import json, time, uuid, redis

r = redis.Redis.from_url("redis://127.0.0.1:6379")

envelope = {
    "v": 1,
    "id": str(uuid.uuid4()),
    "type": "export.ready",
    "data": {"url": "https://example.com/export.zip"},
    "ts": int(time.time() * 1000),
}

r.publish(f"netifly:user:{user_id}", json.dumps(envelope))
```

#### Go (`go-redis`)

```go
envelope, _ := json.Marshal(map[string]any{
    "v":    1,
    "id":   uuid.NewString(),
    "type": "export.ready",
    "data": map[string]string{"url": "https://example.com/export.zip"},
    "ts":   time.Now().UnixMilli(),
})

rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
rdb.Publish(context.Background(), fmt.Sprintf("netifly:user:%s", userID), envelope)
```

## 📖 API Reference

### `createNetifly<Events>(options)` — `@netiflyjs/core`

`Events` is an optional type parameter — an `EventMap` (`Record<string, unknown>`) mapping event names to payload shapes — that type-checks the `send<K>()`/`sendOr<K>()` overload below (see [Typed events](#typed-events)). Defaults to `Record<string, unknown>`, so `createNetifly(options)` with no type argument behaves exactly as it always has.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. One of the two **must** be provided — Netifly throws at construction time if neither is set (no default/local fallback). |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/netifly`. |
| `allowedOrigins` | `(string \| RegExp)[] \| ((origin: string \| undefined) => boolean) \| '*'` | — | Controls the CSWSH origin check (see [Security](#-security)). Defaults to same-host only. |
| `maxPayload` | `number` | — | Max inbound WebSocket frame size, in bytes. Netifly ignores client→server messages, so this just bounds memory/DoS exposure from `ws`'s 100 MiB default. `ws` closes the connection with code `1009` on an oversized frame. Defaults to `4096` (4 KB). |
| `maxBufferedBytes` | `number` | — | Max bytes allowed in a connection's outbound send buffer (`ws.bufferedAmount`) before it's treated as stalled and shed (see [Limits](#limits)). Defaults to `1_048_576` (1 MB). |
| `maxConnectionsPerUser` | `number` | — | Max concurrent WebSocket connections for one `userId`, **on this instance** (see [Limits](#limits)). Defaults to `10`. |
| `namespace` | `string` | — | Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of the default `netifly:user:<id>` — use this when multiple apps/environments share one Redis instance (see [Redis Configuration](#-redis-configuration)). Defaults to unset (no namespace). |
| `validate` | `(type: K, data: Events[K]) => void` | — | Optional runtime validation hook (see [Typed events](#typed-events)) — e.g. a Zod/Valibot schema lookup. Called with the resolved `(type, data)` pair before every `send()`/`sendOr()` publishes. Throwing aborts the send and propagates out of the call. Defaults to unset (no validation). |

Returns a `NetiflyInstance<Events>`:

- `send<T>(userId, payload: T): Promise<SendResult>` — wraps `payload` as `{ v, id, type: "message", data: payload, ts }` (see [Message Envelope](#message-envelope)) and delivers it to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere. Untyped — this overload is unaffected by `Events`.
- `send<K extends keyof Events & string>(userId, type: K, data: Events[K]): Promise<SendResult>` — same delivery semantics, but wraps as `{ v, id, type, data, ts }` with the `type` you provide instead of the `"message"` default. Type-checked against `Events` when a concrete `Events` map was passed to `createNetifly<Events>()`; otherwise `K` is `string` and `data` is `unknown`, i.e. unchanged from before.
  - `SendResult` is `{ delivered: boolean; instances: number }`. `instances` is the number of server instances that held a live connection for `userId` at publish time — this comes straight from Redis's own `PUBLISH` return value (the subscriber count), so Netifly can tell you **at publish time** whether the user was reachable, something channel-based systems like Pusher/Ably can't do. `delivered` is just `instances > 0`.
  - ⚠️ **Caveat**: `delivered: true` means the message reached a server process holding a live socket for that user — it does **not** mean the user's client actually received or rendered it. Delivery acknowledgements / read-receipts are out of scope for this API and may land as a future addition.
- `sendOr<T>(userId, payload: T, options: { offline: () => void | Promise<void> }): Promise<SendResult>` / `sendOr<K extends keyof Events & string>(userId, type: K, data: Events[K], options): Promise<SendResult>` — sugar over `send()`: calls `send()` with the same arguments, and if the result is `{ delivered: false }`, calls `options.offline()` and awaits it (if it returns a promise) before resolving. Always resolves with the same `SendResult` `send()` would have. A rejection from `offline()` propagates out of `sendOr()` — it's not swallowed.
- `disconnect(userId): void` — **known limitation: this only closes connections on the local instance.** In a multi-instance deployment, a user may still be connected on other instances after calling this. It is not a cluster-wide "force logout." Workarounds: call `disconnect(userId)` on every instance (e.g. via a pub/sub broadcast of your own), or prefer short-lived auth tokens that `resolveUserId` rejects once revoked, so stale connections are cut off the next time they'd need to reconnect/re-authenticate.
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, ... }) => void)`, `on('dropped', ({ userId, reason }) => void)` — **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
  - `reject` fires when an upgrade is rejected before a connection is established. `reason: 'origin'` is the Origin/CSWSH check (`{ status: 403, origin, req }`); `reason: 'maxConnectionsPerUser'` fires when a `userId` is already at `maxConnectionsPerUser` **on this instance** (`{ status: 429, userId, req }`) — it does not mean the user is at the cap cluster-wide (see [Limits](#limits)); `reason: 'auth'` fires when `resolveUserId` rejects the connection — returns a falsy value, or throws (`{ status: 401, error, req }`, where `error` is the thrown `Error`, or `undefined` if `resolveUserId` simply returned a falsy value without throwing).
  - `dropped` fires when a `send()` delivery is skipped for one specific connection because it's stalled: `reason: 'maxBufferedBytes'` means that connection's `ws.bufferedAmount` exceeded `maxBufferedBytes`, so it was skipped and closed with code `1013` — the same `send()` still reaches the user's other, healthy connections normally.
- `close(options?: { drainMs?: number; force?: boolean }): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, and closes both Redis connections. By default, every connected client is sent a real WebSocket close frame with code `1012` ("Service Restart") and given up to `drainMs` (default `5000`) to complete its own closing handshake before any straggler still connected is force-terminated — this lets clients tell a graceful deploy apart from an abrupt network drop and stagger their reconnects instead of all reconnecting at the same instant. Pass `{ force: true }` to skip the drain and `terminate()` every connection immediately instead (the pre-1012 behavior) — useful in tests, or when the process is already too degraded to spend `drainMs` waiting. `close()` always resolves, even if clients never acknowledge the close frame.
- `isOnline(userId): Promise<boolean>` — whether `userId` has a live connection anywhere in the cluster. Derived from Redis `PUBSUB NUMSUB` on that user's channel: every online user already has a subscribed channel, so this gives cluster-wide presence with no extra state to maintain. **Accurate only within the heartbeat interval** (`30s`, see `heartbeat.ts`) — an unclean disconnect (network drop, laptop lid closed, no clean WebSocket close frame) leaves the channel subscribed until the ping/pong heartbeat notices the dead socket and terminates it, so `isOnline` can report `true` for up to roughly one heartbeat interval after a user's connection has actually died.
- `whoIsOnline(userIds): Promise<Record<string, boolean>>` — batched `isOnline`: one `PUBSUB NUMSUB` call for every `userId` in `userIds`, instead of one round-trip per user. Same heartbeat-interval accuracy caveat as `isOnline` applies. Resolves `{}` for an empty array without a Redis round-trip.
- `isConnectedHere(userId): boolean` — local-only fast path: whether `userId` has a live connection **on this instance specifically**, with no Redis round-trip. Synchronous, unlike `isOnline`/`whoIsOnline`, which check presence across the whole cluster.

### `attachNetifly(app, options)` — `@netiflyjs/express`

Same `options` as `createNetifly`, minus `server` (optional — pass your own, or let it create one from the Express app). Returns `{ server, netifly }`.

It also mounts a middleware on `app` that sets `req.netifly: NetiflyInstance` on every request `app` handles, so route handlers can call `req.netifly.send(...)` directly instead of importing/threading the returned `netifly` value.

### `createNetiflyPublisher<Events>(options)` — `@netiflyjs/core`

For processes that don't hold any WebSocket connections themselves — workers, cron jobs, serverless functions (see [Sending from workers / other languages](#-sending-from-workers--other-languages)).

Supports the same `<Events>` type parameter and `validate` option as `createNetifly` (see [Typed events](#typed-events)) — a publisher can enforce the exact same typed/validated send contract a server does, since the two are meant to be interchangeable.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. One of the two **must** be provided — throws at construction time if neither is set, same as `createNetifly`. |
| `namespace` | `string` | — | Scopes Redis channel names the same way `createNetifly`'s `namespace` does — must match the value used by the `createNetifly()` server(s) this publisher should reach. Defaults to unset (no namespace). |
| `validate` | `(type: K, data: Events[K]) => void` | — | Same runtime validation hook as `createNetifly`'s `validate` — called with the resolved `(type, data)` pair before every `send()` publishes; throwing aborts the send. Defaults to unset (no validation). |

Returns a `NetiflyPublisher<Events>` — a lighter-weight, send-only counterpart to `NetiflyInstance`, backed by a single lazily-connected Redis client (no subscriber connection, no WebSocket server):

- `send<T>(userId, payload: T): Promise<SendResult>` / `send<K extends keyof Events & string>(userId, type: K, data: Events[K]): Promise<SendResult>` — identical envelope/delivery semantics to `NetiflyInstance.send()` (see [Message Envelope](#-message-envelope) above for the shape, and `createNetifly`'s `send()` entry above for the `SendResult`/`delivered` caveat, and [Typed events](#typed-events) for the `Events`-checked overload).
- `isOnline(userId): Promise<boolean>` / `whoIsOnline(userIds): Promise<Record<string, boolean>>` — identical semantics/caveats to `NetiflyInstance`'s.
- `close(): Promise<void>` — disconnects the publisher's Redis connection. Call it before a short-lived process (e.g. a serverless invocation) exits. Calling `send()`/`isOnline()`/`whoIsOnline()` after `close()` throws `Netifly: cannot use publisher after close()`.

### `createNetiflyClient<Events>(options)` — `@netiflyjs/client`

The browser/Node client (see [Client SDK](#-client-sdk--netiflyjsclient)). `new NetiflyClient<Events>(options)` is the identical class form. `Events` is the same `EventMap` your server uses, so handlers are type-checked against the payloads the server sends.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | ✅ | The Netifly WebSocket endpoint, e.g. `wss://api.example.com/netifly`. |
| `getToken` | `() => string \| Promise<string>` | — | Resolves the auth token, called again before **every** connection attempt so short-lived tokens are refreshed. Omit for cookie-based auth. |
| `tokenMode` | `'query' \| 'subprotocol'` | — | Where the token goes (see [Token auth](#token-auth)). Defaults to `'query'`. |
| `tokenQueryParam` | `string` | — | Query parameter name used by `tokenMode: 'query'`. Defaults to `'token'`. |
| `tokenProtocolPrefix` | `string` | — | Subprotocol prefix used by `tokenMode: 'subprotocol'`. Defaults to `'netifly.token.'`. |
| `baseDelayMs` | `number` | — | Base of the full-jitter backoff. Defaults to `500`. |
| `maxDelayMs` | `number` | — | Cap on the backoff window. Defaults to `30_000`. |
| `maxReconnectAttempts` | `number` | — | Consecutive reconnect attempts before giving up (going `closed` and reporting an error). Defaults to `Infinity` — the right default for a long-lived app that should survive an outage of any length. |

Returns a `NetiflyClient<Events>`:

- `connect(): void` — opens the connection and keeps it open, reconnecting per the [table above](#reconnecting). A no-op while already open or connecting. Register handlers first so nothing is missed.
- `close(code = 1000, reason?): void` — shuts down for good: cancels any pending reconnect timer and closes the socket. **Never** triggers a reconnect. Call `connect()` again to start over.
- `on<K extends keyof Events & string>(type: K, handler: (data: Events[K], envelope: Envelope<Events[K]>) => void): () => void` — subscribes to one application event type; returns an unsubscribe function. The raw [envelope](#-message-envelope) is passed as a second argument when you need `id`/`ts`.
- `onAny(handler: (envelope: Envelope) => void): () => void` — every envelope, whatever its type.
- `onStateChange(handler: (state: ConnectionState) => void): () => void` — connection lifecycle: `'connecting'` (handshake in flight), `'open'`, `'reconnecting'` (waiting out a backoff delay), `'closed'` (down and not retrying).
- `onClose(handler: ({ code, reason, wasClean }) => void): () => void` — the raw close event, for logging or your own policy on top.
- `onError(handler: (error: Error) => void): () => void` — a rejected `getToken()`, an unparseable message, a throwing handler (which never breaks the other handlers), or giving up after `maxReconnectAttempts`.
- `state: ConnectionState` — current state, same values as `onStateChange`.
- `lastEventId: string | undefined` — `id` of the most recent envelope received, tracked for future replay support.
- `protocol: string` — the subprotocol the server selected, or `''`.

The package also exports `fullJitterDelay(attempt, base, cap)` and `planReconnect(wasOpen, code)` — the pure functions behind the behavior in the [table above](#reconnecting) — plus the `Envelope`, `EventMap`, `ConnectionState`, `CloseInfo` and `NetiflyClientOptions` types and `ENVELOPE_VERSION`. `Envelope`/`EventMap` are deliberately re-declared here rather than imported from `@netiflyjs/core` (which would pull `ws` and `ioredis` into a browser bundle); they are the same [wire contract](#-message-envelope) both sides implement.

## 🏗️ Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each instance subscribes to a user's Redis channel (`netifly:user:<id>`) only while it holds a live connection for that user, and unsubscribes the moment that user disconnects locally — so `send()` traffic only reaches the instance(s) that actually need it.

## 🧪 Testing & Development

This is a pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm test
pnpm build
pnpm --filter @netiflyjs/client run size      # bundle-size budget (after a build)
```

`@netiflyjs/client`'s own tests spin up a real `createNetifly()` server to run against, so they need the same Redis — and **Node 22+**, since they exercise the native `WebSocket` global. On Node 18/20, run `pnpm --filter '!@netiflyjs/client' run test` instead (that's exactly what CI does on its 18 and 20 legs; the build, lint and typecheck steps are type-only and run everywhere).

## 🤝 Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide each package's next version and changelog automatically on merge to `main`.

## 📄 License

[MIT](./LICENSE)
