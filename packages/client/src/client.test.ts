import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNetifly } from '@netiflyjs/core';
import type { NetiflyInstance } from '@netiflyjs/core';
import { createNetiflyClient, NetiflyClient } from './client';
import type { ConnectionState, Envelope } from './types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(20000);

type Events = {
  'export.ready': { url: string };
  'comment.created': { commentId: string };
};

interface TestServer {
  netifly: NetiflyInstance<Events>;
  httpServer: http.Server;
  port: number;
}

/**
 * Resolves the user from `?token=` (query mode) or from the
 * `Sec-WebSocket-Protocol` header (subprotocol mode), so one server can serve
 * every auth-mode test. The token *is* the userId here — real apps would
 * verify a JWT instead.
 */
function resolveUserId(req: http.IncomingMessage): string | null {
  const fromQuery = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
  if (fromQuery) return fromQuery;

  const offered: string | undefined = req.headers['sec-websocket-protocol'];
  const match = offered
    ?.split(',')
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith('netifly.token.'));
  return match ? match.slice('netifly.token.'.length) : null;
}

async function startServer(port = 0): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const netifly = createNetifly<Events>({
    server: httpServer,
    resolveUserId,
    redisUrl: REDIS_URL,
    allowedOrigins: '*',
  });
  netifly.on('error', () => {
    /* keep transient errors from crashing the test process */
  });
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  return { netifly, httpServer, port: (httpServer.address() as AddressInfo).port };
}

/**
 * Stops accepting new connections *before* the 1012 drain, so a client that
 * reconnects quickly can't race back onto a server that is already tearing
 * down (the http server keeps already-upgraded sockets alive until they close,
 * which is exactly what the drain needs).
 */
async function stopServer(server: TestServer): Promise<void> {
  const closed = new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  await server.netifly.close();
  await closed;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextState(client: NetiflyClient<Events>, target: ConnectionState): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onStateChange((state) => {
      if (state === target) {
        off();
        resolve();
      }
    });
  });
}

function nextEvent<K extends keyof Events & string>(
  client: NetiflyClient<Events>,
  type: K
): Promise<{ data: Events[K]; envelope: Envelope<Events[K]> }> {
  return new Promise((resolve) => {
    const off = client.on(type, (data, envelope) => {
      off();
      resolve({ data, envelope });
    });
  });
}

