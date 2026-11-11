import 'reflect-metadata';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import {
  CareControl,
  IntegrationModule,
  OnQuota,
  OutboundHttpError,
  OutboundRestGateway,
  ValveShutError,
  redisCareState,
  type Care,
  type CareEvent,
  type CareStatePort,
  type RedisEvalFn,
} from '../../src/index';

/**
 * Scenario "outage-multipod": a payment provider (PSP) goes down while two Estela pods call it.
 * Each pod is a real Nest app built by the testing module, with its own Redis connection, sharing
 * one `redisCareState` key space on a real `redis:7` container started for this file. The PSP is a
 * real HTTP server on loopback. Time is real; every wait is either a bounded poll on an observable
 * condition or a lower bound (`atLeast`) that only has to be longer than a configured interval.
 *
 * Skipped when Docker is not available. The container is always removed in `afterAll`.
 *   npx jest test/scenarios/outage-multipod
 */

jest.setTimeout(60_000);

/** The Docker CLI from a fixed install location, never resolved through PATH. */
function findDocker(): string | undefined {
  if (existsSync('/usr/local/bin/docker')) return '/usr/local/bin/docker';
  if (existsSync('/opt/homebrew/bin/docker')) return '/opt/homebrew/bin/docker';
  if (existsSync('/usr/bin/docker')) return '/usr/bin/docker';
  return undefined;
}

const dockerBin = findDocker();

function dockerAvailable(): boolean {
  if (dockerBin === undefined) return false;
  try {
    execFileSync(dockerBin, ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

const d = dockerAvailable() ? describe : describe.skip;

const docker = (...args: string[]): string =>
  execFileSync(dockerBin!, args, { encoding: 'utf8', timeout: 60_000 }).trim();

// ---------- Timing of the scenario (real clock) ----------

/** How long a valve stays shut, and the probe lease length (RS-18, RS-23). */
const SHUT_MS = 1_200;
/** How often a pod reads the shared "shut" mark of a key (RS-23). */
const SYNC_MS = 40;
/**
 * Longest wait on one shared-state call before the binding degrades (RS-24). It is a bound on
 * "Redis does not answer", not a latency estimate: a binding that misses it degrades and skips the
 * shared mark for STATE_CHECK_MS, so a budget near a loopback round trip under a loaded test run
 * makes the healthy-Redis tests fail at random. RS-24 never waits for it: a stopped container
 * refuses the connection at once.
 */
const STATE_WAIT_MS = 2_000;
/** A call decided by local state while Redis is down answers well within this (RS-24). */
const LOCAL_DECISION_MS = 1_000;
/** How often a degraded binding checks the shared state again (RS-24). */
const STATE_CHECK_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lower-bound wait: waits for a configured interval (such as SYNC_MS) to have passed. It never
 * races the code under test, it only makes sure an interval is over.
 */
const atLeast = (ms: number): Promise<void> => sleep(ms + 15);

/** Bounded poll: resolves with the first defined answer, or fails after `timeoutMs`. */
async function eventually<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 4_000,
  everyMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---------- Minimal RESP client (no Redis client is a dependency) ----------

type Reply = string | number | null | Reply[] | Error;

function parseReply(buffer: Buffer, offset: number): { value: Reply; next: number } | undefined {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return undefined;
  const type = String.fromCharCode(buffer[offset]!);
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === '+') return { value: line, next };
  if (type === '-') return { value: new Error(line), next };
  if (type === ':') return { value: Number(line), next };
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, next };
    if (buffer.length < next + length + 2) return undefined;
    return { value: buffer.toString('utf8', next, next + length), next: next + length + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next };
    const items: Reply[] = [];
    let cursor = next;
    for (let i = 0; i < count; i += 1) {
      const item = parseReply(buffer, cursor);
      if (item === undefined) return undefined;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`unexpected RESP type '${type}'`);
}

const bulk = (arg: string): string => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
const encode = (args: readonly string[]): string => `*${args.length}\r\n${args.map(bulk).join('')}`;

/** One pipelined connection; it fails its pending commands when the socket closes. */
class RespConnection {
  private buffer = Buffer.alloc(0);
  private readonly pending: { resolve(value: Reply): void; reject(error: Error): void }[] = [];
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
      for (const waiter of this.pending.splice(0)) waiter.reject(new Error('redis closed'));
    });
  }

  static async open(port: number, timeoutMs = 500): Promise<RespConnection> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('redis connect timeout'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new RespConnection(socket);
  }

  command(args: readonly string[]): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('redis closed'));
    return new Promise<Reply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encode(args));
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseReply(this.buffer, 0);
      if (parsed === undefined) return;
      this.buffer = this.buffer.subarray(parsed.next);
      this.pending.shift()?.resolve(parsed.value);
    }
  }
}

