/**
 * Shared resilience state against a real Redis (RS-23: RE-04, RE-05). SKIPPED unless
 * ESTELA_REDIS_URL is set, so CI and `npm run verify` stay Redis-free. Each engine stands for a pod:
 * its own runtime, executor and Redis connection, sharing one `redisCareState` key space.
 * Every run uses its own key prefix and deletes its keys at the end, so runs can share a server.
 * No Redis client is a dependency: a minimal RESP client over `node:net` lives in this file.
 * Example:
 *   ESTELA_REDIS_URL=redis://localhost:6380 npx jest test/resilience-redis
 */
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  TryOverdueError,
  ValveShutError,
  defaultInProcessClassifier,
  OverPaceError,
  redisCareState,
  CareEngine,
  type RedisEvalFn,
  type CareEdgeAdapter,
  type Care,
  type CareStatePort,
} from '../src';

const url = process.env.ESTELA_REDIS_URL;
const d = url === undefined || url === '' ? describe.skip : describe;

jest.setTimeout(30_000);

type Reply = string | number | null | Reply[] | Error;

/** Parses one RESP2 reply at `offset`; undefined when the buffer does not hold all of it yet. */
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

function encode(args: readonly string[]): string {
  return `*${args.length}\r\n${args
    .map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`)
    .join('')}`;
}

/** One Redis connection: pipelined commands answered in order. */
class RespClient {
  private buffer = Buffer.alloc(0);
  private readonly pending: { resolve(value: Reply): void; reject(error: Error): void }[] = [];

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => {
      for (const waiter of this.pending.splice(0)) waiter.reject(error);
    });
  }

  static async open(target: string): Promise<RespClient> {
    const parsed = new URL(target);
    const socket = connect(Number(parsed.port || 6379), parsed.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const client = new RespClient(socket);
    if (parsed.password !== '') {
      const auth = parsed.username === '' ? [] : [decodeURIComponent(parsed.username)];
      await client.command(['AUTH', ...auth, decodeURIComponent(parsed.password)]);
    }
    const db = parsed.pathname.replace('/', '');
    if (db !== '') await client.command(['SELECT', db]);
    return client;
  }

  command(args: readonly string[]): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encode(args));
    });
  }

  readonly evalScript: RedisEvalFn = async (script, keys, args) => {
    const reply = await this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
    if (reply instanceof Error) throw reply;
    return reply;
  };

  async close(): Promise<void> {
    await this.command(['QUIT']).catch(() => undefined);
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

const adapter = (binding: string): CareEdgeAdapter => ({
  kind: 'outbound-sdk',
  classify: (error) => defaultInProcessClassifier(error),
  repeatable: () => false,
  overdueError: (_ctx, timeoutMs) => new TryOverdueError(binding, timeoutMs),
});

/** One engine (a pod): its own runtime and executor over the shared state port. */
function engine(binding: string, policy: (state: CareStatePort) => Care) {
  return (state: CareStatePort) => {
    const runtime = new CareEngine({}, { enabled: false });
    const plan = runtime.plan(binding, [policy(state)], 'outbound-sdk');
    const executor = runtime.executor<string>(plan, adapter(binding));
    return {
      call: (work: () => Promise<string>) =>
        executor.execute({ edge: 'outbound-sdk', binding }, () => work()),
    };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const transient = (): Error => Object.assign(new Error('down'), { retryable: true });

d('resilience shared state on Redis (RE-04, RE-05)', () => {
  const prefix = `estela-e2e-${randomBytes(4).toString('hex')}:`;
  const clients: RespClient[] = [];

  /** A pod's state port: its own connection, the run's key prefix. */
  async function podState(): Promise<CareStatePort> {
    const client = await RespClient.open(url!);
    clients.push(client);
    return redisCareState(client.evalScript, { prefix });
  }

  afterAll(async () => {
    const admin = await RespClient.open(url!);
    await admin.evalScript(
      "for _, k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1",
      [],
      [`${prefix}*`],
    );
    await admin.close();
    for (const client of clients) await client.close();
  });

  it('speaks RESP: integers, bulk strings, nil and arrays', async () => {
    const client = await RespClient.open(url!);
    clients.push(client);
    const key = `${prefix}probe`;
    expect(await client.evalScript("return redis.call('INCRBY', KEYS[1], 2)", [key], [])).toBe(2);
    expect(await client.evalScript("return redis.call('GET', KEYS[1])", [key], [])).toBe('2');
    const missing = await client.evalScript(
      "return redis.call('GET', KEYS[1])",
      [`${key}:none`],
      [],
    );
    expect(missing).toBeNull();
    expect(await client.evalScript("return {1, 'a', {2}}", [], [])).toEqual([1, 'a', [2]]);
    await expect(client.evalScript("return redis.error_reply('boom')", [], [])).rejects.toThrow(
      'boom',
    );
  });

  it('RE-04 two engines share one token bucket under Redis server time', async () => {
    const pod = engine('ratelimit.shared', (state) => ({
      pace: { perSecond: 5, burst: 5, state },
    }));
    const a = pod(await podState());
    const b = pod(await podState());
    const started = Date.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).call(async () => 'ok')),
    );
    const elapsed = Date.now() - started;
    // One token refills every 200 ms; the burst must be the only source of grants here.
    expect(elapsed).toBeLessThan(200);
    const granted = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(granted).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(OverPaceError);
    }
  });

  it('RE-05 shared open marker rejects on the other engine and only one engine holds the probing lease', async () => {
    const shutMs = 400;
    const syncMs = 50;
    const pod = engine('breaker.shared', (state) => ({
      valve: { minCalls: 2, failPercent: 50, shutMs, syncMs, state },
    }));
    const opener = pod(await podState());
    const others = [pod(await podState()), pod(await podState())];
    // Each other pod reads the (still absent) marker once, so its next read is syncMs later.
    for (const other of others)
      await expect(other.call(async () => 'ok')).resolves.toMatchObject({ value: 'ok' });
    for (let i = 0; i < 2; i += 1) {
      await expect(opener.call(() => Promise.reject(transient()))).rejects.toThrow('down');
    }
    await expect(opener.call(async () => 'ok')).rejects.toBeInstanceOf(ValveShutError);
    await sleep(syncMs + 10);
    let ran = 0;
    for (const other of others) {
      await expect(
        other.call(async () => {
          ran += 1;
          return 'ok';
        }),
      ).rejects.toBeInstanceOf(ValveShutError);
    }
    expect(ran).toBe(0);
    await sleep(shutMs + 20);
    let probes = 0;
    const slowProbe = async (): Promise<string> => {
      probes += 1;
      await sleep(100);
      return 'ok';
    };
    const outcomes = await Promise.allSettled(
      [opener, ...others].map((pod) => pod.call(slowProbe)),
    );
    expect(probes).toBe(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === 'rejected')) {
      expect(outcome.reason).toBeInstanceOf(ValveShutError);
    }
  });
});
