import type http from 'node:http';
import { expectType, expectError } from 'tsd';
import {
  createNetifly,
  createNetiflyPublisher,
  type SendResult,
} from '../src/index';

// NOT-16: end-to-end type safety for createNetifly<Events>()/createNetiflyPublisher<Events>().
//
// These files are never executed — tsd only feeds them through the
// TypeScript compiler and checks the resulting diagnostics against the
// `expectType`/`expectError` assertions below.

type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

declare const server: http.Server;
declare const userId: string;

// --- createNetifly<Events>(): typed send()/sendOr() ---

const netifly = createNetifly<Events>({
  server,
  resolveUserId: async () => userId,
  redisUrl: 'redis://127.0.0.1:6379',
  validate: <K extends keyof Events & string>(type: K, data: Events[K]) => {
    void type;
    void data;
  },
});

expectType<Promise<SendResult>>(
  netifly.send(userId, 'export.ready', { url: 'https://example.com/export.zip' })
);

// Wrong payload shape for the given event name.
expectError(netifly.send(userId, 'export.ready', { wrongField: 1 }));

// Event name that isn't in the Events map at all.
expectError(netifly.send(userId, 'not.a.real.event', {}));

// The untyped, payload-only shorthand overload still works and is
// unaffected by the Events type argument.
expectType<Promise<SendResult>>(netifly.send(userId, { anything: true }));

// sendOr<K>() gets the same treatment as send<K>().
expectType<Promise<SendResult>>(
  netifly.sendOr(userId, 'export.ready', { url: 'https://example.com/export.zip' }, {
    offline: () => {},
  })
);
expectError(
  netifly.sendOr(userId, 'export.ready', { wrongField: 1 }, { offline: () => {} })
);
expectType<Promise<SendResult>>(netifly.sendOr(userId, { anything: true }, { offline: () => {} }));

// --- createNetifly() with no type argument: untyped usage still works ---

const untypedNetifly = createNetifly({
  server,
  resolveUserId: async () => userId,
  redisUrl: 'redis://127.0.0.1:6379',
});

// Defaults to Events = Record<string, unknown>, so any string type name and
// any data shape is accepted — no type error.
expectType<Promise<SendResult>>(untypedNetifly.send(userId, 'anything', { anything: true }));

// The payload-only overload is unaffected either way.
expectType<Promise<SendResult>>(untypedNetifly.send(userId, { anything: true }));

// --- createNetiflyPublisher<Events>(): same typed send() overload ---

const publisher = createNetiflyPublisher<Events>({
  redisUrl: 'redis://127.0.0.1:6379',
  validate: <K extends keyof Events & string>(type: K, data: Events[K]) => {
    void type;
    void data;
  },
});

expectType<Promise<SendResult>>(
  publisher.send(userId, 'export.ready', { url: 'https://example.com/export.zip' })
);
expectError(publisher.send(userId, 'export.ready', { wrongField: 1 }));
expectError(publisher.send(userId, 'not.a.real.event', {}));
expectType<Promise<SendResult>>(publisher.send(userId, { anything: true }));

const untypedPublisher = createNetiflyPublisher({ redisUrl: 'redis://127.0.0.1:6379' });
expectType<Promise<SendResult>>(untypedPublisher.send(userId, 'anything', { anything: true }));