describe('NetiflyClient', () => {
  const servers: TestServer[] = [];
  const clients: NetiflyClient<Events>[] = [];

  function track(server: TestServer): TestServer {
    servers.push(server);
    return server;
  }

  function makeClient(
    port: number,
    options: Partial<ConstructorParameters<typeof NetiflyClient>[0]> = {}
  ): NetiflyClient<Events> {
    const client = createNetiflyClient<Events>({
      url: `ws://127.0.0.1:${port}/netifly`,
      getToken: () => 'alice',
      baseDelayMs: 50,
      maxDelayMs: 200,
      ...options,
    });
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    for (const server of servers) {
      await stopServer(server).catch(() => undefined);
    }
    servers.length = 0;
  });

  describe('connecting and receiving', () => {
    it('reports connecting → open and exposes the state', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);

      const states: ConnectionState[] = [];
      client.onStateChange((state) => states.push(state));

      expect(client.state).toBe('closed');
      client.connect();
      await nextState(client, 'open');

      expect(states).toEqual(['connecting', 'open']);
      expect(client.state).toBe('open');
    });

    it('dispatches a typed event to its handler and tracks lastEventId', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      client.connect();
      await nextState(client, 'open');
      // The server only routes to a user it holds a live connection for.
      await wait(50);

      expect(client.lastEventId).toBeUndefined();

      const received = nextEvent(client, 'export.ready');
      await server.netifly.send('alice', 'export.ready', { url: 'https://example.com/a.zip' });
      const { data, envelope } = await received;

      expect(data).toEqual({ url: 'https://example.com/a.zip' });
      expect(envelope.type).toBe('export.ready');
      expect(envelope.v).toBe(1);
      expect(typeof envelope.ts).toBe('number');
      expect(client.lastEventId).toBe(envelope.id);
      expect(client.lastEventId).toEqual(expect.any(String));

      const second = nextEvent(client, 'export.ready');
      await server.netifly.send('alice', 'export.ready', { url: 'https://example.com/b.zip' });
      const firstId = envelope.id;
      const { envelope: secondEnvelope } = await second;
      expect(secondEnvelope.id).not.toBe(firstId);
      expect(client.lastEventId).toBe(secondEnvelope.id);
    });

    it('only dispatches to handlers for the matching event type, and onAny sees everything', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      const exports_: unknown[] = [];
      const comments: unknown[] = [];
      const all: string[] = [];
      client.on('export.ready', (data) => exports_.push(data));
      client.on('comment.created', (data) => comments.push(data));
      client.onAny((envelope) => all.push(envelope.type));

      client.connect();
      await nextState(client, 'open');
      await wait(50);

      await server.netifly.send('alice', 'comment.created', { commentId: 'c1' });
      await server.netifly.send('alice', 'export.ready', { url: 'https://example.com/a.zip' });
      await wait(150);

      expect(comments).toEqual([{ commentId: 'c1' }]);
      expect(exports_).toEqual([{ url: 'https://example.com/a.zip' }]);
      expect(all).toEqual(['comment.created', 'export.ready']);
    });

    it('stops dispatching once a handler is unsubscribed', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      const seen: unknown[] = [];
      const off = client.on('export.ready', (data) => seen.push(data));

      client.connect();
      await nextState(client, 'open');
      await wait(50);

      await server.netifly.send('alice', 'export.ready', { url: 'one' });
      await wait(150);
      off();
      await server.netifly.send('alice', 'export.ready', { url: 'two' });
      await wait(150);

      expect(seen).toEqual([{ url: 'one' }]);
    });
  });

  describe('getToken auth modes', () => {
    it('appends the token to the URL as a query parameter (query mode, the default)', async () => {
      const server = track(await startServer());
      const connected: string[] = [];
      server.netifly.on('connect', (userId) => connected.push(userId));

      const client = makeClient(server.port, { getToken: async () => 'bob' });
      client.connect();
      await nextState(client, 'open');
      await wait(50);

      expect(connected).toEqual(['bob']);

      const received = nextEvent(client, 'export.ready');
      await server.netifly.send('bob', 'export.ready', { url: 'https://example.com/bob.zip' });
      expect((await received).data).toEqual({ url: 'https://example.com/bob.zip' });
    });

    it('preserves an existing query string when appending the token', async () => {
      const server = track(await startServer());
      const connected: string[] = [];
      server.netifly.on('connect', (userId) => connected.push(userId));

      const client = makeClient(server.port, {
        url: `ws://127.0.0.1:${server.port}/netifly?foo=bar`,
        getToken: () => 'carol',
      });
      client.connect();
      await nextState(client, 'open');
      await wait(50);

      expect(connected).toEqual(['carol']);
    });

    it('honours a custom tokenQueryParam', async () => {
      const server = track(await startServer());
      const seen: string[] = [];
      const httpServer = server.httpServer;
      httpServer.on('upgrade', (req) => seen.push(req.url ?? ''));

      const client = makeClient(server.port, { tokenQueryParam: 'access_token' });
      client.connect();
      // The server's resolveUserId only reads `token`, so this connection is
      // rejected — all this asserts is how the URL was built.
      await wait(200);

      expect(seen[0]).toContain('access_token=alice');
      expect(seen[0]).not.toContain('token=alice&');
    });

    it('passes the token as a subprotocol (subprotocol mode)', async () => {
      // Verified empirically: `ws`'s WebSocketServer, with no handleProtocols
      // option, echoes back the first subprotocol the client offered — so a
      // spec-strict client (browser / Node native WebSocket) completes the
      // handshake and this mode works end-to-end against @netiflyjs/core today.
      const server = track(await startServer());
      const connected: string[] = [];
      server.netifly.on('connect', (userId) => connected.push(userId));

      const client = makeClient(server.port, {
        tokenMode: 'subprotocol',
        getToken: () => 'dave',
      });
      client.connect();
      await nextState(client, 'open');
      await wait(50);

      expect(connected).toEqual(['dave']);
      expect(client.protocol).toBe('netifly.token.dave');

      const received = nextEvent(client, 'export.ready');
      await server.netifly.send('dave', 'export.ready', { url: 'https://example.com/dave.zip' });
      expect((await received).data).toEqual({ url: 'https://example.com/dave.zip' });
    });

    it('does not put the token in the URL in subprotocol mode', async () => {
      const server = track(await startServer());
      const seen: string[] = [];
      server.httpServer.on('upgrade', (req) => seen.push(req.url ?? ''));

      const client = makeClient(server.port, { tokenMode: 'subprotocol' });
      client.connect();
      await nextState(client, 'open');

      expect(seen[0]).toBe('/netifly');
    });
  });

  describe('reconnection', () => {
    it('reconnects after a server restart and is live against the new instance', async () => {
      const first = await startServer();
      const client = makeClient(first.port, { baseDelayMs: 50, maxDelayMs: 300 });

      client.connect();
      await nextState(client, 'open');
      await wait(50);

      const reconnecting = nextState(client, 'reconnecting');
      // Graceful shutdown: sends close code 1012 ("Service Restart") per NOT-19.
      await stopServer(first);
      await reconnecting;

      const reopened = nextState(client, 'open');
      const second = track(await startServer(first.port));
      await reopened;
      await wait(100);

      expect(client.state).toBe('open');

      // The connection is genuinely live against the *new* server instance.
      const received = nextEvent(client, 'export.ready');
      const result = await second.netifly.send('alice', 'export.ready', {
        url: 'https://example.com/after-restart.zip',
      });
      expect(result.delivered).toBe(true);
      expect((await received).data).toEqual({ url: 'https://example.com/after-restart.zip' });
    });

    it('reconnects fast (within the base jitter window) after a 1012 service restart', async () => {
      const first = await startServer();
      const client = makeClient(first.port, { baseDelayMs: 400, maxDelayMs: 30_000 });

      const codes: number[] = [];
      client.onClose((event) => codes.push(event.code));

      client.connect();
      await nextState(client, 'open');
      await wait(50);

      const reconnecting = nextState(client, 'reconnecting');
      const closedAt = Date.now();
      await stopServer(first);
      await reconnecting;
      const connecting = nextState(client, 'connecting');
      const second = track(await startServer(first.port));
      await connecting;

      expect(codes).toEqual([1012]);
      // Full jitter over the *base* window only — never an exponential step.
      expect(Date.now() - closedAt).toBeLessThan(400 + 1500);
      await nextState(client, 'open');
      expect(second.netifly).toBeDefined();
    });

    it('does not reconnect after an intentional client-side close()', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      client.connect();
      await nextState(client, 'open');

      const states: ConnectionState[] = [];
      client.onStateChange((state) => states.push(state));
      client.close();

      expect(client.state).toBe('closed');
      await wait(400);
      expect(states).toEqual(['closed']);
      expect(client.state).toBe('closed');
    });

    it('does not reconnect after a server-side disconnect(userId)', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      const codes: number[] = [];
      client.onClose((event) => codes.push(event.code));

      client.connect();
      await nextState(client, 'open');
      await wait(50);

      const closed = nextState(client, 'closed');
      server.netifly.disconnect('alice');
      await closed;

      // Observed against a real server: ws.close() with no code produces a
      // clean close frame with no status, which the client reports as 1005.
      expect(codes).toEqual([1005]);
      await wait(400);
      expect(client.state).toBe('closed');
    });

    it('keeps retrying with backoff while the server is unreachable, then connects', async () => {
      const probe = await startServer();
      const port = probe.port;
      await stopServer(probe);

      const client = makeClient(port, { baseDelayMs: 25, maxDelayMs: 100 });
      const states: ConnectionState[] = [];
      client.onStateChange((state) => states.push(state));

      client.connect();
      await nextState(client, 'reconnecting');
      await wait(200);

      // A never-opened failure is indistinguishable from an auth rejection,
      // so the client keeps retrying rather than giving up.
      expect(states.filter((s) => s === 'connecting').length).toBeGreaterThan(1);

      const opened = nextState(client, 'open');
      track(await startServer(port));
      await opened;
      expect(client.state).toBe('open');
    });

    it('gives up after maxReconnectAttempts and reports an error', async () => {
      const probe = await startServer();
      const port = probe.port;
      await stopServer(probe);

      const client = makeClient(port, { baseDelayMs: 10, maxDelayMs: 20, maxReconnectAttempts: 2 });
      const errors: Error[] = [];
      client.onError((error) => errors.push(error));

      const closed = nextState(client, 'closed');
      client.connect();
      await closed;

      expect(client.state).toBe('closed');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/giving up|maxReconnectAttempts/i);
    });

    it('can be reconnected after close() by calling connect() again', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      client.connect();
      await nextState(client, 'open');
      client.close();
      expect(client.state).toBe('closed');

      client.connect();
      await nextState(client, 'open');
      expect(client.state).toBe('open');
    });
  });

  describe('error handling', () => {
    it('reports a getToken() rejection and retries', async () => {
      const server = track(await startServer());
      let calls = 0;
      const client = makeClient(server.port, {
        getToken: () => {
          calls += 1;
          if (calls === 1) throw new Error('token fetch failed');
          return 'alice';
        },
      });
      const errors: Error[] = [];
      client.onError((error) => errors.push(error));

      client.connect();
      await nextState(client, 'open');

      expect(errors.map((e) => e.message)).toContain('token fetch failed');
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    it('isolates a throwing handler from the other handlers', async () => {
      const server = track(await startServer());
      const client = makeClient(server.port);
      const errors: Error[] = [];
      const seen: unknown[] = [];
      client.onError((error) => errors.push(error));
      client.on('export.ready', () => {
        throw new Error('handler blew up');
      });
      client.on('export.ready', (data) => seen.push(data));

      client.connect();
      await nextState(client, 'open');
      await wait(50);
      await server.netifly.send('alice', 'export.ready', { url: 'https://example.com/a.zip' });
      await wait(150);

      expect(seen).toEqual([{ url: 'https://example.com/a.zip' }]);
      expect(errors.map((e) => e.message)).toContain('handler blew up');
    });
  });
});
