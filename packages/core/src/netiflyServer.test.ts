import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import WebSocket from 'ws';
import { createNetifly } from './netiflyServer';
import { ConnectionRegistry } from './connectionRegistry';
import { RedisRouter, channelName } from './redisRouter';
import type { CreateNetiflyOptions, DroppedInfo, NetiflyInstance, RejectInfo } from './types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

async function numSubscribers(channel: string): Promise<number> {
  const client = new Redis(REDIS_URL);
  try {
    const [, count] = (await client.call('PUBSUB', 'NUMSUB', channel)) as [string, number];
    return count;
  } finally {
    client.disconnect();
  }
}

interface TestServer {
  netifly: NetiflyInstance;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  resolveUserId: (req: http.IncomingMessage) => unknown,
  extra: Partial<CreateNetiflyOptions> = {}
): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const netifly = createNetifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
    ...extra,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    netifly,
    port,
    close: async () => {
      await netifly.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function connectClient(port: number, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly`, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// For upgrades rejected via a written HTTP response (e.g. the origin check),
// `ws` surfaces the rejection as 'unexpected-response' with the real status
// code, not as a generic 'error' — this resolves with that status so a test
// can assert on it, distinct from `connectClient`'s plain rejects.toBeDefined().
function connectExpectingRejection(
  port: number,
  options?: WebSocket.ClientOptions
): Promise<{ statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly`, options);
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('expected the upgrade to be rejected, but it opened'));
    });
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve({ statusCode: res.statusCode });
    });
    ws.once('error', () => resolve({ statusCode: undefined }));
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// createNetifly's returned instance emits 'connect' exactly when
// registry.add runs — right after the SUBSCRIBE await completes — so
// awaiting this event is a deterministic replacement for a fixed sleep when
// a test needs to know the initial Redis SUBSCRIBE has been acknowledged.
function onceEvent(emitter: NetiflyInstance, event: 'connect'): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

