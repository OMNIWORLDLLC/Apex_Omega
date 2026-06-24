import "dotenv/config";
import { ethers } from "ethers";
import {
  buildAlgebraExactInputSingleCalldata,
  buildBalancerSingleSwapCalldata,
  buildCurveRouterExchangeCalldata,
  buildStableSwapExchangeCalldata,
  buildV2SwapCalldata,
  buildV3ExactInputSingleCalldata,
  preSendRevalidate,
  quoteAlgebraExactInputSingle,
  quoteBalancerWeighted,
  quoteCurveGetDy,
  quoteStableSwapGetDy,
  quoteV2Cpmm,
  quoteV3ExactInputSingle,
  type InvariantKind,
  type PoolEdge,
  ROUTE_ADAPTER_TARGETS,
} from "../server/engine/routeAdapters.js";
import {
  lockOpportunityForExecution,
  publishOpportunitySnapshot,
  recordLaneEvent,
  releaseOpportunityLock,
} from "../server/redisLedger.js";

const CHAIN_ID = 137n;
const API_BASE = process.env.APEX_API_BASE || "http://127.0.0.1:3000";
const DEFAULT_DISCOVERY_LOOKBACK_BLOCKS = 2_500;
const DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS = 1_000;
const DEFAULT_CURVE_MAX_POOLS = 25;
const DEFAULT_BALANCER_MAX_POOLS = 50;
const DEFAULT_V3_MAX_POOLS = 75;
const DEFAULT_ALGEBRA_MAX_POOLS = 75;
const DEFAULT_ROUTE_MAX_CYCLES = 500;
const DEFAULT_DISCOVERY_CONCURRENCY = 16;
const DEFAULT_QUOTE_LANES = 32;
const DEFAULT_RPC_CALL_TIMEOUT_MS = 8_000;
const DEFAULT_ROUTE_MAX_STATE_AGE_BLOCKS = 128;
const DEFAULT_TOP_ROUTE_DISPLAY_LIMIT = 50;
const DEFAULT_C1_EXECUTABLE_LIMIT = 10;
const AAVE_V3_POOL = process.env.AAVE_V3_POOL_ADDRESS || "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const DEFAULT_C1_TARGET = process.env.C1_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || process.env.EXECUTOR_ADDRESS || "";
const ZERO_ADDRESS = ethers.ZeroAddress;

const AAVE_POOL_ABI = [
  "function getReservesList() view returns (address[])",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  "function getPair(address,address) view returns (address)",
];
const V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  "function getPool(address,address,uint24) view returns (address)",
];
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
];
const ALGEBRA_FACTORY_ABI = [
  "event Pool(address indexed token0,address indexed token1,address pool)",
  "function poolByPair(address,address) view returns (address)",
];
const ALGEBRA_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)",
];
const CURVE_ADDRESS_PROVIDER_ABI = [
  "function get_registry() view returns (address)",
];
const CURVE_REGISTRY_ABI = [
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256 index) view returns (address)",
  "function get_coins(address pool) view returns (address[8])",
  "function get_balances(address pool) view returns (uint256[8])",
];
const BALANCER_VAULT_ABI = [
  "event PoolRegistered(bytes32 indexed poolId,address indexed poolAddress,uint8 specialization)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
];
const BALANCER_WEIGHTED_POOL_ABI = [
  "function getNormalizedWeights() view returns (uint256[])",
  "function getSwapFeePercentage() view returns (uint256)",
];
const VM_ABI = [
  "function globalNonce() view returns (uint256)",
];

type TokenMeta = {
  chainId: 137;
  address: string;
  symbol: string;
  decimals: number;
  priceUsd?: number;
  flashloanEligible: boolean;
};

type FlashloanProviderId = "BALANCER_V2_VAULT" | "AAVE_V3_POOL";

type FlashloanLiquidity = {
  provider: FlashloanProviderId;
  sourceCode: number;
  providerAddress: string;
  asset: TokenMeta;
  liquidity: bigint;
  feeBps: bigint;
};

type Edge = PoolEdge & {
  edgeId: string;
  venueName: string;
  router: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInPriceUsd?: number;
  tokenOutPriceUsd?: number;
  extra?: {
    v3Fee?: number;
    curveIndexType?: "int128" | "uint256";
    balancerWeightIn?: bigint;
    balancerWeightOut?: bigint;
    balancerSwapFeeBps?: bigint;
  };
};

type RouteQuoteStep = {
  edge: Edge;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  calldata: string;
};

type Candidate = {
  rank?: number;
  routeId: string;
  status: "EXECUTABLE_PROFIT_CANDIDATE" | "REJECTED_NO_PROFIT" | "REJECTED_ROUTE_INVALID";
  flashloanAsset: TokenMeta;
  flashloanLiquidity: FlashloanLiquidity;
  path: TokenMeta[];
  steps: RouteQuoteStep[];
  amountIn: bigint;
  amountOut: bigint;
  grossProfitRaw: bigint;
  grossProfitUsd?: number;
  gasCostUsd?: number;
  flashFeeRaw: bigint;
  flashFeeUsd?: number;
  netProfitUsd?: number;
  lowestPoolTvlUsd: number;
  rejectionReason: string;
  c1ExecutionEligible?: boolean;
  c1ExecutionSlot?: number;
};

type ReverseRouteMetadata = {
  available: boolean;
  error?: string;
  reverseFlashloanSource?: number;
  reverseFlashloanAsset?: string;
  reverseFlashloanAmount?: string;
  reverseContext?: any;
  reversePath?: string;
  reverseVenues?: string;
  sizingRule?: string;
};

type DiscoveryStats = {
  flashloanAssets: number;
  flashloanBalancerAssets: number;
  flashloanAaveAssets: number;
  tokens: number;
  discoveredEdges: number;
  discoveredPools: number;
  rejectedDuplicateEdge: number;
  rejectedMetadata: number;
  rejectedZeroLiquidity: number;
  rejectedUnsupportedInvariant: number;
  rejectedLogScan: number;
  rejectedPreSend: number;
  routeCyclesEnumerated: number;
  routeCyclesRejectedRepeatedPool: number;
  routeCyclesRejectedNonFlashloan: number;
  routeCyclesRejectedQuote: number;
  truncated: boolean;
  sourceCounts: Record<string, number>;
};

function rpcUrl() {
  return process.env.POLYGON_RPC_URL || process.env.POLYGON_RPC || process.env.RPC_URL || "https://polygon-rpc.com";
}

function intEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalIntEnv(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalize(address: string) {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return ethers.getAddress(address.toLowerCase());
  }
  return ethers.getAddress(address);
}