/** What a pod's app hands to `redisCareState`: reconnects lazily, like a production client. */
class PodRedis {
  private connection: RespConnection | undefined;

  constructor(private readonly port: number) {}

  readonly evalScript: RedisEvalFn = async (script, keys, args) => {
    const reply = await this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
    if (reply instanceof Error) throw reply;
    return reply;
  };

  async command(args: readonly string[]): Promise<Reply> {
    if (this.connection === undefined || this.connection.closed) {
      this.connection = await RespConnection.open(this.port);
    }
    return this.connection.command(args);
  }

  close(): void {
    this.connection?.close();
  }
}

// ---------- The payment provider (downstream) ----------

type PspMode = 'outage' | 'healthy' | 'daily-limit';

interface PspHit {
  pod: string;
  path: string;
  idempotencyKey: string | undefined;
  body: unknown;
}

interface Psp {
  base: string;
  mode: PspMode;
  /** Delay of a healthy answer, so concurrent probes overlap in flight. */
  healthyDelayMs: number;
  hits: PspHit[];
  maxInFlight: number;
  hitsFrom(pod: string, path?: string): number;
  close(): Promise<void>;
}

async function startPsp(): Promise<Psp> {
  let inFlight = 0;
  const psp: Psp = {
    base: '',
    mode: 'outage',
    healthyDelayMs: 0,
    hits: [],
    maxInFlight: 0,
    hitsFrom: (pod, path) =>
      psp.hits.filter((hit) => hit.pod === pod && (path === undefined || hit.path === path)).length,
    close: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      inFlight += 1;
      psp.maxInFlight = Math.max(psp.maxInFlight, inFlight);
      const raw = Buffer.concat(chunks).toString('utf8');
      psp.hits.push({
        pod: String(req.headers['x-pod']),
        path: (req.url ?? '').split('?')[0] ?? '',
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      });
      const answer = (status: number, body: unknown): void => {
        inFlight -= 1;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (psp.mode === 'outage') {
        answer(503, { error: { type: 'api_error', code: 'acquirer_unavailable' } });
      } else if (psp.mode === 'daily-limit') {
        answer(402, { error: { type: 'limit_error', code: 'merchant_daily_payout_limit' } });
      } else {
        const respond = (): void =>
          answer(200, { id: `ch_${randomBytes(6).toString('hex')}`, status: 'succeeded' });
        if (psp.healthyDelayMs > 0) setTimeout(respond, psp.healthyDelayMs);
        else respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  psp.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  psp.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return psp;
}

// ---------- Pods ----------

interface Pod {
  name: string;
  app: INestApplication;
  control: CareControl;
  events: CareEvent[];
  redis: PodRedis;
  /** Sends one realistic payment operation through the named binding. */
  send(binding: string, operation: Record<string, unknown>): Promise<unknown>;
  eventsOf(type: CareEvent['type'], binding?: string): CareEvent[];
}

let sequence = 0;

/** A Guatemalan card charge, as a checkout service would send it. */
function charge(): Record<string, unknown> {
  sequence += 1;
  return {
    paymentId: `pay_${String(sequence).padStart(6, '0')}`,
    merchantId: 'mrc_tienda_zona10',
    amount: { value: 12_950, currency: 'GTQ' },
    method: { type: 'card', network: 'visa', last4: '4242', expMonth: 11, expYear: 2029 },
    capture: true,
    metadata: { orderId: `ord_${sequence}`, channel: 'whatsapp-checkout' },
  };
}

/** A merchant payout to a bank account. */
function payout(): Record<string, unknown> {
  sequence += 1;
  return {
    payoutId: `po_${String(sequence).padStart(6, '0')}`,
    merchantId: 'mrc_tienda_zona10',
    amount: { value: 1_250_000, currency: 'GTQ' },
    destination: { bank: 'BI', accountType: 'monetaria', accountLast4: '9031' },
  };
}

type ValveCare = Care;

d('scenario outage-multipod: a PSP outage seen by two pods sharing Redis', () => {
  const container = `estela-scn-outage-${randomBytes(4).toString('hex')}`;
  const prefix = `scn-outage-${randomBytes(4).toString('hex')}:`;
  let redisPort = 0;
  let admin: PodRedis;
  let psp: Psp;
  const pods: Pod[] = [];

  async function redisReady(): Promise<void> {
    await eventually(
      'redis PING',
      async () => {
        const probe = new PodRedis(redisPort);
        try {
          return (await probe.command(['PING'])) === 'PONG' ? true : undefined;
        } catch {
          return undefined;
        } finally {
          probe.close();
        }
      },
      30_000,
      100,
    );
  }

  beforeAll(async () => {
    redisPort = await freePort();
    docker(
      'run',
      '-d',
      '--name',
      container,
      '-p',
      `127.0.0.1:${redisPort}:6379`,
      'redis:7',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    );
    await redisReady();
    admin = new PodRedis(redisPort);
    psp = await startPsp();
  });

  afterAll(async () => {
    admin?.close();
    await psp?.close();
    try {
      docker('rm', '-f', container);
    } catch {
      // Already gone.
    }
  });

  beforeEach(() => {
    psp.hits.length = 0;
    psp.maxInFlight = 0;
    psp.mode = 'outage';
    psp.healthyDelayMs = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    // A failed Redis-down test must not leave the server stopped for the next test.
    if (docker('inspect', '-f', '{{.State.Running}}', container) !== 'true') {
      docker('start', container);
      await redisReady();
    }
    for (const pod of pods.splice(0)) {
      await pod.app.close();
      pod.redis.close();
    }
    jest.restoreAllMocks();
  });

  /** Boots one pod: its own Nest app, Redis connection and shared state port. */
  async function startPod(
    name: string,
    bindings: { name: string; path: string; care: (state: CareStatePort) => ValveCare }[],
  ): Promise<Pod> {
    // The pod connects before it boots, as a production client does, so no care call pays the
    // connection setup.
    const redis = new PodRedis(redisPort);
    expect(await redis.command(['PING'])).toBe('PONG');
    const state = redisCareState(redis.evalScript, { prefix });
    const events: CareEvent[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({
          channels: [],
          logging: { banner: false },
          care: {
            sharedStateWaitMs: STATE_WAIT_MS,
            sharedStateCheckMs: STATE_CHECK_MS,
            events: { channel: false, onEvent: (event) => events.push(event) },
          },
          outbound: {
            rest: {
              bindings: bindings.map((binding) => ({
                name: binding.name,
                url: `${psp.base}${binding.path}`,
                method: 'POST',
                headers: { 'x-pod': name },
                care: binding.care(state),
              })),
            },
          },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const gateway = app.get(OutboundRestGateway);
    const pod: Pod = {
      name,
      app,
      control: app.get(CareControl),
      events,
      redis,
      send: (binding, operation) =>
        gateway.request(binding, {
          payload: operation,
          headers: {
            idempotencyKey: String(operation.paymentId ?? operation.payoutId ?? operation.refundId),
          },
        }),
      eventsOf: (type, binding) =>
        events.filter(
          (event) => event.type === type && (binding === undefined || event.binding === binding),
        ),
    };
    pods.push(pod);
    return pod;
  }

  /** The shared "shut" mark of a binding's default key, read straight from Redis. */
  async function markOf(binding: string, quota = false): Promise<number | undefined> {
    const key = `${prefix}estela:care:valve:${binding}${quota ? ':quota' : ''}`;
    const value = await admin.command(['GET', key]);
    return typeof value === 'string' ? Number(value) : undefined;
  }

  const outageValve =
    (overrides: Record<string, unknown> = {}) =>
    (state: CareStatePort): ValveCare => ({
      valve: {
        minCalls: 3,
        failPercent: 50,
        lookBack: { lastCalls: 10 },
        shutMs: SHUT_MS,
        syncMs: SYNC_MS,
        state,
        ...overrides,
      },
    });

  const settle = async (call: Promise<unknown>) =>
    call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  /** Pod A sees `minCalls` 503s; returns once its valve is shut and the mark is in Redis. */
  async function tripOn(pod: Pod, binding: string, path: string): Promise<number> {
    for (let i = 0; i < 3; i += 1) {
      const error: unknown = await pod.send(binding, charge()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OutboundHttpError);
      expect((error as OutboundHttpError).status).toBe(503);
    }
    expect(psp.hitsFrom(pod.name, path)).toBe(3);
    expect(pod.control.valveState(binding)).toEqual({ state: 'shut' });
    return eventually(`shared mark of ${binding}`, () => markOf(binding));
  }

  it('RS-18, RS-23 (D11): failures are counted per pod, the first pod to trip shuts the valve for both through the shared mark', async () => {
    const binding = 'psp.charges';
    const path = '/v1/charges';
    const a = await startPod('pod-a', [{ name: binding, path, care: outageValve() }]);
    const b = await startPod('pod-b', [{ name: binding, path, care: outageValve() }]);

    // Two failures on each pod: four failures in total, but no pod has reached minCalls alone.
    for (const pod of [a, b, a, b]) {
      await expect(pod.send(binding, charge())).rejects.toBeInstanceOf(OutboundHttpError);
    }
    expect(a.control.valveState(binding)).toEqual({ state: 'flowing' });
    expect(b.control.valveState(binding)).toEqual({ state: 'flowing' });
    expect(await markOf(binding)).toBeUndefined();

    // The third failure on pod A trips it and writes the shared mark. A degraded binding would
    // skip that write, so the precondition is checked first.
    await expect(a.send(binding, charge())).rejects.toBeInstanceOf(OutboundHttpError);
    expect(a.control.valveState(binding)).toEqual({ state: 'shut' });
    expect(a.eventsOf('shared-state.lost')).toHaveLength(0);
    const until = await eventually('shared mark', () => markOf(binding));
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + SHUT_MS);
    expect(a.eventsOf('valve.shut', binding)).toHaveLength(1);

    const hitsBefore = psp.hits.length;
    const shutOnA: unknown = await a.send(binding, charge()).catch((caught: unknown) => caught);
    expect(shutOnA).toBeInstanceOf(ValveShutError);
    expect((shutOnA as ValveShutError).readyInMs).toBeGreaterThan(0);

    // Pod B read the (absent) mark on its last call; once SYNC_MS is over it reads it again.
    await atLeast(SYNC_MS);
    const shutOnB: unknown = await b.send(binding, charge()).catch((caught: unknown) => caught);
    expect(shutOnB).toBeInstanceOf(ValveShutError);
    expect((shutOnB as ValveShutError).readyInMs).toBeGreaterThan(0);
    expect((shutOnB as ValveShutError).readyInMs).toBeLessThanOrEqual(SHUT_MS);
    expect(psp.hits).toHaveLength(hitsBefore);
    expect(psp.hitsFrom('pod-b', path)).toBe(2);
    expect(b.eventsOf('shared-state.lost')).toHaveLength(0);
  });

  it('RS-19, RS-23: after the outage only one pod probes, and recovery reopens the valve on both pods', async () => {
    const binding = 'psp.captures';
    const path = '/v1/captures';
    const a = await startPod('pod-a', [{ name: binding, path, care: outageValve() }]);
    const b = await startPod('pod-b', [{ name: binding, path, care: outageValve() }]);
    const until = await tripOn(a, binding, path);
    await expect(b.send(binding, charge())).rejects.toBeInstanceOf(ValveShutError);
    expect(psp.hitsFrom('pod-b', path)).toBe(0);

    // The PSP is back, slowly: a probe stays in flight while the other pod asks to probe too.
    psp.mode = 'healthy';
    psp.healthyDelayMs = 150;
    await eventually('the shut period to end', () =>
      Date.now() > until + 5 && a.control.valveState(binding)?.state === 'probing'
        ? true
        : undefined,
    );
    const race = await Promise.all([a, b].map((pod) => settle(pod.send(binding, charge()))));
    expect(psp.hits.filter((hit) => hit.path === path)).toHaveLength(3 + 1);
    expect(psp.maxInFlight).toBe(1);
    const winners = race.filter((outcome) => outcome.ok);
    const losers = race.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.ok === false && losers[0]!.error).toBeInstanceOf(ValveShutError);
    const winner = race[0]!.ok ? a : b;
    const loser = winner === a ? b : a;
    expect(winner.control.valveState(binding)).toEqual({ state: 'flowing' });
    expect(winner.eventsOf('valve.flowing', binding)).toHaveLength(1);

    // The other pod probes on its own once the lease of the first probe is over, then flows.
    psp.healthyDelayMs = 0;
    const loserHitsBefore = psp.hitsFrom(loser.name, path);
    await eventually(
      `${loser.name} to flow again`,
      async () => ((await settle(loser.send(binding, charge()))).ok ? true : undefined),
      SHUT_MS + 2_000,
      50,
    );
    expect(psp.hitsFrom(loser.name, path)).toBe(loserHitsBefore + 1);
    expect(loser.control.valveState(binding)).toEqual({ state: 'flowing' });
    for (const pod of [a, b]) {
      await expect(pod.send(binding, charge())).resolves.toMatchObject({ status: 200 });
    }
  });

  it('RS-24: Redis going down mid-outage degrades both pods to local state without crashing, and they switch back when it returns', async () => {
    const binding = 'psp.refunds';
    const path = '/v1/refunds';
    const a = await startPod('pod-a', [{ name: binding, path, care: outageValve() }]);
    const b = await startPod('pod-b', [{ name: binding, path, care: outageValve() }]);
    psp.mode = 'healthy';
    for (const pod of [a, b]) {
      await expect(pod.send(binding, charge())).resolves.toMatchObject({ status: 200 });
    }

    docker('stop', '--time', '1', container);
    psp.mode = 'outage';
    await atLeast(SYNC_MS);

    // Every call is still decided, quickly, by local state: a 503 from the PSP or a local shut.
    const errors: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      for (const pod of [a, b]) {
        const started = Date.now();
        errors.push(await pod.send(binding, charge()).catch((caught: unknown) => caught));
        expect(Date.now() - started).toBeLessThan(LOCAL_DECISION_MS);
      }
    }
    for (const error of errors) {
      expect(error instanceof OutboundHttpError || error instanceof ValveShutError).toBe(true);
    }
    // Each pod tripped on its own window (1 success, 2 failures: 66% over minCalls 3), and its
    // third and fourth calls were turned away locally.
    for (const pod of [a, b]) {
      expect(psp.hitsFrom(pod.name, path)).toBe(1 + 2);
      expect(pod.control.valveState(binding)).toEqual({ state: 'shut' });
      expect(pod.eventsOf('valve.shut', binding)).toHaveLength(1);
      await eventually(`${pod.name} shared-state.lost`, () =>
        pod.eventsOf('shared-state.lost', binding).length > 0 ? true : undefined,
      );
      expect(pod.eventsOf('shared-state.lost', binding)).toHaveLength(1);
    }
    expect(errors.filter((error) => error instanceof ValveShutError)).toHaveLength(4);

    // Redis is back (empty), the PSP too. After the shut period each pod checks the shared state
    // again on its next call and switches back; one of them takes the probe lease.
    docker('start', container);
    await redisReady();
    psp.mode = 'healthy';
    await eventually('both valves to reach probing', () =>
      [a, b].every((pod) => pod.control.valveState(binding)?.state === 'probing')
        ? true
        : undefined,
    );
    const outcomes = await Promise.all([a, b].map((pod) => settle(pod.send(binding, charge()))));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    for (const pod of [a, b]) {
      expect(pod.eventsOf('shared-state.back', binding)).toHaveLength(1);
      expect(pod.eventsOf('shared-state.lost', binding)).toHaveLength(1);
    }
  });

  it('RS-16, RS-49: an operator resume on one pod reopens a quota shut valve on the other pod too', async () => {
    const binding = 'psp.payouts';
    const path = '/v1/payouts';
    const quotaValve = (state: CareStatePort): ValveCare => ({
      classify: (error) =>
        error instanceof OutboundHttpError && error.status === 402 ? 'quota' : undefined,
      ...outageValve({ onQuota: OnQuota.ShutUntilResumed })(state),
    });
    const a = await startPod('pod-a', [{ name: binding, path, care: quotaValve }]);
    const b = await startPod('pod-b', [{ name: binding, path, care: quotaValve }]);

    // The merchant hits its daily payout limit: one answer shuts the valve until resumed.
    psp.mode = 'daily-limit';
    await expect(a.send(binding, payout())).rejects.toBeInstanceOf(OutboundHttpError);
    expect(a.control.valveState(binding)).toEqual({ state: 'shut', forcedBy: 'quota' });
    await eventually('quota mark', () => markOf(binding, true));
    const onB: unknown = await b.send(binding, payout()).catch((caught: unknown) => caught);
    expect(onB).toBeInstanceOf(ValveShutError);
    expect((onB as ValveShutError).forcedBy).toBe('quota');
    expect(psp.hitsFrom('pod-b', path)).toBe(0);

    // The limit is raised; an operator resumes the valve through the pod that shut it.
    psp.mode = 'healthy';
    await a.control.resume(binding);
    expect(await markOf(binding, true)).toBeUndefined();
    expect(await markOf(binding)).toBeUndefined();
    expect(a.control.valveState(binding)).toEqual({ state: 'flowing' });
    expect(a.eventsOf('valve.flowing', binding)).toHaveLength(1);
    await expect(a.send(binding, payout())).resolves.toMatchObject({ status: 200 });

    // Pod B reads the cleared mark on its next sync and lets payouts through again.
    await atLeast(SYNC_MS);
    await expect(b.send(binding, payout())).resolves.toMatchObject({ status: 200 });
    expect(psp.hitsFrom('pod-b', path)).toBe(1);
  });

  it('RS-16, RS-49: an operator resume on the pod that only saw the mark reopens the pod that shut the valve', async () => {
    const binding = 'psp.transfers';
    const path = '/v1/transfers';
    const quotaValve = (state: CareStatePort): ValveCare => ({
      classify: (error) =>
        error instanceof OutboundHttpError && error.status === 402 ? 'quota' : undefined,
      ...outageValve({ onQuota: OnQuota.ShutUntilResumed })(state),
    });
    const a = await startPod('pod-a', [{ name: binding, path, care: quotaValve }]);
    const b = await startPod('pod-b', [{ name: binding, path, care: quotaValve }]);

    psp.mode = 'daily-limit';
    await expect(a.send(binding, payout())).rejects.toBeInstanceOf(OutboundHttpError);
    await eventually('quota mark', () => markOf(binding, true));
    await expect(b.send(binding, payout())).rejects.toBeInstanceOf(ValveShutError);

    // The resume request lands on pod B (any pod behind the load balancer may serve it).
    psp.mode = 'healthy';
    await b.control.resume(binding);
    expect(await markOf(binding, true)).toBeUndefined();
    await expect(b.send(binding, payout())).resolves.toMatchObject({ status: 200 });

    // Pod A, shut until resumed, sees the mark is gone on its next sync and flows again.
    await atLeast(SYNC_MS);
    await expect(a.send(binding, payout())).resolves.toMatchObject({ status: 200 });
    expect(a.control.valveState(binding)).toEqual({ state: 'flowing' });
    expect(a.eventsOf('valve.flowing', binding)).toHaveLength(1);
    expect(psp.hitsFrom('pod-a', path)).toBe(2);
  });
});
