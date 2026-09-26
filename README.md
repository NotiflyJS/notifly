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

## 📖 API Reference

### `createNetifly(options)` — `@netiflyjs/core`

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

Returns a `NetiflyInstance`:

- `send<T>(userId, payload: T): Promise<SendResult>` — wraps `payload` as `{ v, id, type: "message", data: payload, ts }` (see [Message Envelope](#message-envelope)) and delivers it to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `send<T>(userId, type: string, data: T): Promise<SendResult>` — same delivery semantics, but wraps as `{ v, id, type, data, ts }` with the `type` you provide instead of the `"message"` default.
  - `SendResult` is `{ delivered: boolean; instances: number }`. `instances` is the number of server instances that held a live connection for `userId` at publish time — this comes straight from Redis's own `PUBLISH` return value (the subscriber count), so Netifly can tell you **at publish time** whether the user was reachable, something channel-based systems like Pusher/Ably can't do. `delivered` is just `instances > 0`.
  - ⚠️ **Caveat**: `delivered: true` means the message reached a server process holding a live socket for that user — it does **not** mean the user's client actually received or rendered it. Delivery acknowledgements / read-receipts are out of scope for this API and may land as a future addition.
- `sendOr<T>(userId, payload: T, options: { offline: () => void | Promise<void> }): Promise<SendResult>` / `sendOr<T>(userId, type: string, data: T, options): Promise<SendResult>` — sugar over `send()`: calls `send()` with the same arguments, and if the result is `{ delivered: false }`, calls `options.offline()` and awaits it (if it returns a promise) before resolving. Always resolves with the same `SendResult` `send()` would have. A rejection from `offline()` propagates out of `sendOr()` — it's not swallowed.
- `disconnect(userId): void` — **known limitation: this only closes connections on the local instance.** In a multi-instance deployment, a user may still be connected on other instances after calling this. It is not a cluster-wide "force logout." Workarounds: call `disconnect(userId)` on every instance (e.g. via a pub/sub broadcast of your own), or prefer short-lived auth tokens that `resolveUserId` rejects once revoked, so stale connections are cut off the next time they'd need to reconnect/re-authenticate.
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, ... }) => void)`, `on('dropped', ({ userId, reason }) => void)` — **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
  - `reject` fires when an upgrade is rejected before a connection is established. `reason: 'origin'` is the Origin/CSWSH check (`{ status: 403, origin, req }`); `reason: 'maxConnectionsPerUser'` fires when a `userId` is already at `maxConnectionsPerUser` **on this instance** (`{ status: 429, userId, req }`) — it does not mean the user is at the cap cluster-wide (see [Limits](#limits)); `reason: 'auth'` fires when `resolveUserId` rejects the connection — returns a falsy value, or throws (`{ status: 401, error, req }`, where `error` is the thrown `Error`, or `undefined` if `resolveUserId` simply returned a falsy value without throwing).
  - `dropped` fires when a `send()` delivery is skipped for one specific connection because it's stalled: `reason: 'maxBufferedBytes'` means that connection's `ws.bufferedAmount` exceeded `maxBufferedBytes`, so it was skipped and closed with code `1013` — the same `send()` still reaches the user's other, healthy connections normally.
- `close(): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, and closes both Redis connections.
- `isOnline(userId): Promise<boolean>` — whether `userId` has a live connection anywhere in the cluster. Derived from Redis `PUBSUB NUMSUB` on that user's channel: every online user already has a subscribed channel, so this gives cluster-wide presence with no extra state to maintain. **Accurate only within the heartbeat interval** (`30s`, see `heartbeat.ts`) — an unclean disconnect (network drop, laptop lid closed, no clean WebSocket close frame) leaves the channel subscribed until the ping/pong heartbeat notices the dead socket and terminates it, so `isOnline` can report `true` for up to roughly one heartbeat interval after a user's connection has actually died.
- `whoIsOnline(userIds): Promise<Record<string, boolean>>` — batched `isOnline`: one `PUBSUB NUMSUB` call for every `userId` in `userIds`, instead of one round-trip per user. Same heartbeat-interval accuracy caveat as `isOnline` applies. Resolves `{}` for an empty array without a Redis round-trip.
- `isConnectedHere(userId): boolean` — local-only fast path: whether `userId` has a live connection **on this instance specifically**, with no Redis round-trip. Synchronous, unlike `isOnline`/`whoIsOnline`, which check presence across the whole cluster.

### `attachNetifly(app, options)` — `@netiflyjs/express`

Same `options` as `createNetifly`, minus `server` (optional — pass your own, or let it create one from the Express app). Returns `{ server, netifly }`.

It also mounts a middleware on `app` that sets `req.netifly: NetiflyInstance` on every request `app` handles, so route handlers can call `req.netifly.send(...)` directly instead of importing/threading the returned `netifly` value.

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
```

## 🤝 Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide each package's next version and changelog automatically on merge to `main`.

## 📄 License

[MIT](./LICENSE)