describe('createNetifly', () => {
  const servers: TestServer[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(
      clients.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once('close', () => resolve());
            ws.close();
          })
      )
    );
    clients.length = 0;
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it('rejects the upgrade when resolveUserId returns null', async () => {
    const server = await startTestServer(() => null);
    servers.push(server);

    await expect(connectClient(server.port)).rejects.toBeDefined();

    const rejectPromise = new Promise<RejectInfo>((resolve) =>
      server.netifly.once('reject', (info) => resolve(info))
    );
    const { statusCode } = await connectExpectingRejection(server.port);
    expect(statusCode).toBe(401);
    const info = await rejectPromise;
    expect(info).toMatchObject({ reason: 'auth', status: 401, error: undefined });
  });

  it('rejects the upgrade when resolveUserId returns a non-string value', async () => {
    const server = await startTestServer(() => 12345);
    servers.push(server);

    await expect(connectClient(server.port)).rejects.toBeDefined();

    const rejectPromise = new Promise<RejectInfo>((resolve) =>
      server.netifly.once('reject', (info) => resolve(info))
    );
    const { statusCode } = await connectExpectingRejection(server.port);
    expect(statusCode).toBe(401);
    const info = await rejectPromise;
    expect(info).toMatchObject({ reason: 'auth', status: 401, error: undefined });
  });

  it("emits a 'reject' event with the thrown error when resolveUserId throws (NOT-17)", async () => {
    const thrown = new Error('netiflyServer-auth-thrown');
    const server = await startTestServer(() => {
      throw thrown;
    });
    servers.push(server);

    const rejectPromise = new Promise<RejectInfo>((resolve) =>
      server.netifly.once('reject', (info) => resolve(info))
    );

    const { statusCode } = await connectExpectingRejection(server.port);

    expect(statusCode).toBe(401);
    const info = await rejectPromise;
    expect(info).toMatchObject({ reason: 'auth', status: 401 });
    expect((info as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(((info as { error?: Error }).error as Error).message).toBe('netiflyServer-auth-thrown');
    expect((info as { error?: Error }).error).toBe(thrown);
  });

  it('rejects a cross-origin upgrade with HTTP 403 by default (NOT-6)', async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-foreign');
    servers.push(server);

    const { statusCode } = await connectExpectingRejection(server.port, {
      origin: 'https://evil.example.com',
    });

    expect(statusCode).toBe(403);
  });

  it('accepts an upgrade whose Origin host matches the request Host by default (NOT-6)', async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-same-host');
    servers.push(server);

    const client = await connectClient(server.port, {
      origin: `http://127.0.0.1:${server.port}`,
    });
    clients.push(client);

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('accepts an origin listed in allowedOrigins and rejects one that is not (NOT-6)', async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-allowlist', {
      allowedOrigins: ['https://app.example.com'],
    });
    servers.push(server);

    const allowedClient = await connectClient(server.port, { origin: 'https://app.example.com' });
    clients.push(allowedClient);
    expect(allowedClient.readyState).toBe(WebSocket.OPEN);

    const { statusCode } = await connectExpectingRejection(server.port, {
      origin: 'https://not-listed.example.com',
    });
    expect(statusCode).toBe(403);
  });

  it('accepts an origin matching a RegExp entry in allowedOrigins (NOT-6)', async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-regexp', {
      allowedOrigins: [/^https:\/\/[a-z]+\.example\.com$/],
    });
    servers.push(server);

    const client = await connectClient(server.port, { origin: 'https://tenant.example.com' });
    clients.push(client);

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('matches a global-flagged RegExp entry consistently across repeated connections (NOT-6)', async () => {
    // A `g`/`y`-flagged RegExp is stateful: repeated .test() calls advance
    // lastIndex and alternate true/false on the same input unless reset.
    const server = await startTestServer(() => 'netiflyServer-origin-regexp-global', {
      allowedOrigins: [/^https:\/\/tenant\.example\.com$/g],
    });
    servers.push(server);

    for (let i = 0; i < 3; i++) {
      const client = await connectClient(server.port, { origin: 'https://tenant.example.com' });
      clients.push(client);
      expect(client.readyState).toBe(WebSocket.OPEN);
    }
  });

  it('delegates the decision to an allowedOrigins function predicate, including for missing Origin (NOT-6)', async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-predicate', {
      allowedOrigins: (origin) => origin === 'https://trusted.example.com',
    });
    servers.push(server);

    const allowed = await connectClient(server.port, { origin: 'https://trusted.example.com' });
    clients.push(allowed);
    expect(allowed.readyState).toBe(WebSocket.OPEN);

    const { statusCode: rejectedStatus } = await connectExpectingRejection(server.port, {
      origin: 'https://untrusted.example.com',
    });
    expect(rejectedStatus).toBe(403);

    // No Origin header at all — the predicate still runs and rejects it,
    // unlike the array/default forms which always allow a missing Origin.
    const { statusCode: noOriginStatus } = await connectExpectingRejection(server.port);
    expect(noOriginStatus).toBe(403);
  });

  it("allowedOrigins: '*' accepts any origin, including foreign ones (NOT-6)", async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-wildcard', {
      allowedOrigins: '*',
    });
    servers.push(server);

    const client = await connectClient(server.port, { origin: 'https://anything.example.com' });
    clients.push(client);

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("emits a 'reject' event with reason 'origin' when the origin check fails (NOT-6)", async () => {
    const server = await startTestServer(() => 'netiflyServer-origin-reject-event');
    servers.push(server);

    const rejectPromise = new Promise<RejectInfo>((resolve) =>
      server.netifly.on('reject', (info) => resolve(info))
    );

    await connectExpectingRejection(server.port, { origin: 'https://evil.example.com' });

    const info = await rejectPromise;
    expect(info).toMatchObject({ reason: 'origin', status: 403, origin: 'https://evil.example.com' });
  });

  it('delivers a send() to a connection on the same instance', async () => {
    const server = await startTestServer(() => 'netiflyServer-alice');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-alice', { type: 'greeting', text: 'hi' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ type: 'greeting', text: 'hi' });
  });

  it('wraps a two-arg send() payload in an envelope with type "message"', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-message');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-envelope-message', { text: 'hi' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({
      v: 1,
      type: 'message',
      data: { text: 'hi' },
    });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.ts).toBe('number');
  });

  it('wraps a three-arg send() type/data in an envelope with the given type', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-typed');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-envelope-typed', 'comment.created', { commentId: 42 });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({
      v: 1,
      type: 'comment.created',
      data: { commentId: 42 },
    });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.ts).toBe('number');
  });

  it('generates unique, strictly increasing envelope ids for sequential sends', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-ids');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const COUNT = 50;
    const messages: string[] = [];
    const allReceived = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        messages.push(data.toString());
        if (messages.length === COUNT) resolve();
      });
    });

    for (let i = 0; i < COUNT; i++) {
      await server.netifly.send('netiflyServer-envelope-ids', { i });
    }
    await allReceived;

    const ids: string[] = messages.map((m) => JSON.parse(m).id as string);
    expect(new Set(ids).size).toBe(COUNT);
    expect(ids).toEqual([...ids].sort());
  });

  it('delivers a send() across two server instances via Redis', async () => {
    const serverA = await startTestServer(() => 'netiflyServer-bob');
    const serverB = await startTestServer(() => 'netiflyServer-bob');
    servers.push(serverA, serverB);

    const connectedPromise = onceEvent(serverB.netifly, 'connect');
    const client = await connectClient(serverB.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await serverA.netifly.send('netiflyServer-bob', { type: 'cross-instance' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ type: 'cross-instance' });
  });

  it('delivers a send() to every connection a user has open', async () => {
    const server = await startTestServer(() => 'netiflyServer-frank');
    servers.push(server);

    const firstConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientA = await connectClient(server.port);
    clients.push(clientA);
    await firstConnectedPromise;

    const secondConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientB = await connectClient(server.port);
    clients.push(clientB);
    await secondConnectedPromise;

    const messageA = nextMessage(clientA);
    const messageB = nextMessage(clientB);
    await server.netifly.send('netiflyServer-frank', { type: 'multi-tab' });

    expect(JSON.parse(await messageA).data).toEqual({ type: 'multi-tab' });
    expect(JSON.parse(await messageB).data).toEqual({ type: 'multi-tab' });
  });

  it('is a no-op when sending to a user with no connections anywhere', async () => {
    const server = await startTestServer(() => 'netiflyServer-carol');
    servers.push(server);

    await expect(
      server.netifly.send('netiflyServer-nobody-online', { type: 'x' })
    ).resolves.toEqual({ delivered: false, instances: 0 });
  });

  // NOT-13: PUBLISH's own return value is the number of subscribed
  // receivers, which for Netifly is the number of server instances holding
  // a live connection for that user — this is what lets send() tell the
  // caller, at publish time, whether the user was reachable. Asserting
  // `instances` is exactly 1 here (not just >= 1) is deliberate and
  // deterministic: RedisRouter ref-counts subscriptions per userId, so one
  // instance only ever issues a single SUBSCRIBE for a user regardless of
  // how many local WebSocket connections that user has open (see NOT-5) —
  // "instances" counts subscribed server processes, not sockets.
  it('resolves send() with { delivered: true, instances: 1 } when the user has a live connection (NOT-13)', async () => {
    const server = await startTestServer(() => 'netiflyServer-delivered-online');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    const result = await server.netifly.send('netiflyServer-delivered-online', { type: 'x' });
    await messagePromise;

    expect(result).toEqual({ delivered: true, instances: 1 });
  });

  it('sendOr() does not invoke offline() and returns the same SendResult as send() when the user is online (NOT-13)', async () => {
    const server = await startTestServer(() => 'netiflyServer-sendor-online');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const offline = jest.fn();
    const messagePromise = nextMessage(client);
    const result = await server.netifly.sendOr(
      'netiflyServer-sendor-online',
      { type: 'x' },
      { offline }
    );
    await messagePromise;

    expect(result).toEqual({ delivered: true, instances: 1 });
    expect(offline).not.toHaveBeenCalled();
  });

  it('sendOr() calls and awaits offline() before resolving when the user has no connections anywhere (NOT-13)', async () => {
    const server = await startTestServer(() => 'netiflyServer-sendor-offline');
    servers.push(server);

    let offlineCompleted = false;
    const offline = jest.fn(async () => {
      await wait(20);
      offlineCompleted = true;
    });

    const result = await server.netifly.sendOr(
      'netiflyServer-nobody-online-sendor',
      { type: 'x' },
      { offline }
    );

    expect(result).toEqual({ delivered: false, instances: 0 });
    expect(offline).toHaveBeenCalledTimes(1);
    // Proves sendOr() actually awaited offline()'s returned promise before
    // resolving, not merely that it was invoked.
    expect(offlineCompleted).toBe(true);
  });

  it("disconnect() closes all of a user's local connections", async () => {
    const server = await startTestServer(() => 'netiflyServer-dave');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.netifly.disconnect('netiflyServer-dave');

    await closePromise;
  });

  it('close() resolves even while a client is still connected', async () => {
    const server = await startTestServer(() => 'netiflyServer-henry');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    // A regression here (close() hanging because WebSocketServer#close()
    // never gets its tracked clients removed) should fail this test loudly
    // and quickly rather than hanging the whole run for jest.setTimeout's
    // full 15s.
    await expect(
      Promise.race([
        server.close(),
        wait(3000).then(() => {
          throw new Error('close() did not resolve within 3000ms with a client still connected');
        }),
      ])
    ).resolves.toBeUndefined();

    servers.pop(); // already closed above; skip afterEach double-close
  });

  // NOT-19: close() should send a real close frame with code 1012 ("Service
  // Restart") instead of terminate()-ing every socket, so clients can tell a
  // graceful shutdown apart from an abrupt drop and reconnect accordingly.
  it('close() sends close code 1012 to a connected client by default (NOT-19)', async () => {
    const server = await startTestServer(() => 'netiflyServer-close-1012');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const clientClosePromise = new Promise<number>((resolve) => {
      client.once('close', (code) => resolve(code));
    });

    await server.netifly.close();
    servers.pop(); // already closed above; skip afterEach double-close

    expect(await clientClosePromise).toBe(1012);
  });

  // NOT-19: a client that never completes the closing handshake (e.g. dead
  // network, unresponsive process) must not block close() forever — after
  // drainMs elapses, any still-connected socket is force-terminated so
  // close() resolves on a bounded timeline.
  it('close() resolves within drainMs even when a client never acknowledges the close frame (NOT-19)', async () => {
    const server = await startTestServer(() => 'netiflyServer-close-straggler');
    servers.push(server);

    const registered: WebSocket[] = [];
    const originalAdd = ConnectionRegistry.prototype.add;
    const addSpy = jest
      .spyOn(ConnectionRegistry.prototype, 'add')
      .mockImplementation(function (this: ConnectionRegistry<unknown>, uid: string, connection: unknown) {
        registered.push(connection as WebSocket);
        return originalAdd.call(this, uid, connection);
      });

    try {
      const firstConnected = onceEvent(server.netifly, 'connect');
      const stragglerClient = await connectClient(server.port);
      clients.push(stragglerClient);
      await firstConnected;

      const secondConnected = onceEvent(server.netifly, 'connect');
      const normalClient = await connectClient(server.port);
      clients.push(normalClient);
      await secondConnected;

      expect(registered).toHaveLength(2);
      // Make the server-side socket for the straggler unresponsive to a
      // graceful close: stubbing its own close() to a no-op means it never
      // emits a 'close' event on its own, simulating a client that received
      // the close frame but never completed the handshake (dead network,
      // hung process, etc).
      registered[0].close = () => {
        /* deliberately unresponsive to graceful close, for this test only */
      };

      const started = Date.now();
      await Promise.race([
        server.netifly.close({ drainMs: 75 }),
        wait(3000).then(() => {
          throw new Error('close() did not resolve within 3000ms despite an unresponsive client');
        }),
      ]);
      const elapsed = Date.now() - started;
      servers.pop(); // already closed above; skip afterEach double-close

      // Should take roughly drainMs (bounded below by it, well under the 3s
      // safety net above) rather than resolving immediately or hanging.
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      addSpy.mockRestore();
    }
  });

  // NOT-19: force: true preserves the pre-NOT-19 behavior exactly — every
  // connection is terminate()'d immediately, no graceful drain at all.
  it('close({ force: true }) terminates connections immediately regardless of drainMs (NOT-19)', async () => {
    const server = await startTestServer(() => 'netiflyServer-close-force');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const clientClosePromise = new Promise<{ code: number; hadError: boolean }>((resolve) => {
      let hadError = false;
      client.once('error', () => {
        hadError = true;
      });
      client.once('close', (code) => resolve({ code, hadError }));
    });

    const started = Date.now();
    await Promise.race([
      server.netifly.close({ force: true, drainMs: 60_000 }),
      wait(2000).then(() => {
        throw new Error('close({ force: true }) did not resolve promptly');
      }),
    ]);
    const elapsed = Date.now() - started;
    servers.pop(); // already closed above; skip afterEach double-close

    // Resolves quickly, without waiting anywhere near the (very large) drainMs.
    expect(elapsed).toBeLessThan(2000);

    // terminate() doesn't perform a clean closing handshake, so the client
    // sees an abnormal closure rather than code 1012.
    const { code } = await clientClosePromise;
    expect(code).not.toBe(1012);
  });

  it('rejects send() after close()', async () => {
    const server = await startTestServer(() => 'netiflyServer-gina');
    servers.push(server);

    await server.netifly.close();
    await expect(server.netifly.send('netiflyServer-gina', { type: 'x' })).rejects.toThrow(
      'Netifly: cannot send after close()'
    );

    servers.pop(); // already closed above; skip afterEach double-close
  });

  // NOT-5 regression: connection A subscribes, its socket dies while the
  // SUBSCRIBE is still in flight, and connection B for the same user arrives
  // and starts its own SUBSCRIBE before A's is observed to complete. A's
  // post-await cleanup must not tear down B's subscription.
  //
  // RedisRouter#subscribe is wrapped rather than the raw ioredis client:
  // the fix makes an overlapping subscribe() resolve without ever touching
  // Redis (it just bumps a ref count), so counting real ioredis calls can't
  // distinguish "A's call" from "B's call" once the fix is in place. Forwarding
  // to the real method immediately preserves its real side effects (ref
  // counting, actual SUBSCRIBE/UNSUBSCRIBE commands) — only the moment
  // netiflyServer is told "your subscribe finished" is held back, under
  // test control.
  it('does not lose messages when a second connection for the same user arrives while the first is still subscribing and then closes', async () => {
    const userId = 'netiflyServer-race';
    const originalSubscribe = RedisRouter.prototype.subscribe;
    const releases: Array<() => void> = [];
    let callIndex = 0;

    const subscribeSpy = jest
      .spyOn(RedisRouter.prototype, 'subscribe')
      .mockImplementation(function (this: RedisRouter, subscribedUserId: string) {
        const index = callIndex++;
        const realPromise = originalSubscribe.call(this, subscribedUserId);
        if (index > 1) return realPromise;
        return new Promise<void>((resolve, reject) => {
          releases[index] = () => realPromise.then(resolve, reject);
        });
      });

    try {
      const server = await startTestServer(() => userId);
      servers.push(server);

      const clientA = await connectClient(server.port);
      clients.push(clientA);
      await wait(20); // let registerConnection(A) reach the subscribe call

      const aClosed = new Promise<void>((resolve) => clientA.once('close', () => resolve()));
      clientA.terminate();
      await aClosed;

      const clientB = await connectClient(server.port);
      clients.push(clientB);
      await wait(20); // let registerConnection(B) reach its own subscribe call, still unresolved

      releases[0](); // A's SUBSCRIBE resolves; A is already closed, triggering its cleanup
      await wait(20);

      const bConnected = onceEvent(server.netifly, 'connect');
      releases[1](); // B's SUBSCRIBE resolves; B registers
      await bConnected;

      const messagePromise = nextMessage(clientB);
      await server.netifly.send(userId, { type: 'after-race' });

      const received = await Promise.race([
        messagePromise,
        wait(3000).then(() => {
          throw new Error('clientB never received the message published after the race');
        }),
      ]);
      const envelope = JSON.parse(received);
      expect(envelope.data).toEqual({ type: 'after-race' });
    } finally {
      subscribeSpy.mockRestore();
    }
  });

  // NOT-7: `ws`'s default maxPayload is 100 MiB even though Netifly ignores
  // client→server messages entirely — an easy memory/DoS vector. We don't
  // reimplement `ws`'s own inbound frame-size enforcement here; this just
  // proves the `maxPayload` option is actually wired into the WebSocketServer
  // constructor, by observing the client-visible effect (a 1009 close) of a
  // real oversized frame sent from a real client.
  it('closes the connection with code 1009 when an inbound frame exceeds maxPayload (NOT-7)', async () => {
    const server = await startTestServer(() => 'netiflyServer-maxpayload', { maxPayload: 16 });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const closePromise = new Promise<number>((resolve) => {
      client.once('close', (code) => resolve(code));
    });

    client.send('x'.repeat(1024)); // far larger than the 16-byte maxPayload configured above

    expect(await closePromise).toBe(1009);
  });

  // NOT-18: two apps (or staging/prod) sharing one Redis instance would
  // otherwise collide on the same plain `netifly:user:<id>` channel. Passing
  // `namespace` to createNetifly() must make the server actually SUBSCRIBE
  // on the namespaced channel, not the default one.
  it('applies namespace to the Redis channel used for subscriptions (NOT-18)', async () => {
    const userId = 'netiflyServer-namespaced';
    const server = await startTestServer(() => userId, { namespace: 'staging' });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    expect(await numSubscribers(channelName(userId, 'staging'))).toBe(1);
    expect(await numSubscribers(channelName(userId))).toBe(0);
  });

  // NOT-7: caps concurrent connections per userId so a single token can't
  // open unbounded sockets. This is enforced per-instance (ConnectionRegistry
  // only tracks local connections) — see the comment in netiflyServer.ts.
  it('rejects a connection past maxConnectionsPerUser with 429 and emits "reject" (NOT-7)', async () => {
    const userId = 'netiflyServer-maxconns';
    const server = await startTestServer(() => userId, { maxConnectionsPerUser: 2 });
    servers.push(server);

    const firstConnected = onceEvent(server.netifly, 'connect');
    const first = await connectClient(server.port);
    clients.push(first);
    await firstConnected;

    const secondConnected = onceEvent(server.netifly, 'connect');
    const second = await connectClient(server.port);
    clients.push(second);
    await secondConnected;

    const rejectPromise = new Promise<RejectInfo>((resolve) =>
      server.netifly.once('reject', (info) => resolve(info))
    );

    const { statusCode } = await connectExpectingRejection(server.port);

    expect(statusCode).toBe(429);
    const info = await rejectPromise;
    expect(info).toMatchObject({ reason: 'maxConnectionsPerUser', status: 429, userId });
  });

  // NOT-7: a slow/stalled client's outbound buffer (ws.bufferedAmount) must
  // not grow unbounded — deliverLocally should skip sending to a connection
  // over maxBufferedBytes, emit 'dropped', and shed that one connection with
  // close code 1013, while a user's other, healthy connections still get the
  // message normally.
  //
  // Driving a real ws.bufferedAmount over a threshold deterministically means
  // making the receiver stop reading, but that's slow/flaky over loopback
  // (OS socket buffers are large, so it can take a while, if it happens at
  // all, before the test's timeout). Instead we spy on
  // ConnectionRegistry#add (the same pattern the NOT-5 race test above uses
  // for RedisRouter#subscribe) purely to capture a reference to the exact
  // server-side `ws` instance registered for the "stalled" client, then
  // shadow `bufferedAmount` with an own property on that single instance —
  // every other instance, including the healthy second connection's ws,
  // keeps its real, prototype-level getter untouched. This is fast,
  // deterministic, and only stubs the exact seam deliverLocally reads.
  // NOT-14: presence is derived from Redis PUBSUB NUMSUB on the per-user
  // channel — every online user has a subscribed channel somewhere in the
  // cluster, so isOnline()/whoIsOnline() work cross-instance with no extra
  // state, while isConnectedHere() is a synchronous, local-only fast path.
  it('isOnline() is true cross-instance via Redis while isConnectedHere() is local-only (NOT-14)', async () => {
    const userId = 'netiflyServer-presence-cross-instance';
    const serverA = await startTestServer(() => userId);
    const serverB = await startTestServer(() => userId);
    servers.push(serverA, serverB);

    const connectedPromise = onceEvent(serverB.netifly, 'connect');
    const client = await connectClient(serverB.port);
    clients.push(client);
    await connectedPromise;

    await expect(serverA.netifly.isOnline(userId)).resolves.toBe(true);
    expect(serverA.netifly.isConnectedHere(userId)).toBe(false);
    expect(serverB.netifly.isConnectedHere(userId)).toBe(true);
  });

  it('isOnline() resolves false for a userId nobody is connected to anywhere (NOT-14)', async () => {
    const server = await startTestServer(() => 'netiflyServer-presence-nobody');
    servers.push(server);

    await expect(server.netifly.isOnline('netiflyServer-presence-nobody-home')).resolves.toBe(
      false
    );
  });

  it('whoIsOnline() returns correct booleans for a mix of online and offline userIds in one call (NOT-14)', async () => {
    const onlineUserId = 'netiflyServer-presence-who-online';
    const offlineUserId = 'netiflyServer-presence-who-offline';
    const server = await startTestServer(() => onlineUserId);
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    await expect(server.netifly.whoIsOnline([onlineUserId, offlineUserId])).resolves.toEqual({
      [onlineUserId]: true,
      [offlineUserId]: false,
    });
  });

  it('whoIsOnline([]) resolves {} without erroring (NOT-14)', async () => {
    const server = await startTestServer(() => 'netiflyServer-presence-empty');
    servers.push(server);

    await expect(server.netifly.whoIsOnline([])).resolves.toEqual({});
  });

  it('skips delivery, emits "dropped", and closes with 1013 for a connection over maxBufferedBytes, without affecting other connections (NOT-7)', async () => {
    const userId = 'netiflyServer-buffered';
    const registered: unknown[] = [];
    const originalAdd = ConnectionRegistry.prototype.add;
    const addSpy = jest
      .spyOn(ConnectionRegistry.prototype, 'add')
      .mockImplementation(function (this: ConnectionRegistry<unknown>, uid: string, connection: unknown) {
        if (uid === userId) registered.push(connection);
        return originalAdd.call(this, uid, connection);
      });

    try {
      const server = await startTestServer(() => userId, { maxBufferedBytes: 1024 });
      servers.push(server);

      const firstConnected = onceEvent(server.netifly, 'connect');
      const stalledClient = await connectClient(server.port);
      clients.push(stalledClient);
      await firstConnected;

      const secondConnected = onceEvent(server.netifly, 'connect');
      const healthyClient = await connectClient(server.port);
      clients.push(healthyClient);
      await secondConnected;

      expect(registered).toHaveLength(2);
      Object.defineProperty(registered[0], 'bufferedAmount', {
        configurable: true,
        get: () => 10 * 1024 * 1024, // well over the 1024-byte maxBufferedBytes above
      });

      const droppedPromise = new Promise<DroppedInfo>((resolve) =>
        server.netifly.once('dropped', (info) => resolve(info))
      );
      const stalledClosePromise = new Promise<number>((resolve) =>
        stalledClient.once('close', (code) => resolve(code))
      );
      const healthyMessagePromise = nextMessage(healthyClient);
      let stalledReceivedMessage = false;
      stalledClient.once('message', () => {
        stalledReceivedMessage = true;
      });

      await server.netifly.send(userId, { type: 'buffered-check' });

      const droppedInfo = await droppedPromise;
      expect(droppedInfo).toMatchObject({ userId, reason: 'maxBufferedBytes' });
      expect(await stalledClosePromise).toBe(1013);

      const healthyEnvelope = JSON.parse(await healthyMessagePromise);
      expect(healthyEnvelope.data).toEqual({ type: 'buffered-check' });

      await wait(50);
      expect(stalledReceivedMessage).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });

  // NOT-16: `validate` is a runtime hook (e.g. for a Zod/Valibot schema) that
  // should see the exact same (type, data) pair that ends up in the
  // envelope, run before anything is published, and be able to veto a send
  // outright by throwing.
  it('calls validate with the resolved (type, data) before publishing (NOT-16)', async () => {
    const validate = jest.fn();
    const server = await startTestServer(() => 'netiflyServer-validate-called', { validate });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-validate-called', 'comment.created', {
      commentId: '42',
    });
    await messagePromise;

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith('comment.created', { commentId: '42' });
  });

  it('a validate that throws prevents delivery and propagates out of send() (NOT-16)', async () => {
    const thrown = new Error('netiflyServer-validate-thrown');
    const validate = jest.fn(() => {
      throw thrown;
    });
    const server = await startTestServer(() => 'netiflyServer-validate-throws', { validate });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    let receivedMessage = false;
    client.once('message', () => {
      receivedMessage = true;
    });

    await expect(
      server.netifly.send('netiflyServer-validate-throws', 'comment.created', { commentId: '1' })
    ).rejects.toBe(thrown);

    await wait(50);
    expect(receivedMessage).toBe(false);
  });

  it('send()/sendOr() behave exactly as before when no validate is configured (NOT-16)', async () => {
    const server = await startTestServer(() => 'netiflyServer-no-validate');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    const result = await server.netifly.send('netiflyServer-no-validate', 'comment.created', {
      commentId: '1',
    });
    const envelope = JSON.parse(await messagePromise);

    expect(result).toEqual({ delivered: true, instances: 1 });
    expect(envelope).toMatchObject({ type: 'comment.created', data: { commentId: '1' } });

    const offline = jest.fn();
    const sendOrResult = await server.netifly.sendOr(
      'netiflyServer-no-validate-nobody-home',
      { type: 'x' },
      { offline }
    );
    expect(sendOrResult).toEqual({ delivered: false, instances: 0 });
    expect(offline).toHaveBeenCalledTimes(1);
  });
});
