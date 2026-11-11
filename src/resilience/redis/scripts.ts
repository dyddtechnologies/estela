/** Server time in ms, so pod clock skew never matters (RS-23). */
const NOW = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

/** Atomic token-bucket refill and take. KEYS[1] bucket; ARGV rate per second, burst. */
export const TAKE_TOKEN_SCRIPT = `${NOW}
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil or at == nil then
  tokens = burst
  at = now
end
tokens = math.min(burst, tokens + math.max(0, now - at) * rate / 1000)
local granted = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  granted = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return {granted, wait}`;

/** Shared open marker with a TTL. KEYS[1] marker; ARGV[1] wall-clock until, ARGV[2] caller now. */
export const MARK_OPEN_SCRIPT = `local ttl = tonumber(ARGV[1]) - tonumber(ARGV[2])
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
return 1`;

export const OPEN_UNTIL_SCRIPT = `return redis.call('GET', KEYS[1])`;

/** Half-open probe lease: one holder per lease period. KEYS[1] lease; ARGV[1] lease ms. */
export const PROBE_LEASE_SCRIPT = `if redis.call('SET', KEYS[1], '1', 'NX', 'PX', tonumber(ARGV[1])) then return 1 end
return 0`;

export const CLEAR_OPEN_SCRIPT = `return redis.call('DEL', KEYS[1], KEYS[2])`;