function sameAddress(left: string, right: string) {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function rawToFloat(raw: bigint, decimals: number) {
  return Number(ethers.formatUnits(raw, decimals));
}

function floatToRaw(value: number, decimals: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const scale = 10 ** Math.min(decimals, 12);
  const truncated = Math.floor(value * scale) / scale;
  return ethers.parseUnits(truncated.toFixed(Math.min(decimals, 12)), decimals);
}

function bpsMin(amount: bigint, slippageBps: bigint) {
  if (amount <= 0n) return 0n;
  const keepBps = 10000n - slippageBps;
  return amount * keepBps / 10000n;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${timeoutMs}MS`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function usdStableSeed(symbol: string) {
  const upper = symbol.toUpperCase();
  if (upper === "USDC" || upper === "USDC.E" || upper === "USDT" || upper === "DAI") return 1;
  return undefined;
}

function quoteUsd(raw: bigint, token: TokenMeta) {
  if (!token.priceUsd) return undefined;
  return rawToFloat(raw, token.decimals) * token.priceUsd;
}

function parseSourceList(envName: string, fallback: string) {
  return (process.env[envName] || fallback)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(":").map((part) => part.trim()));
}

async function getJson(path: string) {
  const response = await fetch(`${API_BASE}${path}`);
  return await response.json();
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return { status: response.status, json: await response.json() };
}

async function safeGetLogs(
  provider: ethers.JsonRpcProvider,
  filter: Omit<ethers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
) {
  const logs: ethers.Log[] = [];
  let rejected = 0;
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    try {
      logs.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
    } catch {
      rejected += 1;
    }
  }
  return { logs, rejected };
}

async function loadTokenMeta(provider: ethers.JsonRpcProvider, cache: Map<string, TokenMeta>, address: string, flashloanEligible = false) {
  const normalized = normalize(address);
  const cached = cache.get(normalized.toLowerCase());
  if (cached) {
    cached.flashloanEligible = cached.flashloanEligible || flashloanEligible;
    return cached;
  }
  const token = new ethers.Contract(normalized, ERC20_ABI, provider);
  const [symbolResult, decimalsResult] = await Promise.allSettled([token.symbol(), token.decimals()]);
  if (symbolResult.status !== "fulfilled" || decimalsResult.status !== "fulfilled") {
    throw new Error(`TOKEN_METADATA_UNRESOLVED:${normalized}`);
  }
  const meta: TokenMeta = {
    chainId: 137,
    address: normalized,
    symbol: String(symbolResult.value),
    decimals: Number(decimalsResult.value),
    priceUsd: usdStableSeed(String(symbolResult.value)),
    flashloanEligible,
  };
  cache.set(normalized.toLowerCase(), meta);
  return meta;
}

async function discoverFlashloanAssets(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>) {
  const pool = new ethers.Contract(normalize(AAVE_V3_POOL), AAVE_POOL_ABI, provider);
  const reserves = await pool.getReservesList() as string[];
  const assets: TokenMeta[] = [];
  for (const reserve of reserves) {
    try {
      assets.push(await loadTokenMeta(provider, tokenCache, reserve, true));
    } catch {
      // Token metadata failure means this reserve cannot safely anchor a live route.
    }
  }
  return assets;
}

async function tokenBalance(provider: ethers.JsonRpcProvider, tokenAddress: string, holder: string) {
  const token = new ethers.Contract(normalize(tokenAddress), ERC20_ABI, provider);
  return BigInt(await token.balanceOf(normalize(holder)));
}

async function discoverAaveFlashloanLiquidity(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>) {
  const poolAddress = normalize(AAVE_V3_POOL);
  const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
  const reserves = await pool.getReservesList() as string[];
  const liquidity: FlashloanLiquidity[] = [];
  for (const reserve of reserves) {
    try {
      const asset = await loadTokenMeta(provider, tokenCache, reserve, true);
      const available = await tokenBalance(provider, asset.address, poolAddress).catch(() => 0n);
      if (available <= 0n) continue;
      liquidity.push({
        provider: "AAVE_V3_POOL",
        sourceCode: 1,
        providerAddress: poolAddress,
        asset,
        liquidity: available,
        feeBps: BigInt(Math.floor(numberEnv("FLASH_LOAN_FEE_BPS", 9))),
      });
    } catch {
      // Unresolved reserve metadata cannot anchor a live flashloan route.
    }
  }
  return liquidity;
}

async function discoverBalancerFlashloanLiquidity(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, latestBlock: number) {
  const vaultAddress = normalize(ROUTE_ADAPTER_TARGETS.balancerVault);
  const lookback = intEnv("LIVE_BALANCER_LOOKBACK_BLOCKS", intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS));
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(BALANCER_VAULT_ABI);
  const topic = iface.getEvent("PoolRegistered")?.topicHash;
  const assetSet = new Set<string>();
  for (const token of tokenCache.values()) {
    if (token.flashloanEligible) assetSet.add(token.address.toLowerCase());
  }
  for (const token of (process.env.FLASHLOAN_ASSET_TOKENS || "").split(",").map((item) => item.trim()).filter(Boolean)) {
    try {
      assetSet.add(normalize(token).toLowerCase());
    } catch {
      // Ignore invalid operator-provided token addresses.
    }
  }
  if (topic) {
    const scan = await safeGetLogs(provider, { address: vaultAddress, topics: [topic] }, fromBlock, latestBlock, chunk);
    const vault = new ethers.Contract(vaultAddress, BALANCER_VAULT_ABI, provider);
    for (const log of scan.logs) {
      try {
        const parsed = iface.parseLog(log);
        const poolId = parsed?.args?.poolId as string;
        const poolTokens = await vault.getPoolTokens(poolId);
        for (const token of poolTokens.tokens as string[]) {
          if (token && token !== ZERO_ADDRESS) assetSet.add(normalize(token).toLowerCase());
        }
      } catch {
        // Ignore malformed pool records; liquidity is discovered again through arb pool validation.
      }
    }
  }

  const liquidity: FlashloanLiquidity[] = [];
  for (const tokenAddress of assetSet) {
    try {
      const asset = await loadTokenMeta(provider, tokenCache, tokenAddress, true);
      const available = await tokenBalance(provider, asset.address, vaultAddress).catch(() => 0n);
      if (available <= 0n) continue;
      liquidity.push({
        provider: "BALANCER_V2_VAULT",
        sourceCode: 2,
        providerAddress: vaultAddress,
        asset,
        liquidity: available,
        feeBps: BigInt(Math.floor(numberEnv("BALANCER_FLASH_FEE_BPS", 0))),
      });
    } catch {
      // Token metadata failure means this token is not live-executable.
    }
  }
  return liquidity;
}

async function discoverFlashloanLiquidity(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, latestBlock: number) {
  const aave = await discoverAaveFlashloanLiquidity(provider, tokenCache).catch(() => [] as FlashloanLiquidity[]);
  const balancer = await discoverBalancerFlashloanLiquidity(provider, tokenCache, latestBlock).catch(() => [] as FlashloanLiquidity[]);
  const byAsset = new Map<string, FlashloanLiquidity[]>();
  for (const item of [...balancer, ...aave]) {
    const key = item.asset.address.toLowerCase();
    const list = byAsset.get(key) || [];
    list.push(item);
    byAsset.set(key, list.sort((a, b) => a.provider === "BALANCER_V2_VAULT" ? -1 : b.provider === "BALANCER_V2_VAULT" ? 1 : Number(a.feeBps - b.feeBps)));
  }
  return {
    ordered: Array.from(byAsset.values()).flat(),
    byAsset,
    balancer,
    aave,
  };
}

function addEdge(edges: Map<string, Edge>, stats: DiscoveryStats, edge: Edge) {
  const key = `${edge.dexId}:${edge.poolAddress}:${edge.tokenIn}:${edge.tokenOut}:${edge.invariant}:${edge.feeBps}:${edge.tokenInIndex ?? ""}:${edge.tokenOutIndex ?? ""}`.toLowerCase();
  if (edges.has(key)) {
    stats.rejectedDuplicateEdge += 1;
    return;
  }
  edges.set(key, edge);
  stats.sourceCounts[edge.dexId] = (stats.sourceCounts[edge.dexId] || 0) + 1;
}

function edgeBase(params: {
  dexId: string;
  venueName: string;
  poolAddress: string;
  router: string;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  invariant: InvariantKind;
  feeBps: number;
  reserveIn: bigint;
  reserveOut: bigint;
  tvlUsd: number;
  stateBlock: number;
  quoteAdapter: string;
  calldataAdapter: string;
  executorTarget: string;
  poolId?: string;
  tokenInIndex?: number;
  tokenOutIndex?: number;
  extra?: Edge["extra"];
}): Edge {
  return {
    chainId: 137,
    dexId: params.dexId,
    venueName: params.venueName,
    poolAddress: normalize(params.poolAddress),
    poolId: params.poolId,
    tokenIn: params.tokenIn.address,
    tokenOut: params.tokenOut.address,
    tokenInIndex: params.tokenInIndex,
    tokenOutIndex: params.tokenOutIndex,
    tokenInDecimals: params.tokenIn.decimals,
    tokenOutDecimals: params.tokenOut.decimals,
    tokenInSymbol: params.tokenIn.symbol,
    tokenOutSymbol: params.tokenOut.symbol,
    tokenInPriceUsd: params.tokenIn.priceUsd,
    tokenOutPriceUsd: params.tokenOut.priceUsd,
    invariant: params.invariant,
    feeBps: params.feeBps,
    reserveIn: params.reserveIn,
    reserveOut: params.reserveOut,
    tvlUsd: params.tvlUsd,
    stateBlock: params.stateBlock,
    quoteAdapter: params.quoteAdapter,
    calldataAdapter: params.calldataAdapter,
    executorTarget: normalize(params.executorTarget),
    router: normalize(params.router),
    edgeId: `${params.dexId}:${normalize(params.poolAddress)}:${params.tokenIn.symbol}->${params.tokenOut.symbol}`,
    extra: params.extra,
  };
}

function estimateTvlUsd(tokenA: TokenMeta, reserveA: bigint, tokenB: TokenMeta, reserveB: bigint) {
  const left = tokenA.priceUsd ? rawToFloat(reserveA, tokenA.decimals) * tokenA.priceUsd : undefined;
  const right = tokenB.priceUsd ? rawToFloat(reserveB, tokenB.decimals) * tokenB.priceUsd : undefined;
  if (left !== undefined && right !== undefined) return left + right;
  if (left !== undefined) return left * 2;
  if (right !== undefined) return right * 2;
  return 0;
}

async function addV2Pair(
  provider: ethers.JsonRpcProvider,
  tokenCache: Map<string, TokenMeta>,
  edges: Map<string, Edge>,
  stats: DiscoveryStats,
  venueName: string,
  dexId: string,
  router: string,
  pairAddress: string,
  feeBps: number,
  stateBlock: number,
) {
  const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
  const [token0Raw, token1Raw, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  const token0 = await loadTokenMeta(provider, tokenCache, token0Raw).catch(() => undefined);
  const token1 = await loadTokenMeta(provider, tokenCache, token1Raw).catch(() => undefined);
  if (!token0 || !token1) {
    stats.rejectedMetadata += 1;
    return;
  }
  const reserve0 = BigInt(reserves.reserve0);
  const reserve1 = BigInt(reserves.reserve1);
  if (reserve0 <= 0n || reserve1 <= 0n) {
    stats.rejectedZeroLiquidity += 1;
    return;
  }
  const tvlUsd = estimateTvlUsd(token0, reserve0, token1, reserve1);
  addEdge(edges, stats, edgeBase({
    dexId,
    venueName,
    poolAddress: pairAddress,
    router,
    tokenIn: token0,
    tokenOut: token1,
    invariant: "V2_CPMM",
    feeBps,
    reserveIn: reserve0,
    reserveOut: reserve1,
    tvlUsd,
    stateBlock,
    quoteAdapter: "quoteV2Cpmm",
    calldataAdapter: "buildV2SwapCalldata",
    executorTarget: router,
  }));
  addEdge(edges, stats, edgeBase({
    dexId,
    venueName,
    poolAddress: pairAddress,
    router,
    tokenIn: token1,
    tokenOut: token0,
    invariant: "V2_CPMM",
    feeBps,
    reserveIn: reserve1,
    reserveOut: reserve0,
    tvlUsd,
    stateBlock,
    quoteAdapter: "quoteV2Cpmm",
    calldataAdapter: "buildV2SwapCalldata",
    executorTarget: router,
  }));
}

async function discoverV2(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number, flashloanAssets: TokenMeta[]) {
  const sources = parseSourceList(
    "LIVE_DISCOVERY_V2_FACTORIES",
    "QuickSwapV2:0x5757371414417b8c6caad45baef941abc7d3ab32:0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff:30;SushiSwapV2:0xc35DADB65012eC5796536bD9864eD8773aBc74C4:0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506:30",
  );
  const lookback = intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS);
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(V2_FACTORY_ABI);
  const topic = iface.getEvent("PairCreated")?.topicHash;

  for (const [venueName, factoryAddress, router, feeRaw] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const scan = topic
      ? await safeGetLogs(provider, { address: normalize(factoryAddress), topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    for (const log of scan.logs) {
      try {
        const parsed = iface.parseLog(log);
        const pair = normalize(parsed?.args?.pair);
        if (seen.has(pair.toLowerCase())) continue;
        seen.add(pair.toLowerCase());
        await addV2Pair(provider, tokenCache, edges, stats, venueName, dexId, router, pair, Number(feeRaw || 30), latestBlock);
      } catch {
        stats.rejectedMetadata += 1;
      }
    }

    const assetPairs: Array<[TokenMeta, TokenMeta]> = [];
    for (let i = 0; i < flashloanAssets.length; i += 1) {
      for (let j = i + 1; j < flashloanAssets.length; j += 1) {
        assetPairs.push([flashloanAssets[i], flashloanAssets[j]]);
      }
    }
    await runWithConcurrency(assetPairs, intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right]) => {
        try {
          const pair = normalize(await factory.getPair(left.address, right.address));
          if (pair === ZERO_ADDRESS || seen.has(pair.toLowerCase())) return;
          seen.add(pair.toLowerCase());
          await addV2Pair(provider, tokenCache, edges, stats, venueName, dexId, router, pair, Number(feeRaw || 30), latestBlock);
        } catch {
          stats.rejectedMetadata += 1;
        }
    });
  }
}

async function addV3Pool(
  provider: ethers.JsonRpcProvider,
  tokenCache: Map<string, TokenMeta>,
  edges: Map<string, Edge>,
  stats: DiscoveryStats,
  venueName: string,
  dexId: string,
  router: string,
  poolAddress: string,
  fee: number,
  stateBlock: number,
) {
  const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
  const [token0Raw, token1Raw, liquidity, slot0] = await Promise.all([pool.token0(), pool.token1(), pool.liquidity(), pool.slot0()]);
  if (BigInt(liquidity) <= 0n || BigInt(slot0.sqrtPriceX96) <= 0n || slot0.unlocked === false) {
    stats.rejectedZeroLiquidity += 1;
    return;
  }
  const token0 = await loadTokenMeta(provider, tokenCache, token0Raw).catch(() => undefined);
  const token1 = await loadTokenMeta(provider, tokenCache, token1Raw).catch(() => undefined);
  if (!token0 || !token1) {
    stats.rejectedMetadata += 1;
    return;
  }
  const syntheticReserve = BigInt(liquidity);
  const tvlUsd = 0;
  const feeBps = Math.max(1, Math.floor(fee / 100));
  for (const [tokenIn, tokenOut] of [[token0, token1], [token1, token0]] as const) {
    addEdge(edges, stats, edgeBase({
      dexId,
      venueName,
      poolAddress,
      router,
      tokenIn,
      tokenOut,
      invariant: "V3_CONCENTRATED_LIQUIDITY",
      feeBps,
      reserveIn: syntheticReserve,
      reserveOut: syntheticReserve,
      tvlUsd,
      stateBlock,
      quoteAdapter: "quoteV3ExactInputSingle",
      calldataAdapter: "buildV3ExactInputSingleCalldata",
      executorTarget: router,
      extra: { v3Fee: fee },
    }));
  }
}

async function discoverV3(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number, flashloanAssets: TokenMeta[]) {
  const sources = parseSourceList(
    "LIVE_DISCOVERY_V3_FACTORIES",
    `UniswapV3:0x1F98431c8aD98523631AE4a59f267346ea31F984:${ROUTE_ADAPTER_TARGETS.uniswapV3Router}:${ROUTE_ADAPTER_TARGETS.uniswapV3Quoter}:100,500,3000,10000`,
  );
  const lookback = intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS);
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(V3_FACTORY_ABI);
  const topic = iface.getEvent("PoolCreated")?.topicHash;

  for (const [venueName, factoryAddress, router, , feeListRaw] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const maxPools = intEnv("LIVE_V3_MAX_POOLS", DEFAULT_V3_MAX_POOLS);
    const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
    const scan = topic
      ? await safeGetLogs(provider, { address: normalize(factoryAddress), topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    for (const log of scan.logs) {
      if (seen.size >= maxPools) break;
      try {
        const parsed = iface.parseLog(log);
        const pool = normalize(parsed?.args?.pool);
        if (seen.has(pool.toLowerCase())) continue;
        seen.add(pool.toLowerCase());
        await withTimeout(
          addV3Pool(provider, tokenCache, edges, stats, venueName, dexId, router, pool, Number(parsed?.args?.fee), latestBlock),
          callTimeoutMs * 2,
          "V3_ADD_POOL",
        );
      } catch {
        stats.rejectedMetadata += 1;
      }
    }

    const fees = (feeListRaw || "100,500,3000,10000").split(",").map((fee) => Number(fee.trim())).filter(Number.isFinite);
    const poolQueries: Array<[TokenMeta, TokenMeta, number]> = [];
    for (let i = 0; i < flashloanAssets.length; i += 1) {
      for (let j = i + 1; j < flashloanAssets.length; j += 1) {
        for (const fee of fees) {
          poolQueries.push([flashloanAssets[i], flashloanAssets[j], fee]);
        }
      }
    }
    await runWithConcurrency(poolQueries, intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right, fee]) => {
          if (seen.size >= maxPools) return;
          try {
            const pool = normalize(await withTimeout(
              factory.getPool(left.address, right.address, fee) as Promise<string>,
              callTimeoutMs,
              "V3_GET_POOL",
            ));
            if (pool === ZERO_ADDRESS || seen.has(pool.toLowerCase())) return;
            if (seen.size >= maxPools) return;
            seen.add(pool.toLowerCase());
            await withTimeout(
              addV3Pool(provider, tokenCache, edges, stats, venueName, dexId, router, pool, fee, latestBlock),
              callTimeoutMs * 2,
              "V3_ADD_POOL",
            );
          } catch {
            stats.rejectedMetadata += 1;
          }
    });
  }
}

async function addAlgebraPool(
  provider: ethers.JsonRpcProvider,
  tokenCache: Map<string, TokenMeta>,
  edges: Map<string, Edge>,
  stats: DiscoveryStats,
  venueName: string,
  dexId: string,
  router: string,
  poolAddress: string,
  stateBlock: number,
) {
  const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
  const [token0Raw, token1Raw, liquidity, globalState] = await Promise.all([pool.token0(), pool.token1(), pool.liquidity(), pool.globalState()]);
  if (BigInt(liquidity) <= 0n || BigInt(globalState.price) <= 0n || globalState.unlocked === false) {
    stats.rejectedZeroLiquidity += 1;
    return;
  }
  const token0 = await loadTokenMeta(provider, tokenCache, token0Raw).catch(() => undefined);
  const token1 = await loadTokenMeta(provider, tokenCache, token1Raw).catch(() => undefined);
  if (!token0 || !token1) {
    stats.rejectedMetadata += 1;
    return;
  }
  const syntheticReserve = BigInt(liquidity);
  const feeBps = Math.max(1, Math.floor(Number(globalState.fee) / 100));
  for (const [tokenIn, tokenOut] of [[token0, token1], [token1, token0]] as const) {
    addEdge(edges, stats, edgeBase({
      dexId,
      venueName,
      poolAddress,
      router,
      tokenIn,
      tokenOut,
      invariant: "ALGEBRA_CONCENTRATED_LIQUIDITY",
      feeBps,
      reserveIn: syntheticReserve,
      reserveOut: syntheticReserve,
      tvlUsd: 0,
      stateBlock,
      quoteAdapter: "quoteAlgebraExactInputSingle",
      calldataAdapter: "buildAlgebraExactInputSingleCalldata",
      executorTarget: router,
    }));
  }
}

async function discoverAlgebra(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number, flashloanAssets: TokenMeta[]) {
  const sources = parseSourceList(
    "LIVE_DISCOVERY_ALGEBRA_FACTORIES",
    `QuickSwapAlgebra:${ROUTE_ADAPTER_TARGETS.algebraFactory}:${ROUTE_ADAPTER_TARGETS.algebraRouter}:${ROUTE_ADAPTER_TARGETS.algebraQuoter}`,
  );
  const lookback = intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS);
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(ALGEBRA_FACTORY_ABI);
  const topic = iface.getEvent("Pool")?.topicHash;

  for (const [venueName, factoryAddress, router] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, ALGEBRA_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const maxPools = intEnv("LIVE_ALGEBRA_MAX_POOLS", DEFAULT_ALGEBRA_MAX_POOLS);
    const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
    const scan = topic
      ? await safeGetLogs(provider, { address: normalize(factoryAddress), topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    for (const log of scan.logs) {
      if (seen.size >= maxPools) break;
      try {
        const parsed = iface.parseLog(log);
        const pool = normalize(parsed?.args?.pool);
        if (seen.has(pool.toLowerCase())) continue;
        seen.add(pool.toLowerCase());
        await withTimeout(
          addAlgebraPool(provider, tokenCache, edges, stats, venueName, dexId, router, pool, latestBlock),
          callTimeoutMs * 2,
          "ALGEBRA_ADD_POOL",
        );
      } catch {
        stats.rejectedMetadata += 1;
      }
    }
    const assetPairs: Array<[TokenMeta, TokenMeta]> = [];
    for (let i = 0; i < flashloanAssets.length; i += 1) {
      for (let j = i + 1; j < flashloanAssets.length; j += 1) {
        assetPairs.push([flashloanAssets[i], flashloanAssets[j]]);
      }
    }
    await runWithConcurrency(assetPairs, intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right]) => {
        if (seen.size >= maxPools) return;
        try {
          const pool = normalize(await withTimeout(
            factory.poolByPair(left.address, right.address) as Promise<string>,
            callTimeoutMs,
            "ALGEBRA_POOL_BY_PAIR",
          ));
          if (pool === ZERO_ADDRESS || seen.has(pool.toLowerCase())) return;
          if (seen.size >= maxPools) return;
          seen.add(pool.toLowerCase());
          await withTimeout(
            addAlgebraPool(provider, tokenCache, edges, stats, venueName, dexId, router, pool, latestBlock),
            callTimeoutMs * 2,
            "ALGEBRA_ADD_POOL",
          );
        } catch {
          stats.rejectedMetadata += 1;
        }
    });
  }
}

async function discoverCurve(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number) {
  const addressProvider = process.env.CURVE_ADDRESS_PROVIDER || "0x0000000022D53366457F9d5E68Ec105046FC4383";
  const maxPools = intEnv("LIVE_CURVE_MAX_POOLS", DEFAULT_CURVE_MAX_POOLS);
  try {
    const providerContract = new ethers.Contract(addressProvider, CURVE_ADDRESS_PROVIDER_ABI, provider);
    const registryAddress = process.env.CURVE_REGISTRY || await providerContract.get_registry();
    const registry = new ethers.Contract(registryAddress, CURVE_REGISTRY_ABI, provider);
    const poolCount = Number(await registry.pool_count());
    const limit = maxPools === undefined ? poolCount : Math.min(poolCount, maxPools);
    for (let index = 0; index < limit; index += 1) {
      try {
        const poolAddress = normalize(await registry.pool_list(index));
        const [coinsRaw, balancesRaw] = await Promise.all([registry.get_coins(poolAddress), registry.get_balances(poolAddress)]);
        const coins = (coinsRaw as string[]).filter((coin) => coin && coin !== ZERO_ADDRESS);
        const balances = balancesRaw as bigint[];
        const metas: TokenMeta[] = [];
        for (const coin of coins) metas.push(await loadTokenMeta(provider, tokenCache, coin));
        for (let i = 0; i < metas.length; i += 1) {
          for (let j = 0; j < metas.length; j += 1) {
            if (i === j) continue;
            const reserveIn = BigInt(balances[i] || 0n);
            const reserveOut = BigInt(balances[j] || 0n);
            if (reserveIn <= 0n || reserveOut <= 0n) {
              stats.rejectedZeroLiquidity += 1;
              continue;
            }
            const tvlUsd = estimateTvlUsd(metas[i], reserveIn, metas[j], reserveOut);
            addEdge(edges, stats, edgeBase({
              dexId: "CURVE",
              venueName: "Curve",
              poolAddress,
              router: ROUTE_ADAPTER_TARGETS.curveRouter,
              tokenIn: metas[i],
              tokenOut: metas[j],
              tokenInIndex: i,
              tokenOutIndex: j,
              invariant: "CURVE_STABLE_SWAP",
              feeBps: 4,
              reserveIn,
              reserveOut,
              tvlUsd,
              stateBlock: latestBlock,
              quoteAdapter: "quoteCurveGetDy",
              calldataAdapter: "buildCurveRouterExchangeCalldata",
              executorTarget: ROUTE_ADAPTER_TARGETS.curveRouter,
              extra: { curveIndexType: "int128" },
            }));
          }
        }
      } catch {
        stats.rejectedMetadata += 1;
      }
    }
  } catch {
    stats.rejectedUnsupportedInvariant += 1;
  }
}

async function discoverBalancer(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number) {
  const vaultAddress = ROUTE_ADAPTER_TARGETS.balancerVault;
  const lookback = intEnv("LIVE_BALANCER_LOOKBACK_BLOCKS", intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS));
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const maxPools = intEnv("LIVE_BALANCER_MAX_POOLS", DEFAULT_BALANCER_MAX_POOLS);
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(BALANCER_VAULT_ABI);
  const topic = iface.getEvent("PoolRegistered")?.topicHash;
  if (!topic) return;
  const scan = await safeGetLogs(provider, { address: normalize(vaultAddress), topics: [topic] }, fromBlock, latestBlock, chunk);
  stats.rejectedLogScan += scan.rejected;
  const vault = new ethers.Contract(vaultAddress, BALANCER_VAULT_ABI, provider);
  let count = 0;
  for (const log of scan.logs) {
    if (maxPools !== undefined && count >= maxPools) break;
    try {
      const parsed = iface.parseLog(log);
      const poolId = parsed?.args?.poolId as string;
      const poolAddress = normalize(parsed?.args?.poolAddress);
      const weightedPool = new ethers.Contract(poolAddress, BALANCER_WEIGHTED_POOL_ABI, provider);
      const [poolTokens, weights, swapFee] = await Promise.all([vault.getPoolTokens(poolId), weightedPool.getNormalizedWeights(), weightedPool.getSwapFeePercentage()]);
      const tokens = poolTokens.tokens as string[];
      const balances = poolTokens.balances as bigint[];
      const metas: TokenMeta[] = [];
      for (const token of tokens) metas.push(await loadTokenMeta(provider, tokenCache, token));
      count += 1;
      for (let i = 0; i < metas.length; i += 1) {
        for (let j = 0; j < metas.length; j += 1) {
          if (i === j) continue;
          const reserveIn = BigInt(balances[i] || 0n);
          const reserveOut = BigInt(balances[j] || 0n);
          const weightIn = BigInt(weights[i] || 0n);
          const weightOut = BigInt(weights[j] || 0n);
          if (reserveIn <= 0n || reserveOut <= 0n || weightIn <= 0n || weightOut <= 0n) {
            stats.rejectedZeroLiquidity += 1;
            continue;
          }
          const tvlUsd = estimateTvlUsd(metas[i], reserveIn, metas[j], reserveOut);
          addEdge(edges, stats, edgeBase({
            dexId: "BALANCER_WEIGHTED",
            venueName: "BalancerWeighted",
            poolAddress,
            poolId,
            router: vaultAddress,
            tokenIn: metas[i],
            tokenOut: metas[j],
            tokenInIndex: i,
            tokenOutIndex: j,
            invariant: "BALANCER_WEIGHTED",
            feeBps: Number(BigInt(swapFee) * 10000n / 10n ** 18n),
            reserveIn,
            reserveOut,
            tvlUsd,
            stateBlock: latestBlock,
            quoteAdapter: "quoteBalancerWeighted",
            calldataAdapter: "buildBalancerSingleSwapCalldata",
            executorTarget: vaultAddress,
            extra: {
              balancerWeightIn: weightIn,
              balancerWeightOut: weightOut,
              balancerSwapFeeBps: BigInt(swapFee) * 10000n / 10n ** 18n,
            },
          }));
        }
      }
    } catch {
      stats.rejectedMetadata += 1;
    }
  }
}

async function derivePrices(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Edge[]) {
  for (const token of tokenCache.values()) {
    const seed = usdStableSeed(token.symbol);
    if (seed) token.priceUsd = seed;
  }

  let changed = true;
  for (let pass = 0; pass < 4 && changed; pass += 1) {
    changed = false;
    for (const edge of edges) {
      const tokenIn = tokenCache.get(edge.tokenIn.toLowerCase());
      const tokenOut = tokenCache.get(edge.tokenOut.toLowerCase());
      if (!tokenIn || !tokenOut) continue;
      if (tokenIn.priceUsd && !tokenOut.priceUsd && edge.reserveIn > 0n && edge.reserveOut > 0n) {
        tokenOut.priceUsd = rawToFloat(edge.reserveIn, tokenIn.decimals) * tokenIn.priceUsd / rawToFloat(edge.reserveOut, tokenOut.decimals);
        changed = true;
      } else if (!tokenIn.priceUsd && tokenOut.priceUsd && edge.reserveIn > 0n && edge.reserveOut > 0n) {
        tokenIn.priceUsd = rawToFloat(edge.reserveOut, tokenOut.decimals) * tokenOut.priceUsd / rawToFloat(edge.reserveIn, tokenIn.decimals);
        changed = true;
      }
    }
  }

  for (const edge of edges) {
    const tokenIn = tokenCache.get(edge.tokenIn.toLowerCase());
    const tokenOut = tokenCache.get(edge.tokenOut.toLowerCase());
    edge.tokenInPriceUsd = tokenIn?.priceUsd;
    edge.tokenOutPriceUsd = tokenOut?.priceUsd;
    if (tokenIn && tokenOut && edge.tvlUsd <= 0) {
      edge.tvlUsd = estimateTvlUsd(tokenIn, edge.reserveIn, tokenOut, edge.reserveOut);
    }
  }
}

async function discoverGraph(provider: ethers.JsonRpcProvider) {
  console.log("LIVE_CYCLE_PHASE|phase=DISCOVERY_GRAPH_START");
  const latestBlock = await provider.getBlockNumber();
  const tokenCache = new Map<string, TokenMeta>();
  const stats: DiscoveryStats = {
    flashloanAssets: 0,
    flashloanBalancerAssets: 0,
    flashloanAaveAssets: 0,
    tokens: 0,
    discoveredEdges: 0,
    discoveredPools: 0,
    rejectedDuplicateEdge: 0,
    rejectedMetadata: 0,
    rejectedZeroLiquidity: 0,
    rejectedUnsupportedInvariant: 0,
    rejectedLogScan: 0,
    rejectedPreSend: 0,
    routeCyclesEnumerated: 0,
    routeCyclesRejectedRepeatedPool: 0,
    routeCyclesRejectedNonFlashloan: 0,
    routeCyclesRejectedQuote: 0,
    truncated: false,
    sourceCounts: {},
  };
  console.log(`LIVE_CYCLE_PHASE|phase=FLASHLOAN_LIQUIDITY_START|block=${latestBlock}`);
  const flashloanBook = await discoverFlashloanLiquidity(provider, tokenCache, latestBlock);
  const flashloanAssets = Array.from(new Map(flashloanBook.ordered.map((item) => [item.asset.address.toLowerCase(), item.asset])).values());
  stats.flashloanAssets = flashloanAssets.length;
  stats.flashloanBalancerAssets = flashloanBook.balancer.length;
  stats.flashloanAaveAssets = flashloanBook.aave.length;
  const edges = new Map<string, Edge>();

  console.log(`LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_START|flashloanAssets=${flashloanAssets.length}`);
  await discoverV2(provider, tokenCache, edges, stats, latestBlock, flashloanAssets);
  console.log(`LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_END|edges=${edges.size}`);
  console.log("LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_START");
  await discoverV3(provider, tokenCache, edges, stats, latestBlock, flashloanAssets);
  console.log(`LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_END|edges=${edges.size}`);
  console.log("LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_START");
  await discoverAlgebra(provider, tokenCache, edges, stats, latestBlock, flashloanAssets);
  console.log(`LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_END|edges=${edges.size}`);
  console.log("LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_START");
  await discoverCurve(provider, tokenCache, edges, stats, latestBlock);
  console.log(`LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_END|edges=${edges.size}`);
  console.log("LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_START");
  await discoverBalancer(provider, tokenCache, edges, stats, latestBlock);
  console.log(`LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_END|edges=${edges.size}`);

  const edgeList = Array.from(edges.values());
  console.log(`LIVE_CYCLE_PHASE|phase=PRICE_DERIVATION_START|edges=${edgeList.length}`);
  await derivePrices(provider, tokenCache, edgeList);
  const maxStateAgeBlocks = intEnv("LIVE_ROUTE_MAX_STATE_AGE_BLOCKS", DEFAULT_ROUTE_MAX_STATE_AGE_BLOCKS);
  const liveEdges: Edge[] = [];
  console.log(`LIVE_CYCLE_PHASE|phase=PRESEND_REVALIDATION_START|edges=${edgeList.length}`);
  for (const edge of edgeList) {
    const result = await preSendRevalidate(provider, edge, maxStateAgeBlocks).catch((error) => ({ ok: false, error: error?.message }));
    if (!result.ok) {
      stats.rejectedPreSend += 1;
      continue;
    }
    liveEdges.push(edge);
  }
  stats.tokens = tokenCache.size;
  stats.discoveredEdges = liveEdges.length;
  stats.discoveredPools = new Set(liveEdges.map((edge) => edge.poolAddress.toLowerCase())).size;
  console.log(`LIVE_CYCLE_PHASE|phase=DISCOVERY_GRAPH_END|liveEdges=${liveEdges.length}|tokens=${tokenCache.size}`);
  return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: liveEdges, stats };
}

async function quoteEdge(provider: ethers.JsonRpcProvider, edge: Edge, amountIn: bigint) {
  if (edge.invariant === "V2_CPMM") {
    return quoteV2Cpmm(amountIn, edge.reserveIn, edge.reserveOut, edge.feeBps);
  }
  if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
    return await quoteV3ExactInputSingle(provider, {
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      fee: edge.extra?.v3Fee || edge.feeBps * 100,
      amountIn,
    });
  }
  if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
    return await quoteAlgebraExactInputSingle(provider, {
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
    });
  }
  if (edge.invariant === "CURVE_STABLE_SWAP") {
    if (edge.tokenInIndex === undefined || edge.tokenOutIndex === undefined) throw new Error("CURVE_INDEX_MISSING");
    return await quoteCurveGetDy(provider, {
      pool: edge.poolAddress,
      i: edge.tokenInIndex,
      j: edge.tokenOutIndex,
      amountIn,
      indexType: edge.extra?.curveIndexType || "int128",
    });
  }
  if (edge.invariant === "BALANCER_WEIGHTED") {
    if (!edge.extra?.balancerWeightIn || !edge.extra?.balancerWeightOut || edge.extra?.balancerSwapFeeBps === undefined) {
      throw new Error("BALANCER_WEIGHT_DATA_MISSING");
    }
    return quoteBalancerWeighted(amountIn, {
      balanceIn: edge.reserveIn,
      balanceOut: edge.reserveOut,
      weightIn: edge.extra.balancerWeightIn,
      weightOut: edge.extra.balancerWeightOut,
      swapFeeBps: edge.extra.balancerSwapFeeBps,
    });
  }
  if (edge.invariant === "STABLE_SWAP") {
    if (edge.tokenInIndex === undefined || edge.tokenOutIndex === undefined) throw new Error("STABLE_SWAP_INDEX_MISSING");
    return await quoteStableSwapGetDy(provider, {
      pool: edge.poolAddress,
      i: edge.tokenInIndex,
      j: edge.tokenOutIndex,
      amountIn,
    });
  }
  throw new Error(`UNSUPPORTED_INVARIANT:${edge.invariant}`);
}

function buildStepCalldata(edge: Edge, amountIn: bigint, minAmountOut: bigint, targetContract: string, deadline: number) {
  if (edge.invariant === "V2_CPMM") {
    return buildV2SwapCalldata(amountIn, minAmountOut, [edge.tokenIn, edge.tokenOut], targetContract, deadline);
  }
  if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
    return buildV3ExactInputSingleCalldata({
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      fee: edge.extra?.v3Fee || edge.feeBps * 100,
      receiver: targetContract,
      deadline,
      amountIn,
      minAmountOut,
    });
  }
  if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
    return buildAlgebraExactInputSingleCalldata({
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      receiver: targetContract,
      deadline,
      amountIn,
      minAmountOut,
    });
  }
  if (edge.invariant === "CURVE_STABLE_SWAP") {
    return buildCurveRouterExchangeCalldata({
      pool: edge.poolAddress,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      minAmountOut,
      receiver: targetContract,
    });
  }
  if (edge.invariant === "BALANCER_WEIGHTED") {
    if (!edge.poolId) throw new Error("BALANCER_POOL_ID_MISSING");
    return buildBalancerSingleSwapCalldata({
      poolId: edge.poolId,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      minAmountOut,
      sender: targetContract,
      receiver: targetContract,
      deadline,
    });
  }
  if (edge.invariant === "STABLE_SWAP") {
    if (edge.tokenInIndex === undefined || edge.tokenOutIndex === undefined) throw new Error("STABLE_SWAP_INDEX_MISSING");
    return buildStableSwapExchangeCalldata({
      i: edge.tokenInIndex,
      j: edge.tokenOutIndex,
      amountIn,
      minAmountOut,
    });
  }
  throw new Error(`CALldata_UNSUPPORTED_INVARIANT:${edge.invariant}`);
}

function reverseEdge(edge: Edge): Edge {
  const extra = edge.extra ? { ...edge.extra } : undefined;
  if (extra?.balancerWeightIn !== undefined || extra?.balancerWeightOut !== undefined) {
    const weightIn = extra.balancerWeightIn;
    extra.balancerWeightIn = extra.balancerWeightOut;
    extra.balancerWeightOut = weightIn;
  }
  return {
    ...edge,
    edgeId: `${edge.dexId}:${edge.poolAddress}:${edge.tokenOutSymbol}->${edge.tokenInSymbol}:reverse`,
    tokenIn: edge.tokenOut,
    tokenOut: edge.tokenIn,
    tokenInIndex: edge.tokenOutIndex,
    tokenOutIndex: edge.tokenInIndex,
    tokenInDecimals: edge.tokenOutDecimals,
    tokenOutDecimals: edge.tokenInDecimals,
    tokenInSymbol: edge.tokenOutSymbol,
    tokenOutSymbol: edge.tokenInSymbol,
    tokenInPriceUsd: edge.tokenOutPriceUsd,
    tokenOutPriceUsd: edge.tokenInPriceUsd,
    reserveIn: edge.reserveOut,
    reserveOut: edge.reserveIn,
    extra,
  };
}

function buildAdjacency(edges: Edge[]) {
  const byIn = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = edge.tokenIn.toLowerCase();
    const list = byIn.get(key) || [];
    list.push(edge);
    byIn.set(key, list);
  }
  return byIn;
}

function enumerateCycles(flashloanAssets: TokenMeta[], edges: Edge[], stats: DiscoveryStats) {
  const byIn = buildAdjacency(edges);
  const maxHops = Math.max(2, Math.min(4, intEnv("MAX_ROUTE_HOPS", 4)));
  const maxCycles = intEnv("LIVE_ROUTE_MAX_CYCLES", DEFAULT_ROUTE_MAX_CYCLES);
  const cycles: Edge[][] = [];
  const flashSet = new Set(flashloanAssets.map((asset) => asset.address.toLowerCase()));

  for (const asset of flashloanAssets) {
    const walk = (currentToken: string, route: Edge[], usedPools: Set<string>) => {
      if (maxCycles !== undefined && cycles.length >= maxCycles) {
        stats.truncated = true;
        return;
      }
      if (route.length >= 2 && sameAddress(currentToken, asset.address)) {
        cycles.push([...route]);
        stats.routeCyclesEnumerated += 1;
      }
      if (route.length >= maxHops) return;
      for (const edge of byIn.get(currentToken.toLowerCase()) || []) {
        if (usedPools.has(edge.poolAddress.toLowerCase())) {
          stats.routeCyclesRejectedRepeatedPool += 1;
          continue;
        }
        if (route.length + 1 === maxHops && !sameAddress(edge.tokenOut, asset.address)) {
          continue;
        }
        usedPools.add(edge.poolAddress.toLowerCase());
        route.push(edge);
        walk(edge.tokenOut, route, usedPools);
        route.pop();
        usedPools.delete(edge.poolAddress.toLowerCase());
      }
    };
    if (!flashSet.has(asset.address.toLowerCase())) {
      stats.routeCyclesRejectedNonFlashloan += 1;
      continue;
    }
    walk(asset.address, [], new Set());
  }
  return cycles;
}

async function quoteCandidate(
  provider: ethers.JsonRpcProvider,
  tokenCache: Map<string, TokenMeta>,
  flashloanBook: Map<string, FlashloanLiquidity[]>,
  route: Edge[],
  targetContract: string,
  gasCostUsd: number,
  minProfitUsd: number,
  laneId = 0,
) {
  const flashloanAsset = tokenCache.get(route[0].tokenIn.toLowerCase());
  if (!flashloanAsset) throw new Error("FLASHLOAN_TOKEN_METADATA_MISSING");
  const liquidityOptions = flashloanBook.get(flashloanAsset.address.toLowerCase()) || [];
  if (liquidityOptions.length === 0) throw new Error("FLASHLOAN_LIQUIDITY_MISSING");
  const lowestPoolTvlUsd = Math.min(...route.map((edge) => edge.tvlUsd).filter((value) => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(lowestPoolTvlUsd) || lowestPoolTvlUsd <= 0 || !flashloanAsset.priceUsd) {
    throw new Error("ROUTE_TVL_OR_PRICE_UNRESOLVED");
  }
  const targetAmountIn = floatToRaw((lowestPoolTvlUsd * numberEnv("SIM_MAX_FLASH_TVL_FRACTION", 0.15)) / flashloanAsset.priceUsd, flashloanAsset.decimals);
  const flashloanLiquidity = liquidityOptions.find((item) => item.liquidity >= targetAmountIn) || liquidityOptions[0];
  const amountIn = targetAmountIn <= flashloanLiquidity.liquidity ? targetAmountIn : flashloanLiquidity.liquidity;
  if (amountIn <= 0n) throw new Error("FLASHLOAN_SIZE_ZERO");
  const flashFeeRaw = amountIn * flashloanLiquidity.feeBps / 10000n;
  const slippageBps = BigInt(Math.floor(numberEnv("SLIPPAGE_BPS", 10)));
  const deadline = Math.floor(Date.now() / 1000) + intEnv("EXECUTION_SUBMISSION_EXPIRY_SECONDS", 300);

  let amount = amountIn;
  const steps: RouteQuoteStep[] = [];
  for (let legIndex = 0; legIndex < route.length; legIndex += 1) {
    const edge = route[legIndex];
    const team = legIndex === 0 ? "LEG1_MATH" : "LEG2_PLUS_MATH";
    void recordLaneEvent({
      laneId,
      team,
      phase: "QUOTE_START",
      legIndex,
      invariant: edge.invariant,
      poolAddress: edge.poolAddress,
      tokenIn: edge.tokenInSymbol,
      tokenOut: edge.tokenOutSymbol,
      at: Date.now(),
    });
    const amountOut = await quoteEdge(provider, edge, amount);
    if (amountOut <= 0n) throw new Error("QUOTE_ZERO_OUTPUT");
    const minAmountOut = bpsMin(amountOut, slippageBps);
    const calldata = buildStepCalldata(edge, amount, minAmountOut, targetContract, deadline);
    steps.push({ edge, amountIn: amount, amountOut, minAmountOut, calldata });
    amount = amountOut;
    void recordLaneEvent({
      laneId,
      team,
      phase: "QUOTE_END",
      legIndex,
      amountOut,
      at: Date.now(),
    });
  }

  const amountOut = amount;
  const grossProfitRaw = amountOut - amountIn;
  const repaymentRaw = amountIn + flashFeeRaw;
  const grossProfitUsd = quoteUsd(grossProfitRaw, flashloanAsset);
  const flashFeeUsd = quoteUsd(flashFeeRaw, flashloanAsset);
  const netProfitUsd = grossProfitUsd === undefined || flashFeeUsd === undefined
    ? undefined
    : grossProfitUsd - flashFeeUsd - gasCostUsd - numberEnv("RISK_BUFFER_USD", 0);
  const status = amountOut > repaymentRaw && netProfitUsd !== undefined && netProfitUsd >= minProfitUsd
    ? "EXECUTABLE_PROFIT_CANDIDATE"
    : "REJECTED_NO_PROFIT";
  const rejectionReason = status === "EXECUTABLE_PROFIT_CANDIDATE"
    ? "NONE"
    : `NET_PROFIT_BELOW_MIN:${netProfitUsd === undefined ? "UNPRICED" : netProfitUsd.toFixed(6)}<${minProfitUsd}`;

  return {
    routeId: "",
    status,
    flashloanAsset,
    flashloanLiquidity,
    path: route.map((edge) => tokenCache.get(edge.tokenIn.toLowerCase())).filter(Boolean) as TokenMeta[],
    steps,
    amountIn,
    amountOut,
    grossProfitRaw,
    grossProfitUsd,
    gasCostUsd,
    flashFeeRaw,
    flashFeeUsd,
    netProfitUsd,
    lowestPoolTvlUsd,
    rejectionReason,
  } satisfies Candidate;
}

async function rankCandidates(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, flashloanBook: Map<string, FlashloanLiquidity[]>, flashloanAssets: TokenMeta[], edges: Edge[], stats: DiscoveryStats, targetContract: string) {
  const cycles = enumerateCycles(flashloanAssets, edges, stats);
  const gasPrice = await provider.getFeeData().then((fee) => fee.gasPrice || 0n).catch(() => 0n);
  const nativeUsd = numberEnv("NATIVE_TOKEN_USD", 1);
  const estimatedGasUnits = BigInt(intEnv("ESTIMATED_GAS_UNITS", 450000));
  const gasCostUsd = Number(estimatedGasUnits * gasPrice) / 1e18 * nativeUsd;
  const minProfitUsd = numberEnv("MIN_NET_PROFIT_USD", 5);
  const candidates: Candidate[] = [];
  const quoteLanes = intEnv("LIVE_QUOTE_LANES", DEFAULT_QUOTE_LANES);
  const leg1Helpers = Math.max(1, Math.floor(quoteLanes / 2));
  const leg2Helpers = Math.max(1, quoteLanes - leg1Helpers);
  console.log(`LANE_TEAM_SUMMARY|quoteLanes=${quoteLanes}|leg1Helpers=${leg1Helpers}|leg2PlusHelpers=${leg2Helpers}|cycles=${cycles.length}|dependency=LEG2_REQUIRES_LEG1_OUTPUT`);

  await runWithConcurrency(cycles.map((route, index) => ({ route, index })), quoteLanes, async ({ route, index }) => {
    try {
      const laneId = index % quoteLanes;
      candidates.push(await quoteCandidate(provider, tokenCache, flashloanBook, route, targetContract, gasCostUsd, minProfitUsd, laneId));
    } catch {
      stats.routeCyclesRejectedQuote += 1;
    }
  });

  candidates.sort((a, b) => (b.netProfitUsd ?? Number.NEGATIVE_INFINITY) - (a.netProfitUsd ?? Number.NEGATIVE_INFINITY));
  let executableSlot = 0;
  candidates.forEach((candidate, index) => {
    candidate.rank = index + 1;
    candidate.routeId = `LIVE-${String(index + 1).padStart(6, "0")}`;
    if (candidate.status === "EXECUTABLE_PROFIT_CANDIDATE" && executableSlot < intEnv("C1_EXECUTABLE_LIMIT_PER_CYCLE", DEFAULT_C1_EXECUTABLE_LIMIT)) {
      executableSlot += 1;
      candidate.c1ExecutionEligible = true;
      candidate.c1ExecutionSlot = executableSlot;
    } else {
      candidate.c1ExecutionEligible = false;
    }
  });
  const topRouteDisplayLimit = intEnv("TOP_ROUTE_DISPLAY_LIMIT", DEFAULT_TOP_ROUTE_DISPLAY_LIMIT);
  await publishOpportunitySnapshot(candidates.slice(0, topRouteDisplayLimit).map(candidateToLedgerPayload), "live-cycle-rank-candidates");
  return { candidates, gasCostUsd, minProfitUsd };
}

function candidateToLedgerPayload(candidate: Candidate) {
  return {
    routeId: candidate.routeId,
    payloadKind: "FLASHLOAN_INTEGRATED_C1_PAYLOADS",
    status: candidate.status,
    c1ExecutionEligible: Boolean(candidate.c1ExecutionEligible),
    c1ExecutionSlot: candidate.c1ExecutionSlot,
    pair: `${candidate.flashloanAsset.symbol} cycle`,
    path: routePath(candidate),
    venues: routeVenues(candidate),
    hops: candidate.steps.length,
    flashloanAsset: candidate.flashloanAsset.address,
    flashloanSymbol: candidate.flashloanAsset.symbol,
    flashloanProvider: candidate.flashloanLiquidity.provider,
    flashloanSource: candidate.flashloanLiquidity.sourceCode,
    amountIn: candidate.amountIn,
    amountOut: candidate.amountOut,
    grossProfitUsd: candidate.grossProfitUsd,
    flashFeeUsd: candidate.flashFeeUsd,
    gasCostUsd: candidate.gasCostUsd,
    netProfitUsd: candidate.netProfitUsd,
    profit_usd: candidate.netProfitUsd,
    lowestPoolTvlUsd: candidate.lowestPoolTvlUsd,
    pools: candidate.steps.map((step) => step.edge.poolAddress),
    reason: candidate.rejectionReason,
    chain_id: 137,
    executionReady: Boolean(candidate.c1ExecutionEligible),
    c1ExecutableLimitPerCycle: intEnv("C1_EXECUTABLE_LIMIT_PER_CYCLE", DEFAULT_C1_EXECUTABLE_LIMIT),
  };
}

async function buildReverseRouteMetadata(
  provider: ethers.JsonRpcProvider,
  candidate: Candidate,
  targetContract: string,
  c1Nonce: bigint,
): Promise<ReverseRouteMetadata> {
  try {
    if (!candidate.flashloanAsset.priceUsd) throw new Error("REVERSE_FLASHLOAN_ASSET_PRICE_MISSING");
    const lowestPoolTvlUsd = Math.min(...candidate.steps.map((step) => step.edge.tvlUsd).filter((value) => Number.isFinite(value) && value > 0));
    if (!Number.isFinite(lowestPoolTvlUsd) || lowestPoolTvlUsd <= 0) throw new Error("REVERSE_LOWEST_POOL_TVL_UNRESOLVED");

    const targetAmountIn = floatToRaw(
      (lowestPoolTvlUsd * numberEnv("SIM_MAX_FLASH_TVL_FRACTION", 0.15)) / candidate.flashloanAsset.priceUsd,
      candidate.flashloanAsset.decimals,
    );
    const reverseFlashloanAmount = targetAmountIn <= candidate.flashloanLiquidity.liquidity
      ? targetAmountIn
      : candidate.flashloanLiquidity.liquidity;
    if (reverseFlashloanAmount <= 0n) throw new Error("REVERSE_FLASHLOAN_SIZE_ZERO");

    const slippageBps = BigInt(Math.floor(numberEnv("SLIPPAGE_BPS", 10)));
    const deadline = Math.floor(Date.now() / 1000) + intEnv("EXECUTION_SUBMISSION_EXPIRY_SECONDS", 300);
    const reverseSteps: RouteQuoteStep[] = [];
    let amount = reverseFlashloanAmount;
    for (const reverse of [...candidate.steps].reverse().map((step) => reverseEdge(step.edge))) {
      const amountOut = await quoteEdge(provider, reverse, amount);
      if (amountOut <= 0n) throw new Error("REVERSE_QUOTE_ZERO_OUTPUT");
      const minAmountOut = bpsMin(amountOut, slippageBps);
      const calldata = buildStepCalldata(reverse, amount, minAmountOut, targetContract, deadline);
      reverseSteps.push({ edge: reverse, amountIn: amount, amountOut, minAmountOut, calldata });
      amount = amountOut;
    }

    const flashFeeRaw = reverseFlashloanAmount * candidate.flashloanLiquidity.feeBps / 10000n;
    const reverseContext = {
      profitAsset: candidate.flashloanAsset.address,
      minNetProfit: flashFeeRaw + 1n,
      nonce: c1Nonce + 1n,
      merkleRoot: ethers.ZeroHash,
      proof: [],
      steps: reverseSteps.map((step) => ({
        venue: step.edge.executorTarget,
        tokenIn: step.edge.tokenIn,
        tokenOut: step.edge.tokenOut,
        amountIn: step.amountIn,
        minAmountOut: step.minAmountOut,
        callValue: 0n,
        payload: step.calldata,
      })),
    };

    const reversePathSymbols = reverseSteps.map((step) => step.edge.tokenInSymbol);
    reversePathSymbols.push(reverseSteps[reverseSteps.length - 1]?.edge.tokenOutSymbol || candidate.flashloanAsset.symbol);
    return {
      available: true,
      reverseFlashloanSource: candidate.flashloanLiquidity.sourceCode,
      reverseFlashloanAsset: candidate.flashloanAsset.address,
      reverseFlashloanAmount: reverseFlashloanAmount.toString(),
      reverseContext,
      reversePath: reversePathSymbols.join("->"),
      reverseVenues: reverseSteps.map((step) => `${step.edge.venueName}:${step.edge.invariant}`).join("->"),
      sizingRule: "REVERSE_FLASHLOAN_SIZE=min(15% x lowest route TVL, provider liquidity)",
    };
  } catch (error: any) {
    return {
      available: false,
      error: error?.message || "REVERSE_ROUTE_METADATA_BUILD_FAILED",
    };
  }
}

async function buildC1Context(provider: ethers.JsonRpcProvider, candidate: Candidate, targetContract: string) {
  const vm = new ethers.Contract(targetContract, VM_ABI, provider);
  const nonce = await vm.globalNonce().catch(() => 0n);
  const reverseRouteMetadata = await buildReverseRouteMetadata(provider, candidate, targetContract, BigInt(nonce));
  return {
    profitAsset: candidate.flashloanAsset.address,
    minNetProfit: candidate.flashFeeRaw + 1n,
    nonce,
    merkleRoot: ethers.ZeroHash,
    proof: [],
    steps: candidate.steps.map((step) => ({
      venue: step.edge.executorTarget,
      tokenIn: step.edge.tokenIn,
      tokenOut: step.edge.tokenOut,
      amountIn: step.amountIn,
      minAmountOut: step.minAmountOut,
      callValue: 0n,
      payload: step.calldata,
    })),
    routeMetadata: {
      routeId: candidate.routeId,
      mirrorPath: routePath(candidate),
      mirrorVenues: routeVenues(candidate),
      mirrorFlashloanAmount: candidate.amountIn.toString(),
      reverseAutomation: reverseRouteMetadata.available ? "READY" : "UNAVAILABLE",
      ...reverseRouteMetadata,
    },
  };
}

function routePath(candidate: Candidate) {
  const symbols = candidate.steps.map((step) => step.edge.tokenInSymbol);
  symbols.push(candidate.steps[candidate.steps.length - 1]?.edge.tokenOutSymbol || candidate.flashloanAsset.symbol);
  return symbols.join("->");
}

function routeVenues(candidate: Candidate) {
  return candidate.steps.map((step) => `${step.edge.venueName}:${step.edge.invariant}`).join("->");
}

async function main() {
  console.log("LIVE_CYCLE_PHASE|phase=BOOT_START");
  const provider = new ethers.JsonRpcProvider(rpcUrl(), Number(CHAIN_ID), { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error(`CHAIN_ID_MISMATCH:${network.chainId}`);
  const targetContract = DEFAULT_C1_TARGET ? normalize(DEFAULT_C1_TARGET) : "";
  if (!targetContract) throw new Error("C1_TARGET_MISSING");

  console.log("LIVE_CYCLE_PHASE|phase=API_PREFLIGHT_START");
  const health = await getJson("/api/system/healthz").catch((error) => ({ success: false, error: error.message }));
  const readiness = await getJson("/api/system/readiness").catch((error) => ({ ready: false, error: error.message }));
  console.log(`LIVE_CYCLE_PHASE|phase=API_PREFLIGHT_END|health=${health.status || health.success}|readiness=${readiness.status || readiness.ready}`);
  const { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges, stats } = await discoverGraph(provider);
  console.log(`LIVE_CYCLE_PHASE|phase=RANKING_START|edges=${edges.length}|flashloanAssets=${flashloanAssets.length}`);
  const { candidates, gasCostUsd, minProfitUsd } = await rankCandidates(provider, tokenCache, flashloanBook.byAsset, flashloanAssets, edges, stats, targetContract);
  const maxPrint = optionalIntEnv("LIVE_ROUTE_PRINT_LIMIT");

  console.log(`LIVE_CYCLE_START|chainId=${network.chainId}|block=${latestBlock}|api=${API_BASE}|serverHealth=${health.status || health.success}|serverReady=${readiness.status || readiness.ready}|broadcastPolicy=ONLY_AFTER_PROFIT_AND_FORK_PASS|routeMode=FULL_DYNAMIC_GRAPH|assetMode=BALANCER_FIRST_AAVE_FALLBACK_FLASHLOAN_LIQUIDITY|pnlUpdated=false`);
  console.log(`DISCOVERY_SUMMARY|flashloanAssets=${stats.flashloanAssets}|flashloanBalancerAssets=${stats.flashloanBalancerAssets}|flashloanAaveAssets=${stats.flashloanAaveAssets}|tokens=${stats.tokens}|discoveredPools=${stats.discoveredPools}|directedEdges=${stats.discoveredEdges}|sourceCounts=${JSON.stringify(stats.sourceCounts)}|rejectedMetadata=${stats.rejectedMetadata}|rejectedZeroLiquidity=${stats.rejectedZeroLiquidity}|rejectedDuplicateEdge=${stats.rejectedDuplicateEdge}|rejectedUnsupportedInvariant=${stats.rejectedUnsupportedInvariant}|rejectedPreSend=${stats.rejectedPreSend}|rejectedLogScanChunks=${stats.rejectedLogScan}|routeCycles=${stats.routeCyclesEnumerated}|routeQuoteRejects=${stats.routeCyclesRejectedQuote}|truncated=${stats.truncated}|gasCostUsd=${gasCostUsd.toFixed(6)}|minProfitUsd=${minProfitUsd}|pnlUpdated=false`);
  console.log(`FLASHLOAN_LIQUIDITY|${flashloanBook.ordered.map((item) => `${item.provider}:${item.asset.symbol}:${item.asset.address}:liquidity=${ethers.formatUnits(item.liquidity, item.asset.decimals)}:feeBps=${item.feeBps}`).join(",")}`);
  console.log(`FLASHLOAN_ASSETS|${flashloanAssets.map((asset) => `${asset.symbol}:${asset.address}`).join(",")}`);
  console.log(`PRICE_MAP|${JSON.stringify(Object.fromEntries(Array.from(tokenCache.values()).filter((token) => token.priceUsd).map((token) => [token.symbol, Number(token.priceUsd?.toFixed(8))])))}`);

  const topRouteDisplayLimit = intEnv("TOP_ROUTE_DISPLAY_LIMIT", DEFAULT_TOP_ROUTE_DISPLAY_LIMIT);
  console.log(`ROUTE_LIMITS|totalRoutes=${candidates.length}|topRouteDisplayLimit=${topRouteDisplayLimit}|c1ExecutableLimitPerCycle=${intEnv("C1_EXECUTABLE_LIMIT_PER_CYCLE", DEFAULT_C1_EXECUTABLE_LIMIT)}|c2DecisionLimitPerCycle=${Number(process.env.C2_DECISION_LIMIT_PER_CYCLE || 50)}`);

  for (const candidate of maxPrint === undefined ? candidates.slice(0, topRouteDisplayLimit) : candidates.slice(0, Math.min(maxPrint, topRouteDisplayLimit))) {
    console.log([
      `ROUTE_RANK|rank=${candidate.rank}`,
      `routeId=${candidate.routeId}`,
      `status=${candidate.status}`,
      `c1ExecutionEligible=${Boolean(candidate.c1ExecutionEligible)}`,
      `c1ExecutionSlot=${candidate.c1ExecutionSlot ?? "NONE"}`,
      `flashloanAsset=${candidate.flashloanAsset.symbol}:${candidate.flashloanAsset.address}`,
      `flashloanProvider=${candidate.flashloanLiquidity.provider}`,
      `flashloanProviderAddress=${candidate.flashloanLiquidity.providerAddress}`,
      `flashloanSource=${candidate.flashloanLiquidity.sourceCode}`,
      `path=${routePath(candidate)}`,
      `venues=${routeVenues(candidate)}`,
      `hops=${candidate.steps.length}`,
      `amountIn=${ethers.formatUnits(candidate.amountIn, candidate.flashloanAsset.decimals)}`,
      `amountOut=${ethers.formatUnits(candidate.amountOut, candidate.flashloanAsset.decimals)}`,
      `grossProfitUsd=${candidate.grossProfitUsd?.toFixed(6) ?? "UNPRICED"}`,
      `flashFeeUsd=${candidate.flashFeeUsd?.toFixed(6) ?? "UNPRICED"}`,
      `gasCostUsd=${candidate.gasCostUsd?.toFixed(6) ?? "UNPRICED"}`,
      `netProfitUsd=${candidate.netProfitUsd?.toFixed(6) ?? "UNPRICED"}`,
      `lowestPoolTvlUsd=${candidate.lowestPoolTvlUsd.toFixed(2)}`,
      `pools=${candidate.steps.map((step) => `${step.edge.venueName}:${step.edge.poolAddress}`).join(",")}`,
      `reason=${candidate.rejectionReason}`,
    ].join("|"));
  }

  const best = candidates.find((candidate) => candidate.c1ExecutionEligible) || candidates[0];
  if (!best) {
    console.log("OPPORTUNITY_DECISION|decision=DO_NOTHING|reason=NO_DYNAMIC_ROUTE_CANDIDATES|hash=NONE|pnlUpdated=false");
  } else if (best.status !== "EXECUTABLE_PROFIT_CANDIDATE") {
    console.log(`OPPORTUNITY_DECISION|decision=DO_NOTHING|bestRoute=${best.routeId}|reason=${best.rejectionReason}|hash=NONE|pnlUpdated=false`);
  } else {
    const ledgerPayload = candidateToLedgerPayload(best);
    const lock = await lockOpportunityForExecution(ledgerPayload);
    if (!lock.ok) {
      console.log(`OPPORTUNITY_DECISION|decision=DO_NOTHING|bestRoute=${best.routeId}|reason=${lock.reason}|redisId=${lock.id}|hash=NONE|pnlUpdated=false`);
      console.log("C2_DECISION|decision=DO_NOTHING|reason=NO_CONFIRMED_C1_HASH_IN_THIS_CYCLE|hash=NONE|pnlUpdated=false");
      return;
    }
    const context = await buildC1Context(provider, best, targetContract);
    const exec = await postJson("/api/execution/c1", {
      redisId: lock.id,
      targetContract,
      flashloanSource: best.flashloanLiquidity.sourceCode,
      flashloanAsset: best.flashloanAsset.address,
      flashloanAmount: best.amountIn,
      context,
    });
    if (!exec.json.success) {
      await releaseOpportunityLock(lock.id, "C1_REJECTED", {
        routeId: best.routeId,
        error: exec.json.error || "C1 rejected by API",
      });
    }
    console.log(`C1_EXECUTION_RESULT|routeId=${best.routeId}|httpStatus=${exec.status}|success=${exec.json.success}|hash=${exec.json.hash || "NONE"}|hashLink=${exec.json.hashLink || "NONE"}|error=${exec.json.error || "NONE"}|forkOk=${exec.json.forkSimulation?.ok ?? "UNKNOWN"}|pnlUpdated=false`);
  }

  console.log("C2_DECISION|decision=DO_NOTHING|reason=NO_CONFIRMED_C1_HASH_IN_THIS_CYCLE|hash=NONE|pnlUpdated=false");
  const pnl = await getJson("/api/dashboard/pnl-summary").catch((error) => ({ error: error.message }));
  console.log(`PNL_STATUS|sessionRaw=${pnl.sessionPnlRaw ?? "UNKNOWN"}|lifetimeRaw=${pnl.lifetimePnlRaw ?? "UNKNOWN"}|attribution=${pnl.pnlAttribution ?? "UNKNOWN"}|pnlUpdated=false`);
  console.log("LIVE_CYCLE_END|status=COMPLETE|broadcasted=false_unless_hash_printed_above");
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(`LIVE_CYCLE_FAILED|error=${error?.message || error}|broadcasted=false|pnlUpdated=false`);
  process.exit(1);
});
