import { createClient, type RedisClientType } from "redis";
import { createHash } from "node:crypto";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "apex:omega";
const SNAPSHOT_TTL_MS = Number(process.env.REDIS_OPPORTUNITY_TTL_MS || 120_000);
const EXECUTION_LOCK_TTL_MS = Number(process.env.REDIS_EXECUTION_LOCK_TTL_MS || 45_000);
const CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 600);

type LedgerPayload = Record<string, any>;

let clientPromise: Promise<RedisClientType | null> | null = null;
let lastError: string | null = null;

function redisEnabled() {
  return process.env.REDIS_ENABLED !== "false";
}

function redisUrl() {
  return process.env.REDIS_URL || process.env.APEX_REDIS_URL || DEFAULT_REDIS_URL;
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}MS`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeForJson(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizeForJson(nested)]),
    );
  }
  return value;
}

function json(value: any) {
  return JSON.stringify(normalizeForJson(value));
}

function parseRedisJson(raw: unknown) {
  return typeof raw === "string" && raw ? JSON.parse(raw) : null;
}

function hashPayload(value: any) {
  return createHash("sha256").update(json(value)).digest("hex");
}

function opportunityKey(id: string) {
  return `${KEY_PREFIX}:opportunity:${id}`;
}

function lockKey(id: string) {
  return `${KEY_PREFIX}:opportunity-lock:${id}`;
}

function activeSetKey() {
  return `${KEY_PREFIX}:opportunities:active`;
}

function laneSetKey() {
  return `${KEY_PREFIX}:lanes:events`;
}

export function opportunityId(payload: LedgerPayload) {
  const routeFingerprint = [
    payload.routeId,
    payload.payloadKind,
    payload.pair,
    payload.path,
    payload.venues,
    payload.flashloanAsset,
    payload.flashloanProvider,
    payload.pools,
  ].filter((item) => item !== undefined && item !== null && item !== "").join("|");
  return hashPayload(routeFingerprint || payload);
}

export async function getRedisClient(): Promise<RedisClientType | null> {
  if (!redisEnabled()) return null;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    try {
      const client = createClient({
        url: redisUrl(),
        socket: {
          connectTimeout: CONNECT_TIMEOUT_MS,
          reconnectStrategy: false,
        },
      });
      client.on("error", (error) => {
        lastError = error.message;
      });
      await timeout(client.connect(), CONNECT_TIMEOUT_MS + 250, "REDIS_CONNECT");
      lastError = null;
      return client as RedisClientType;
    } catch (error: any) {
      lastError = error?.message || "Redis connection failed";
      clientPromise = null;
      return null;
    }
  })();

  return clientPromise;
}

export function getRedisLedgerStatus() {
  return {
    enabled: redisEnabled(),
    connected: Boolean(clientPromise) && !lastError,
    url: redisUrl().replace(/\/\/.*@/, "//***@"),
    keyPrefix: KEY_PREFIX,
    lastError,
  };
}

export async function publishOpportunitySnapshot(
  opportunities: LedgerPayload[],
  source: string,
  ttlMs = SNAPSHOT_TTL_MS,
) {
  const client = await getRedisClient();
  const now = Date.now();
  if (!client) {
    return opportunities.map((payload) => ({ ...payload, redisId: opportunityId(payload), redisStatus: "MEMORY_ONLY" }));
  }

  const visible: LedgerPayload[] = [];
  for (const payload of opportunities) {
    const id = opportunityId(payload);
    const isLocked = await client.exists(lockKey(id));
    const existingRaw = await client.hGet(opportunityKey(id), "payload");
    const existing = parseRedisJson(existingRaw);
    const existingStatus = existing?.redisStatus || existing?.executionStatus;
    const preserve =
      isLocked ||
      ["LOCKED_FOR_EXECUTION", "C1_PENDING", "C2_PENDING", "EXECUTING"].includes(existingStatus);
    const record = preserve
      ? { ...existing, redisPreservedDuringScan: true, lastSeenAt: now }
      : {
          ...payload,
          redisId: id,
          redisStatus: "SCANNED_READY",
          source,
          firstSeenAt: existing?.firstSeenAt || now,
          lastSeenAt: now,
          expiresAt: now + ttlMs,
        };
    await client.hSet(opportunityKey(id), { payload: json(record), updatedAt: String(now) });
    await client.pExpire(opportunityKey(id), ttlMs * 3);
    await client.zAdd(activeSetKey(), [{ score: now, value: id }]);
    visible.push(record);
  }

  const staleCutoff = now - ttlMs;
  await client.zRemRangeByScore(activeSetKey(), 0, staleCutoff);
  return visible;
}

export async function getActiveLedgerOpportunities(limit = 100) {
  const client = await getRedisClient();
  if (!client) return null;
  const ids = await client.zRange(activeSetKey(), -limit, -1, { REV: true });
  const rows: LedgerPayload[] = [];
  for (const id of ids) {
    const raw = await client.hGet(opportunityKey(id), "payload");
    if (!raw) continue;
    const parsed = parseRedisJson(raw);
    if (parsed) rows.push(parsed);
  }
  return rows.sort((left, right) => {
    const leftRank = Number(left.rank ?? Number.MAX_SAFE_INTEGER);
    const rightRank = Number(right.rank ?? Number.MAX_SAFE_INTEGER);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return Number(right.profit_usd ?? right.netProfitUsd ?? Number.NEGATIVE_INFINITY) -
      Number(left.profit_usd ?? left.netProfitUsd ?? Number.NEGATIVE_INFINITY);
  });
}

export async function getActiveLedgerCount() {
  const client = await getRedisClient();
  if (!client) return null;
  return await client.zCard(activeSetKey());
}

export async function lockOpportunityForExecution(payload: LedgerPayload, ttlMs = EXECUTION_LOCK_TTL_MS) {
  const client = await getRedisClient();
  const id = opportunityId(payload);
  if (!client) return { ok: true, redis: false, id, reason: "REDIS_UNAVAILABLE_MEMORY_LOCK_ONLY" };
  const lockValue = `${process.pid}:${Date.now()}`;
  const result = await client.set(lockKey(id), lockValue, { NX: true, PX: ttlMs });
  if (result !== "OK") return { ok: false, redis: true, id, reason: "ALREADY_LOCKED_OR_IN_FLIGHT" };
  const record = {
    ...payload,
    redisId: id,
    redisStatus: "LOCKED_FOR_EXECUTION",
    lockedAt: Date.now(),
    lockTtlMs: ttlMs,
  };
  await client.hSet(opportunityKey(id), { payload: json(record), updatedAt: String(Date.now()) });
  await client.zAdd(activeSetKey(), [{ score: Date.now(), value: id }]);
  return { ok: true, redis: true, id, reason: "LOCK_ACQUIRED" };
}

export async function releaseOpportunityLock(id: string, status: string, patch: LedgerPayload = {}) {
  const client = await getRedisClient();
  if (!client) return;
  const raw = await client.hGet(opportunityKey(id), "payload");
  const existing = parseRedisJson(raw) || {};
  const record = {
    ...existing,
    ...patch,
    redisStatus: status,
    releasedAt: Date.now(),
  };
  await client.hSet(opportunityKey(id), { payload: json(record), updatedAt: String(Date.now()) });
  await client.del(lockKey(id));
}

export async function recordLaneEvent(event: LedgerPayload) {
  const client = await getRedisClient();
  if (!client) return;
  const normalized = normalizeForJson(event);
  const fields = Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  await client.xAdd(laneSetKey(), "*", fields);
  await client.xTrim(laneSetKey(), "MAXLEN", 2_000);
}
