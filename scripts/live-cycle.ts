import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import {
  buildRouteCalldataFromQuote,
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
  flushLaneEventBatch,
  lockOpportunityForExecution,
  publishOpportunitySnapshot,
  recordLaneEvent,
  releaseOpportunityLock,
  routeKeyFromC1Payload,
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
const DEFAULT_C1_TARGET = process.env.C1_CONTRACT_ADDRESS || process.env.C1_TARGET || process.env.APEX_C1_TARGET || process.env.CONTRACT_ADDRESS || process.env.EXECUTOR_ADDRESS || "";
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
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[] returnData)",
];
const DEFAULT_MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

const DEFAULT_DISCOVERY_FORCE_TOKENS: Record<string, string> = {
  USDC_E: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDT0: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  FRAX: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
  MAI: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
  MIMATIC: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
  STMATIC: "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4",
  MATICX: "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6",
  AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
  BAL: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3",
  QUICK: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13",
  MANA: "0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4",
  SUSHI: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
  GHST: "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7",
  SAND: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
  GRT: "0x5fe2B58c013d7601147DcdD68C143A77499f5531",
  UNI: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
  GNS: "0xE5417Af564e4bFDA1c483642db72007871397896",
  TEL: "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32",
  RNDR: "0x61299774020dA444Af134c82fa83E3810b309991",
};

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
    v3Quoter?: string;
    algebraQuoter?: string;
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

type PreSendResult = {
  ok: boolean;
  error?: string;
  currentBlock?: number;
};

type Candidate = {
  rank?: number;
  routeId: string;
  routeOrientation?: "DIRECT" | "AUTO_REVERSE";
  reverseOf?: string;
  status: "EXECUTABLE_PROFIT_CANDIDATE" | "REJECTED_NO_PROFIT" | "REJECTED_ROUTE_INVALID";
  flashloanAsset: TokenMeta;
  flashloanLiquidity: FlashloanLiquidity;
  path: TokenMeta[];
  steps: RouteQuoteStep[];
  amountIn: bigint;
  amountOut: bigint;
  repaymentRaw: bigint;
  repaymentUsd?: number;
  requiredOutputRaw?: bigint;
  requiredOutputUsd?: number;
  executableSurplusRaw?: bigint;
  executableSurplusUsd?: number;
  economicMinTradeUsd?: number;
  maxScannableTradeUsd?: number;
  profitabilityTargetEdgeBps?: number;
  economicSizeOk?: boolean;
  grossProfitRaw: bigint;
  grossProfitUsd?: number;
  gasCostUsd?: number;
  flashFeeRaw: bigint;
  flashFeeUsd?: number;
  riskBufferUsd?: number;
  minProfitUsd?: number;
  requiredPremiumUsd?: number;
  netProfitUsd?: number;
  lowestPoolTvlUsd: number;
  rejectionReason: string;
  c1ExecutionEligible?: boolean;
  c1ExecutionSlot?: number;
  sizingRule?: string;
  sizeSearchCandidatesUsd?: number[];
  priceVariance?: PriceVarianceGate;
};

export type LiveCycleCandidate = Candidate;
export type LiveCycleDiscoveryStats = DiscoveryStats;
export type LiveCyclePoolEdge = Edge;

type PriceVarianceGate = {
  ok: boolean;
  mode: "DIRECT_TWO_LEG" | "MULTI_LEG_NET";
  leg1BuyPrice?: number;
  leg2SellPrice?: number;
  priceEdgeBps?: number;
  reverseMathHint?: {
    buyLeg1IfReversed: number;
    sellLeg2IfReversed: number;
    naiveReverseEdgeBps: number;
    naiveReverseGrossPositive: boolean;
    warning: string;
  };
  grossReturnRatio: number;
  rule: string;
  reason: string;
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
  rejectedLowTvlEdge: number;
  rejectedLogScan: number;
  rejectedPreSend: number;
  preSendRejectReasons: Record<string, number>;
  forcedDiscoveryTokens: number;
  routeCyclesEnumerated: number;
  routeCyclesRejectedRepeatedPool: number;
  routeCyclesRejectedRepeatedToken: number;
  routeCyclesRejectedNonFlashloan: number;
  routeCyclesRejectedVenueDiversity: number;
  routeCyclesRejectedConsecutiveVenue: number;
  routeCyclesRejectedTvl: number;
  routeCyclesRejectedQuote: number;
  routeQuoteRejectReasons: Record<string, number>;
  minRoutePoolTvlUsd: number;
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

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "true" || raw === "1";
}

function normalize(address: string) {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return ethers.getAddress(address.toLowerCase());
  }
  return ethers.getAddress(address);
}

function parseDiscoveryForceEntries() {
  const configured = [
    ...Object.keys(DEFAULT_DISCOVERY_FORCE_TOKENS),
    ...(process.env.DISCOVERY_FORCE_SYMBOLS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ...(process.env.LIVE_DISCOVERY_FORCE_TOKENS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
  return [...new Set(configured.map((item) => item.trim()).filter(Boolean))];
}

async function loadForcedDiscoveryTokens(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>) {
  const tokens: TokenMeta[] = [];
  for (const entry of parseDiscoveryForceEntries()) {
    const mapped = DEFAULT_DISCOVERY_FORCE_TOKENS[entry.toUpperCase()];
    const rawAddress = mapped || entry;
    try {
      tokens.push(await loadTokenMeta(provider, tokenCache, rawAddress, false));
    } catch {
      // Bad symbol/address or metadata failure means the asset cannot be included in live math.
    }
  }
  return Array.from(new Map(tokens.map((token) => [token.address.toLowerCase(), token])).values());
}

function mergeTokenLists(...lists: TokenMeta[][]) {
  return Array.from(new Map(lists.flat().map((token) => [token.address.toLowerCase(), token])).values());
}

function edgeRuntimeKey(edge: Edge) {
  return `${edge.dexId}:${edge.poolAddress}:${edge.tokenIn}:${edge.tokenOut}:${edge.invariant}:${edge.feeBps}:${edge.tokenInIndex ?? ""}:${edge.tokenOutIndex ?? ""}`.toLowerCase();
}

function preSendPoolKey(edge: Edge) {
  return `${edge.invariant}:${edge.poolAddress}:${edge.poolId || ""}:${edge.extra?.v3Fee ?? edge.feeBps}`.toLowerCase();
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

function floatToRawCeil(value: number, decimals: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const precision = Math.min(decimals, 12);
  const scale = 10 ** precision;
  const roundedUp = Math.ceil(value * scale) / scale;
  return ethers.parseUnits(roundedUp.toFixed(precision), decimals);
}

function usdToRawCeil(valueUsd: number, token: TokenMeta) {
  if (!token.priceUsd || token.priceUsd <= 0) return undefined;
  return floatToRawCeil(valueUsd / token.priceUsd, token.decimals);
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

async function withBudget<T>(
  startedAt: number,
  maxRuntimeMs: number,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const remainingMs = maxRuntimeMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new Error(`${label}_DISCOVERY_BUDGET_EXPIRED`);
  return await withTimeout(task(), Math.max(1, remainingMs), `${label}_DISCOVERY_BUDGET`);
}

function usdStableSeed(symbol: string) {
  const upper = symbol.toUpperCase();
  if (upper === "USDC" || upper === "USDC.E" || upper === "USDT" || upper === "USDT0" || upper === "DAI" || upper === "FRAX") return 1;
  if (upper === "MIMATIC" || upper === "MAI") return 1;
  return undefined;
}

function priceBounds(symbol: string) {
  const upper = symbol.toUpperCase();
  if (["USDC", "USDC.E", "USDT", "USDT0", "DAI", "FRAX", "MIMATIC", "MAI"].includes(upper)) return { min: 0.8, max: 1.2 };
  if (["WETH", "WSTETH"].includes(upper)) return { min: 100, max: 20_000 };
  if (upper === "WBTC") return { min: 1_000, max: 500_000 };
  if (["WPOL", "WMATIC", "POL", "MATIC", "STMATIC", "MATICX"].includes(upper)) return { min: 0.001, max: 20 };
  return {
    min: numberEnv("PRICE_DERIVATION_MIN_USD", 0.000001),
    max: numberEnv("PRICE_DERIVATION_MAX_USD", 1_000_000),
  };
}

function priceWithinBounds(symbol: string, value: number) {
  const bounds = priceBounds(symbol);
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

function weightedMedian(values: Array<{ value: number; weight: number }>) {
  const filtered = values
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && Number.isFinite(item.weight) && item.weight > 0)
    .sort((left, right) => left.value - right.value);
  if (filtered.length === 0) return undefined;
  const totalWeight = filtered.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  for (const item of filtered) {
    running += item.weight;
    if (running >= totalWeight / 2) return item.value;
  }
  return filtered[filtered.length - 1]?.value;
}

function quoteUsd(raw: bigint, token: TokenMeta) {
  if (!token.priceUsd) return undefined;
  return rawToFloat(raw, token.decimals) * token.priceUsd;
}

function effectivePriceUsd(amountIn: bigint, tokenIn: TokenMeta, amountOut: bigint, tokenOut: TokenMeta) {
  const inUsd = quoteUsd(amountIn, tokenIn);
  const outUnits = rawToFloat(amountOut, tokenOut.decimals);
  if (inUsd === undefined || outUnits <= 0) return undefined;
  return inUsd / outUnits;
}

function evaluatePriceVarianceGate(steps: RouteQuoteStep[], flashloanAsset: TokenMeta, grossProfitRaw: bigint): PriceVarianceGate {
  const amountIn = steps[0]?.amountIn || 0n;
  const amountOut = steps[steps.length - 1]?.amountOut || 0n;
  const grossReturnRatio = amountIn > 0n ? Number(amountOut) / Number(amountIn) : 0;
  const directTwoLeg = steps.length === 2;
  if (directTwoLeg) {
    const leg1 = steps[0];
    const leg2 = steps[1];
    const leg1TokenIn = leg1.edge.tokenInSymbol;
    const leg1TokenOut = leg1.edge.tokenOutSymbol;
    const leg2TokenIn = leg2.edge.tokenInSymbol;
    const leg2TokenOut = leg2.edge.tokenOutSymbol;
    if (leg1TokenOut === leg2TokenIn && leg1TokenIn === leg2TokenOut) {
      const intermediate = {
        chainId: 137 as const,
        address: leg1.edge.tokenOut,
        symbol: leg1.edge.tokenOutSymbol,
        decimals: leg1.edge.tokenOutDecimals,
        priceUsd: leg1.edge.tokenOutPriceUsd,
        flashloanEligible: false,
      };
      const leg1BuyPrice = effectivePriceUsd(leg1.amountIn, flashloanAsset, leg1.amountOut, intermediate);
      const leg2SellPrice = effectivePriceUsd(leg2.amountOut, flashloanAsset, leg2.amountIn, intermediate);
      if (leg1BuyPrice !== undefined && leg2SellPrice !== undefined) {
        const priceEdgeBps = leg1BuyPrice > 0 ? (leg2SellPrice - leg1BuyPrice) / leg1BuyPrice * 10_000 : 0;
        const reverseMathHint = leg1BuyPrice >= leg2SellPrice && leg2SellPrice > 0
          ? {
            buyLeg1IfReversed: leg2SellPrice,
            sellLeg2IfReversed: leg1BuyPrice,
            naiveReverseEdgeBps: (leg1BuyPrice - leg2SellPrice) / leg2SellPrice * 10_000,
            naiveReverseGrossPositive: leg1BuyPrice > leg2SellPrice,
            warning: "Naive inversion ignores live re-quote, pool fees, slippage, curve impact, gas, and flash fees. AUTO_REVERSE rows are quoted independently.",
          }
          : undefined;
        return {
          ok: leg1BuyPrice < leg2SellPrice,
          mode: "DIRECT_TWO_LEG",
          leg1BuyPrice,
          leg2SellPrice,
          priceEdgeBps,
          reverseMathHint,
          grossReturnRatio,
          rule: "LEG1_BUY_PRICE_LT_LEG2_SELL_PRICE",
          reason: leg1BuyPrice < leg2SellPrice ? "PRICE_VARIANCE_OK" : `PRICE_VARIANCE_REJECT:${leg1BuyPrice.toFixed(10)}>=${leg2SellPrice.toFixed(10)}`,
        };
      }
    }
  }
  return {
    ok: grossProfitRaw > 0n && amountOut > amountIn,
    mode: "MULTI_LEG_NET",
    grossReturnRatio,
    rule: "FINAL_FLASHLOAN_ASSET_OUT_GT_IN_FOR_MULTI_LEG",
    reason: grossProfitRaw > 0n && amountOut > amountIn ? "MULTI_LEG_NET_VARIANCE_OK" : "MULTI_LEG_NET_VARIANCE_REJECT",
  };
}

function parseSourceList(envName: string, fallback: string) {
  return [process.env[envName] || fallback, process.env[`${envName}_EXTRA`] || ""]
    .filter(Boolean)
    .join(";")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(":").map((part) => part.trim()));
}

function parseNumberListEnv(name: string, fallback: number[]) {
  const raw = process.env[name];
  const values = raw
    ? raw.split(",").map((item) => Number(item.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : fallback;
  return [...new Set(values)].sort((a, b) => a - b);
}

function addUsdCandidate(values: number[], candidate: number, maxUsd: number) {
  if (!Number.isFinite(candidate) || candidate <= 0) return;
  values.push(Math.min(candidate, maxUsd));
}

function buildSizeUsdCandidates(lowestPoolTvlUsd: number, maxFlashTvlFraction: number, requiredPremiumUsd: number) {
  const maxScannableTradeUsd = lowestPoolTvlUsd * maxFlashTvlFraction;
  const profitabilityTargetEdgeBps = numberEnv("LIVE_PROFITABILITY_TARGET_EDGE_BPS", 50);
  const configuredMinTradeUsd = numberEnv("LIVE_MIN_FLASH_TRADE_USD", 0);
  const economicMinTradeUsd = Math.max(
    configuredMinTradeUsd,
    profitabilityTargetEdgeBps > 0 ? requiredPremiumUsd * 10_000 / profitabilityTargetEdgeBps : 0,
  );
  const sizeFractions = parseNumberListEnv("FLASH_SIZE_SCAN_FRACTIONS", [0.001, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.15])
    .filter((fraction) => fraction <= maxFlashTvlFraction);
  if (!sizeFractions.includes(maxFlashTvlFraction)) sizeFractions.push(maxFlashTvlFraction);

  const candidates: number[] = [];
  for (const fraction of sizeFractions) {
    addUsdCandidate(candidates, lowestPoolTvlUsd * fraction, maxScannableTradeUsd);
  }
  addUsdCandidate(candidates, economicMinTradeUsd, maxScannableTradeUsd);
  addUsdCandidate(candidates, maxScannableTradeUsd, maxScannableTradeUsd);

  return {
    candidatesUsd: [...new Set(candidates.map((value) => Number(value.toFixed(8))))].sort((a, b) => a - b),
    economicMinTradeUsd,
    maxScannableTradeUsd,
    profitabilityTargetEdgeBps,
    economicSizeOk: economicMinTradeUsd <= maxScannableTradeUsd,
  };
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
  const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    try {
      logs.push(...await withTimeout(
        provider.getLogs({ ...filter, fromBlock: start, toBlock: end }),
        callTimeoutMs,
        "DISCOVERY_GET_LOGS",
      ));
    } catch {
      rejected += 1;
    }
  }
  return { logs, rejected };
}

type CachedDiscoveryLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash?: string;
  index?: number;
  logIndex?: number;
};

type DiscoveryCacheEntry = {
  fromBlock: number;
  toBlock: number;
  logs: CachedDiscoveryLog[];
};

type DiscoveryCache = Record<string, DiscoveryCacheEntry>;

let inMemoryDiscoveryCache: DiscoveryCache | null = null;
let discoveryCacheLoadedPath: string | null = null;
let discoveryCacheFilesystemBlocked = false;

function discoveryCacheEnabled() {
  return process.env.LIVE_DISCOVERY_CACHE_ENABLED !== "false";
}

function discoveryCachePath() {
  return process.env.LIVE_DISCOVERY_CACHE_PATH || path.join(process.cwd(), ".cache", "live-discovery-cache.json");
}

function discoveryCacheRefreshOverlapBlocks() {
  return Math.max(1, intEnv("LIVE_DISCOVERY_CACHE_REFRESH_OVERLAP_BLOCKS", 64));
}

function readDiscoveryCache(): DiscoveryCache {
  if (!discoveryCacheEnabled()) return {};
  const cachePath = discoveryCachePath();
  if (inMemoryDiscoveryCache !== null && discoveryCacheLoadedPath === cachePath) return inMemoryDiscoveryCache;
  try {
    if (discoveryCacheFilesystemBlocked || !fs.existsSync(cachePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as DiscoveryCache;
    inMemoryDiscoveryCache = parsed;
    discoveryCacheLoadedPath = cachePath;
    return parsed;
  } catch (error: any) {
    discoveryCacheFilesystemBlocked = true;
    console.warn(`[discovery-cache] Read skipped: ${error?.message || error}`);
    return {};
  }
}

function writeDiscoveryCache(cache: DiscoveryCache) {
  if (!discoveryCacheEnabled()) return;
  const cachePath = discoveryCachePath();
  inMemoryDiscoveryCache = cache;
  discoveryCacheLoadedPath = cachePath;
  if (discoveryCacheFilesystemBlocked) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cache)}\n`, "utf-8");
  } catch (error: any) {
    discoveryCacheFilesystemBlocked = true;
    console.warn(`[discovery-cache] Persist skipped: ${error?.message || error}`);
  }
}

function serializeLog(log: ethers.Log | any): CachedDiscoveryLog {
  return {
    address: String(log.address),
    topics: Array.from(log.topics || []),
    data: String(log.data || "0x"),
    blockNumber: Number(log.blockNumber || 0),
    transactionHash: log.transactionHash,
    index: log.index,
    logIndex: log.logIndex,
  };
}

async function getCachedLogs(
  provider: ethers.JsonRpcProvider,
  cacheKey: string,
  filter: Omit<ethers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
) {
  if (!discoveryCacheEnabled()) {
    return { ...(await safeGetLogs(provider, filter, fromBlock, toBlock, chunkSize)), cacheHit: false };
  }
  const cache = readDiscoveryCache();
  const entry = cache[cacheKey];
  const maxLogs = intEnv("LIVE_DISCOVERY_CACHE_MAX_LOGS", 50_000);
  const cachedLogs = entry?.logs?.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock) || [];
  const overlapBlocks = discoveryCacheRefreshOverlapBlocks();
  if (entry && entry.fromBlock <= fromBlock && entry.toBlock >= toBlock && toBlock <= entry.toBlock - overlapBlocks) {
    return { logs: cachedLogs, rejected: 0, cacheHit: true };
  }

  const fetchFrom = entry
    ? Math.max(fromBlock, Math.max(entry.fromBlock, entry.toBlock - overlapBlocks + 1))
    : fromBlock;
  const fetched = fetchFrom <= toBlock
    ? await safeGetLogs(provider, filter, fetchFrom, toBlock, chunkSize)
    : { logs: [] as ethers.Log[], rejected: 0 };
  const mergedByKey = new Map<string, CachedDiscoveryLog>();
  for (const log of entry?.logs || []) {
    const logKey = `${log.blockNumber}:${log.transactionHash || ""}:${log.logIndex ?? log.index ?? 0}:${log.address}:${log.topics.join(",")}`;
    mergedByKey.set(logKey, log);
  }
  for (const log of fetched.logs.map(serializeLog)) {
    const logKey = `${log.blockNumber}:${log.transactionHash || ""}:${log.logIndex ?? log.index ?? 0}:${log.address}:${log.topics.join(",")}`;
    mergedByKey.set(logKey, log);
  }
  const merged = [...mergedByKey.values()]
    .sort((left, right) => left.blockNumber - right.blockNumber || (left.logIndex ?? left.index ?? 0) - (right.logIndex ?? right.index ?? 0))
    .slice(-maxLogs);
  cache[cacheKey] = {
    fromBlock: Math.min(entry?.fromBlock ?? fromBlock, fromBlock),
    toBlock: Math.max(entry?.toBlock ?? toBlock, toBlock),
    logs: merged,
  };
  writeDiscoveryCache(cache);

  return {
    logs: merged.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
    rejected: fetched.rejected,
    cacheHit: cachedLogs.length > 0,
  };
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
    const scan = await getCachedLogs(provider, `flashloan-balancer:${vaultAddress}:${topic}`, { address: vaultAddress, topics: [topic] }, fromBlock, latestBlock, chunk);
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
    "QuickSwapV2:0x5757371414417b8c6caad45baef941abc7d3ab32:0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff:30;SushiSwapV2:0xc35DADB65012eC5796536bD9864eD8773aBc74C4:0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506:30;DfynV2:0xE7fb3e833eFE5F9c441105EB65ef8b261266423B:0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429:30;ApeSwapV2:0xCf083Be4164828f00cAE704EC15a36D711491284:0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607:30;RetroClassicV2:0x1fC46294195aA87F77fAE299A14Bd1728dC1Cca9:0x77F0e98e3F2F3134496C2B769f40c891351524d1:30",
  );
  const lookback = intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS);
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
  const pairQueryLimit = Math.max(1, intEnv("LIVE_DISCOVERY_V2_PAIR_QUERY_LIMIT", 80));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(V2_FACTORY_ABI);
  const topic = iface.getEvent("PairCreated")?.topicHash;

  for (const [venueName, factoryAddress, router, feeRaw] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const normalizedFactory = normalize(factoryAddress);
    const scan = topic
      ? await getCachedLogs(provider, `v2:${normalizedFactory}:${topic}`, { address: normalizedFactory, topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    for (const log of scan.logs) {
      try {
        const parsed = iface.parseLog(log);
        const pair = normalize(parsed?.args?.pair);
        if (seen.has(pair.toLowerCase())) continue;
        seen.add(pair.toLowerCase());
        await withTimeout(
          addV2Pair(provider, tokenCache, edges, stats, venueName, dexId, router, pair, Number(feeRaw || 30), latestBlock),
          callTimeoutMs,
          `V2_ADD_PAIR_${dexId}`,
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
    await runWithConcurrency(assetPairs.slice(0, pairQueryLimit), intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right]) => {
        try {
          const pair = normalize(await withTimeout(
            factory.getPair(left.address, right.address) as Promise<string>,
            callTimeoutMs,
            `V2_GET_PAIR_${dexId}`,
          ));
          if (pair === ZERO_ADDRESS || seen.has(pair.toLowerCase())) return;
          seen.add(pair.toLowerCase());
          await withTimeout(
            addV2Pair(provider, tokenCache, edges, stats, venueName, dexId, router, pair, Number(feeRaw || 30), latestBlock),
            callTimeoutMs,
            `V2_ADD_PAIR_${dexId}`,
          );
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
  quoter: string,
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
  const [balance0, balance1] = await Promise.all([
    tokenBalance(provider, token0.address, poolAddress).catch(() => 0n),
    tokenBalance(provider, token1.address, poolAddress).catch(() => 0n),
  ]);
  const syntheticReserve = BigInt(liquidity);
  const reserve0 = balance0 > 0n ? balance0 : syntheticReserve;
  const reserve1 = balance1 > 0n ? balance1 : syntheticReserve;
  const tvlUsd = estimateTvlUsd(token0, reserve0, token1, reserve1);
  const feeBps = Math.max(1, Math.floor(fee / 100));
  for (const [tokenIn, tokenOut] of [[token0, token1], [token1, token0]] as const) {
    const reserveIn = sameAddress(tokenIn.address, token0.address) ? reserve0 : reserve1;
    const reserveOut = sameAddress(tokenOut.address, token0.address) ? reserve0 : reserve1;
    addEdge(edges, stats, edgeBase({
      dexId,
      venueName,
      poolAddress,
      router,
      tokenIn,
      tokenOut,
      invariant: "V3_CONCENTRATED_LIQUIDITY",
      feeBps,
      reserveIn,
      reserveOut,
      tvlUsd,
      stateBlock,
      quoteAdapter: "quoteV3ExactInputSingle",
      calldataAdapter: "buildV3ExactInputSingleCalldata",
      executorTarget: router,
      extra: { v3Fee: fee, v3Quoter: quoter },
    }));
  }
}

async function discoverV3(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, edges: Map<string, Edge>, stats: DiscoveryStats, latestBlock: number, flashloanAssets: TokenMeta[]) {
  const sources = parseSourceList(
    "LIVE_DISCOVERY_V3_FACTORIES",
    `UniswapV3:0x1F98431c8aD98523631AE4a59f267346ea31F984:${ROUTE_ADAPTER_TARGETS.uniswapV3Router}:${ROUTE_ADAPTER_TARGETS.uniswapV3Quoter}:100,500,3000,10000;RetroV3:0x91e1B99072f238352f59e58de875691e20Dc19c1:0x1891783cb3497Fdad1F25C933225243c2c7c4102:0xddc9Ef56c6bf83F7116Fad5Fbc41272B07ac70C1:100,500,3000,10000`,
  );
  const lookback = intEnv("LIVE_DISCOVERY_LOOKBACK_BLOCKS", DEFAULT_DISCOVERY_LOOKBACK_BLOCKS);
  const chunk = Math.max(1, intEnv("LIVE_DISCOVERY_LOG_CHUNK_BLOCKS", DEFAULT_DISCOVERY_LOG_CHUNK_BLOCKS));
  const fromBlock = Math.max(0, latestBlock - lookback);
  const iface = new ethers.Interface(V3_FACTORY_ABI);
  const topic = iface.getEvent("PoolCreated")?.topicHash;

  for (const [venueName, factoryAddress, router, quoter, feeListRaw] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const maxPools = intEnv("LIVE_V3_MAX_POOLS", DEFAULT_V3_MAX_POOLS);
    const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
    const normalizedFactory = normalize(factoryAddress);
    const scan = topic
      ? await getCachedLogs(provider, `v3:${normalizedFactory}:${topic}`, { address: normalizedFactory, topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    const logPools: Array<{ pool: string; fee: number }> = [];
    for (const log of scan.logs) {
      if (seen.size >= maxPools) break;
      try {
        const parsed = iface.parseLog(log);
        const pool = normalize(parsed?.args?.pool);
        if (seen.has(pool.toLowerCase())) continue;
        seen.add(pool.toLowerCase());
        logPools.push({ pool, fee: Number(parsed?.args?.fee) });
      } catch {
        stats.rejectedMetadata += 1;
      }
    }
    await runWithConcurrency(logPools, intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ({ pool, fee }) => {
      try {
        await withTimeout(
          addV3Pool(provider, tokenCache, edges, stats, venueName, dexId, router, quoter || ROUTE_ADAPTER_TARGETS.uniswapV3Quoter, pool, fee, latestBlock),
          callTimeoutMs * 2,
          "V3_ADD_POOL",
        );
      } catch {
        stats.rejectedMetadata += 1;
      }
    });

    const fees = (feeListRaw || "100,500,3000,10000").split(",").map((fee) => Number(fee.trim())).filter(Number.isFinite);
    const poolQueryLimit = Math.max(1, intEnv("LIVE_DISCOVERY_V3_POOL_QUERY_LIMIT", 120));
    const poolQueries: Array<[TokenMeta, TokenMeta, number]> = [];
    for (let i = 0; i < flashloanAssets.length; i += 1) {
      for (let j = i + 1; j < flashloanAssets.length; j += 1) {
        for (const fee of fees) {
          poolQueries.push([flashloanAssets[i], flashloanAssets[j], fee]);
        }
      }
    }
    await runWithConcurrency(poolQueries.slice(0, poolQueryLimit), intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right, fee]) => {
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
              addV3Pool(provider, tokenCache, edges, stats, venueName, dexId, router, quoter || ROUTE_ADAPTER_TARGETS.uniswapV3Quoter, pool, fee, latestBlock),
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
  quoter: string,
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
  const [balance0, balance1] = await Promise.all([
    tokenBalance(provider, token0.address, poolAddress).catch(() => 0n),
    tokenBalance(provider, token1.address, poolAddress).catch(() => 0n),
  ]);
  const syntheticReserve = BigInt(liquidity);
  const reserve0 = balance0 > 0n ? balance0 : syntheticReserve;
  const reserve1 = balance1 > 0n ? balance1 : syntheticReserve;
  const tvlUsd = estimateTvlUsd(token0, reserve0, token1, reserve1);
  const feeBps = Math.max(1, Math.floor(Number(globalState.fee) / 100));
  for (const [tokenIn, tokenOut] of [[token0, token1], [token1, token0]] as const) {
    const reserveIn = sameAddress(tokenIn.address, token0.address) ? reserve0 : reserve1;
    const reserveOut = sameAddress(tokenOut.address, token0.address) ? reserve0 : reserve1;
    addEdge(edges, stats, edgeBase({
      dexId,
      venueName,
      poolAddress,
      router,
      tokenIn,
      tokenOut,
      invariant: "ALGEBRA_CONCENTRATED_LIQUIDITY",
      feeBps,
      reserveIn,
      reserveOut,
      tvlUsd,
      stateBlock,
      quoteAdapter: "quoteAlgebraExactInputSingle",
      calldataAdapter: "buildAlgebraExactInputSingleCalldata",
      executorTarget: router,
      extra: { algebraQuoter: quoter },
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

  for (const [venueName, factoryAddress, router, quoter] of sources) {
    if (!factoryAddress || !router) continue;
    const dexId = venueName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const factory = new ethers.Contract(factoryAddress, ALGEBRA_FACTORY_ABI, provider);
    const seen = new Set<string>();
    const maxPools = intEnv("LIVE_ALGEBRA_MAX_POOLS", DEFAULT_ALGEBRA_MAX_POOLS);
    const callTimeoutMs = intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS);
    const normalizedFactory = normalize(factoryAddress);
    const scan = topic
      ? await getCachedLogs(provider, `algebra:${normalizedFactory}:${topic}`, { address: normalizedFactory, topics: [topic] }, fromBlock, latestBlock, chunk)
      : { logs: [], rejected: 0 };
    stats.rejectedLogScan += scan.rejected;
    const logPools: string[] = [];
    for (const log of scan.logs) {
      if (seen.size >= maxPools) break;
      try {
        const parsed = iface.parseLog(log);
        const pool = normalize(parsed?.args?.pool);
        if (seen.has(pool.toLowerCase())) continue;
        seen.add(pool.toLowerCase());
        logPools.push(pool);
      } catch {
        stats.rejectedMetadata += 1;
      }
    }
    await runWithConcurrency(logPools, intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async (pool) => {
      try {
        await withTimeout(
          addAlgebraPool(provider, tokenCache, edges, stats, venueName, dexId, router, quoter || ROUTE_ADAPTER_TARGETS.algebraQuoter, pool, latestBlock),
          callTimeoutMs * 2,
          "ALGEBRA_ADD_POOL",
        );
      } catch {
        stats.rejectedMetadata += 1;
      }
    });
    const pairQueryLimit = Math.max(1, intEnv("LIVE_DISCOVERY_ALGEBRA_PAIR_QUERY_LIMIT", 120));
    const assetPairs: Array<[TokenMeta, TokenMeta]> = [];
    for (let i = 0; i < flashloanAssets.length; i += 1) {
      for (let j = i + 1; j < flashloanAssets.length; j += 1) {
        assetPairs.push([flashloanAssets[i], flashloanAssets[j]]);
      }
    }
    await runWithConcurrency(assetPairs.slice(0, pairQueryLimit), intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY), async ([left, right]) => {
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
            addAlgebraPool(provider, tokenCache, edges, stats, venueName, dexId, router, quoter || ROUTE_ADAPTER_TARGETS.algebraQuoter, pool, latestBlock),
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
  const normalizedVault = normalize(vaultAddress);
  const scan = await getCachedLogs(provider, `balancer:${normalizedVault}:${topic}`, { address: normalizedVault, topics: [topic] }, fromBlock, latestBlock, chunk);
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
  const minPriceAnchorUsd = numberEnv("PRICE_DERIVATION_MIN_ANCHOR_USD", 100);
  for (let pass = 0; pass < 6 && changed; pass += 1) {
    changed = false;
    const candidates = new Map<string, Array<{ value: number; weight: number }>>();
    for (const edge of edges) {
      const tokenIn = tokenCache.get(edge.tokenIn.toLowerCase());
      const tokenOut = tokenCache.get(edge.tokenOut.toLowerCase());
      if (!tokenIn || !tokenOut) continue;
      if (edge.reserveIn <= 0n || edge.reserveOut <= 0n) continue;
      const inUnits = rawToFloat(edge.reserveIn, tokenIn.decimals);
      const outUnits = rawToFloat(edge.reserveOut, tokenOut.decimals);
      if (inUnits <= 0 || outUnits <= 0) continue;
      if (tokenIn.priceUsd && !tokenOut.priceUsd) {
        const weight = inUnits * tokenIn.priceUsd;
        const value = weight / outUnits;
        if (weight >= minPriceAnchorUsd && priceWithinBounds(tokenOut.symbol, value)) {
          const list = candidates.get(tokenOut.address.toLowerCase()) || [];
          list.push({ value, weight });
          candidates.set(tokenOut.address.toLowerCase(), list);
        }
      }
      if (tokenOut.priceUsd && !tokenIn.priceUsd) {
        const weight = outUnits * tokenOut.priceUsd;
        const value = weight / inUnits;
        if (weight >= minPriceAnchorUsd && priceWithinBounds(tokenIn.symbol, value)) {
          const list = candidates.get(tokenIn.address.toLowerCase()) || [];
          list.push({ value, weight });
          candidates.set(tokenIn.address.toLowerCase(), list);
        }
      }
    }
    for (const [address, values] of candidates) {
      const token = tokenCache.get(address);
      if (!token || token.priceUsd) continue;
      const derived = weightedMedian(values);
      if (derived !== undefined) {
        token.priceUsd = derived;
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

async function fastPreSendRevalidate(provider: ethers.JsonRpcProvider, edge: Edge, currentBlock: number, maxStateAgeBlocks: number): Promise<PreSendResult> {
  if (currentBlock - edge.stateBlock > maxStateAgeBlocks) {
    return { ok: false, error: "POOL_STATE_STALE", currentBlock };
  }
  if (edge.reserveIn <= 0n || edge.reserveOut <= 0n) {
    return { ok: false, error: "POOL_ZERO_LIQUIDITY", currentBlock };
  }
  if (!edge.calldataAdapter || !edge.quoteAdapter) {
    return { ok: false, error: "POOL_ADAPTER_MISSING", currentBlock };
  }
  try {
    if (edge.invariant === "V2_CPMM") {
      const pair = new ethers.Contract(edge.poolAddress, V2_PAIR_ABI, provider);
      const reserves = await pair.getReserves();
      if (BigInt(reserves.reserve0) <= 0n || BigInt(reserves.reserve1) <= 0n) {
        return { ok: false, error: "V2_ZERO_LIVE_RESERVES", currentBlock };
      }
      return { ok: true, currentBlock };
    }

    if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
      const pool = new ethers.Contract(edge.poolAddress, V3_POOL_ABI, provider);
      const strictFee = boolEnv("LIVE_PRESEND_STRICT_V3_FEE", false);
      const reads = strictFee
        ? await Promise.all([pool.fee(), pool.liquidity(), pool.slot0()])
        : await Promise.all([Promise.resolve(edge.extra?.v3Fee ?? edge.feeBps * 100), pool.liquidity(), pool.slot0()]);
      const [fee, liquidity, slot0] = reads;
      if (strictFee) {
        const expectedFee = edge.extra?.v3Fee ?? (edge.feeBps > 100 ? edge.feeBps : edge.feeBps * 100);
        if (Number(fee) !== expectedFee && expectedFee > 0) {
          return { ok: false, error: "V3_FEE_MISMATCH", currentBlock };
        }
      }
      if (BigInt(liquidity) <= 0n) return { ok: false, error: "V3_ZERO_LIQUIDITY", currentBlock };
      if (BigInt(slot0.sqrtPriceX96) <= 0n || slot0.unlocked === false) return { ok: false, error: "V3_INVALID_SLOT0", currentBlock };
      return { ok: true, currentBlock };
    }

    if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
      const pool = new ethers.Contract(edge.poolAddress, ALGEBRA_POOL_ABI, provider);
      const [liquidity, globalState] = await Promise.all([pool.liquidity(), pool.globalState()]);
      if (BigInt(liquidity) <= 0n) return { ok: false, error: "ALGEBRA_ZERO_LIQUIDITY", currentBlock };
      if (BigInt(globalState.price) <= 0n || globalState.unlocked === false) return { ok: false, error: "ALGEBRA_INVALID_GLOBAL_STATE", currentBlock };
      return { ok: true, currentBlock };
    }

    return await preSendRevalidate(provider, edge, maxStateAgeBlocks);
  } catch (error: any) {
    return { ok: false, error: error?.reason || error?.shortMessage || error?.message || "FAST_PRE_SEND_REVALIDATION_FAILED", currentBlock };
  }
}

function staticPreSendGate(edge: Edge, currentBlock: number, maxStateAgeBlocks: number): PreSendResult | undefined {
  if (currentBlock - edge.stateBlock > maxStateAgeBlocks) {
    return { ok: false, error: "POOL_STATE_STALE", currentBlock };
  }
  if (edge.reserveIn <= 0n || edge.reserveOut <= 0n) {
    return { ok: false, error: "POOL_ZERO_LIQUIDITY", currentBlock };
  }
  if (!edge.calldataAdapter || !edge.quoteAdapter) {
    return { ok: false, error: "POOL_ADAPTER_MISSING", currentBlock };
  }
  return undefined;
}

async function buildBatchedPreSendCache(
  provider: ethers.JsonRpcProvider,
  edges: Edge[],
  currentBlock: number,
  maxStateAgeBlocks: number,
): Promise<Map<string, PreSendResult>> {
  const cache = new Map<string, PreSendResult>();
  if (!boolEnv("LIVE_PRESEND_MULTICALL", true)) return cache;

  const v2Iface = new ethers.Interface(V2_PAIR_ABI);
  const v3Iface = new ethers.Interface(V3_POOL_ABI);
  const algebraIface = new ethers.Interface(ALGEBRA_POOL_ABI);
  type Descriptor = { key: string; edge: Edge; calls: Array<"fee" | "globalState" | "liquidity" | "reserves" | "slot0"> };
  const descriptors: Descriptor[] = [];
  const seenPools = new Set<string>();
  const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
  const callCursor: Array<{ descriptorIndex: number; kind: Descriptor["calls"][number] }> = [];
  const strictV3Fee = boolEnv("LIVE_PRESEND_STRICT_V3_FEE", false);

  for (const edge of edges) {
    const key = preSendPoolKey(edge);
    if (seenPools.has(key)) continue;
    seenPools.add(key);
    const staticResult = staticPreSendGate(edge, currentBlock, maxStateAgeBlocks);
    if (staticResult) {
      cache.set(key, staticResult);
      continue;
    }

    const descriptor: Descriptor = { key, edge, calls: [] };
    if (edge.invariant === "V2_CPMM") {
      descriptor.calls.push("reserves");
      calls.push({ target: edge.poolAddress, allowFailure: true, callData: v2Iface.encodeFunctionData("getReserves") });
      callCursor.push({ descriptorIndex: descriptors.length, kind: "reserves" });
    } else if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
      if (strictV3Fee) {
        descriptor.calls.push("fee");
        calls.push({ target: edge.poolAddress, allowFailure: true, callData: v3Iface.encodeFunctionData("fee") });
        callCursor.push({ descriptorIndex: descriptors.length, kind: "fee" });
      }
      descriptor.calls.push("liquidity", "slot0");
      calls.push({ target: edge.poolAddress, allowFailure: true, callData: v3Iface.encodeFunctionData("liquidity") });
      callCursor.push({ descriptorIndex: descriptors.length, kind: "liquidity" });
      calls.push({ target: edge.poolAddress, allowFailure: true, callData: v3Iface.encodeFunctionData("slot0") });
      callCursor.push({ descriptorIndex: descriptors.length, kind: "slot0" });
    } else if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
      descriptor.calls.push("liquidity", "globalState");
      calls.push({ target: edge.poolAddress, allowFailure: true, callData: algebraIface.encodeFunctionData("liquidity") });
      callCursor.push({ descriptorIndex: descriptors.length, kind: "liquidity" });
      calls.push({ target: edge.poolAddress, allowFailure: true, callData: algebraIface.encodeFunctionData("globalState") });
      callCursor.push({ descriptorIndex: descriptors.length, kind: "globalState" });
    }

    if (descriptor.calls.length > 0) descriptors.push(descriptor);
  }

  if (calls.length === 0) return cache;

  const multicallAddress = normalize(process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS);
  const multicall = new ethers.Contract(multicallAddress, MULTICALL3_ABI, provider);
  const chunkSize = Math.max(1, intEnv("LIVE_PRESEND_MULTICALL_CHUNK_SIZE", 160));
  const callTimeoutMs = intEnv("LIVE_PRESEND_MULTICALL_TIMEOUT_MS", intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS));
  const rawResults: Array<{ success: boolean; returnData: string } | undefined> = new Array(calls.length);

  for (let start = 0; start < calls.length; start += chunkSize) {
    const chunk = calls.slice(start, start + chunkSize);
    try {
      const result = await withTimeout(
        multicall.aggregate3(chunk),
        callTimeoutMs,
        "PRESEND_MULTICALL",
      ) as Array<{ success: boolean; returnData: string }>;
      result.forEach((item, offset) => {
        rawResults[start + offset] = item;
      });
    } catch {
      // Leave this chunk uncovered so per-pool validation can retry through the existing path.
    }
  }

  const decoded = new Map<string, any>();
  for (let index = 0; index < callCursor.length; index += 1) {
    const result = rawResults[index];
    if (!result?.success || !result.returnData || result.returnData === "0x") continue;
    const cursor = callCursor[index];
    const descriptor = descriptors[cursor.descriptorIndex];
    const slot = `${descriptor.key}:${cursor.kind}`;
    try {
      if (descriptor.edge.invariant === "V2_CPMM" && cursor.kind === "reserves") {
        decoded.set(slot, v2Iface.decodeFunctionResult("getReserves", result.returnData));
      } else if (descriptor.edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
        decoded.set(slot, v3Iface.decodeFunctionResult(cursor.kind, result.returnData));
      } else if (descriptor.edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
        decoded.set(slot, algebraIface.decodeFunctionResult(cursor.kind, result.returnData));
      }
    } catch {
      // Decode failure leaves the pool for fallback validation.
    }
  }

  for (const descriptor of descriptors) {
    if (cache.has(descriptor.key)) continue;
    const { edge, key } = descriptor;
    if (edge.invariant === "V2_CPMM") {
      const reserves = decoded.get(`${key}:reserves`);
      if (!reserves) continue;
      cache.set(key, BigInt(reserves[0]) > 0n && BigInt(reserves[1]) > 0n
        ? { ok: true, currentBlock }
        : { ok: false, error: "V2_ZERO_LIVE_RESERVES", currentBlock });
      continue;
    }

    if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
      const liquidity = decoded.get(`${key}:liquidity`);
      const slot0 = decoded.get(`${key}:slot0`);
      if (!liquidity || !slot0) continue;
      if (strictV3Fee) {
        const fee = decoded.get(`${key}:fee`);
        const expectedFee = edge.extra?.v3Fee ?? (edge.feeBps > 100 ? edge.feeBps : edge.feeBps * 100);
        if (!fee || (Number(fee[0]) !== expectedFee && expectedFee > 0)) {
          cache.set(key, { ok: false, error: "V3_FEE_MISMATCH", currentBlock });
          continue;
        }
      }
      cache.set(key, BigInt(liquidity[0]) > 0n && BigInt(slot0[0]) > 0n && slot0[6] !== false
        ? { ok: true, currentBlock }
        : { ok: false, error: BigInt(liquidity[0]) <= 0n ? "V3_ZERO_LIQUIDITY" : "V3_INVALID_SLOT0", currentBlock });
      continue;
    }

    if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
      const liquidity = decoded.get(`${key}:liquidity`);
      const globalState = decoded.get(`${key}:globalState`);
      if (!liquidity || !globalState) continue;
      cache.set(key, BigInt(liquidity[0]) > 0n && BigInt(globalState[0]) > 0n && globalState[6] !== false
        ? { ok: true, currentBlock }
        : { ok: false, error: BigInt(liquidity[0]) <= 0n ? "ALGEBRA_ZERO_LIQUIDITY" : "ALGEBRA_INVALID_GLOBAL_STATE", currentBlock });
    }
  }

  return cache;
}

async function preSendCheckpoint(
  provider: ethers.JsonRpcProvider,
  tokenCache: Map<string, TokenMeta>,
  allEdges: Edge[],
  stats: DiscoveryStats,
  seenPreSend: Set<string>,
  liveEdges: Map<string, Edge>,
  phase: string,
) {
  console.log(`LIVE_CYCLE_PHASE|phase=${phase}_PRICE_DERIVATION_START|edges=${allEdges.length}`);
  await derivePrices(provider, tokenCache, allEdges);
  const maxStateAgeBlocks = intEnv("LIVE_ROUTE_MAX_STATE_AGE_BLOCKS", DEFAULT_ROUTE_MAX_STATE_AGE_BLOCKS);
  const preSendTimeoutMs = intEnv("LIVE_PRESEND_REVALIDATION_TIMEOUT_MS", intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS));
  const minRoutePoolTvlUsd = numberEnv("ROUTE_MIN_POOL_TVL_USD", numberEnv("MIN_POOL_TVL_USD", 5000));
  const eligibleEdges = allEdges.filter((edge) => Number.isFinite(edge.tvlUsd) && edge.tvlUsd >= minRoutePoolTvlUsd);
  const newEdges = eligibleEdges.filter((edge) => !seenPreSend.has(edgeRuntimeKey(edge)));
  stats.rejectedLowTvlEdge = allEdges.length - eligibleEdges.length;
  console.log(`LIVE_CYCLE_PHASE|phase=${phase}_PRESEND_REVALIDATION_START|edges=${newEdges.length}|eligibleEdges=${eligibleEdges.length}|lowTvlRejected=${stats.rejectedLowTvlEdge}|minRoutePoolTvlUsd=${minRoutePoolTvlUsd}`);
  const currentBlock = await provider.getBlockNumber();
  const poolValidationCache = new Map<string, Promise<PreSendResult>>();
  const fastPath = boolEnv("LIVE_PRESEND_FAST_PATH", true);
  if (fastPath) {
    const batchCache = await buildBatchedPreSendCache(provider, newEdges, currentBlock, maxStateAgeBlocks);
    for (const [key, result] of batchCache) poolValidationCache.set(key, Promise.resolve(result));
    if (batchCache.size > 0) {
      console.log(`LIVE_CYCLE_PHASE|phase=${phase}_PRESEND_BATCH_CACHE|pools=${batchCache.size}|edges=${newEdges.length}`);
    }
  }
  const validateEdge = (edge: Edge) => {
    if (!fastPath) return preSendRevalidate(provider, edge, maxStateAgeBlocks);
    const poolKey = preSendPoolKey(edge);
    const cached = poolValidationCache.get(poolKey);
    if (cached) return cached;
    const validation = fastPreSendRevalidate(provider, edge, currentBlock, maxStateAgeBlocks);
    poolValidationCache.set(poolKey, validation);
    return validation;
  };
  await runWithConcurrency(newEdges, intEnv("LIVE_PRESEND_REVALIDATION_CONCURRENCY", intEnv("LIVE_DISCOVERY_CONCURRENCY", DEFAULT_DISCOVERY_CONCURRENCY)), async (edge) => {
    const key = edgeRuntimeKey(edge);
    seenPreSend.add(key);
    const result = await withTimeout(
      validateEdge(edge),
      preSendTimeoutMs,
      `PRESEND_REVALIDATE_${edge.invariant}`,
    ).catch((error) => ({ ok: false, error: error?.message }));
    if (!result.ok) {
      stats.rejectedPreSend += 1;
      const reason = String(result.error || "PRE_SEND_REVALIDATION_FAILED");
      stats.preSendRejectReasons[reason] = (stats.preSendRejectReasons[reason] || 0) + 1;
      return;
    }
    liveEdges.set(key, edge);
  });
  console.log(`LIVE_CYCLE_PHASE|phase=${phase}_PRESEND_REVALIDATION_END|liveEdges=${liveEdges.size}|checked=${seenPreSend.size}|preSendRejects=${stats.rejectedPreSend}`);
}

async function discoverGraph(provider: ethers.JsonRpcProvider) {
  console.log("LIVE_CYCLE_PHASE|phase=DISCOVERY_GRAPH_START");
  const startedAt = Date.now();
  const maxRuntimeMs = intEnv("LIVE_DISCOVERY_MAX_RUNTIME_MS", 600_000);
  const preSendReserveMs = Math.min(
    Math.max(30_000, Math.floor(maxRuntimeMs / 5)),
    intEnv("LIVE_DISCOVERY_PRESEND_RESERVE_MS", 120_000),
  );
  const discoveryPhaseRuntimeMs = Math.max(1, maxRuntimeMs - preSendReserveMs);
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
    rejectedLowTvlEdge: 0,
    rejectedLogScan: 0,
    rejectedPreSend: 0,
    preSendRejectReasons: {},
    forcedDiscoveryTokens: 0,
    routeCyclesEnumerated: 0,
    routeCyclesRejectedRepeatedPool: 0,
    routeCyclesRejectedRepeatedToken: 0,
    routeCyclesRejectedNonFlashloan: 0,
    routeCyclesRejectedVenueDiversity: 0,
    routeCyclesRejectedConsecutiveVenue: 0,
    routeCyclesRejectedTvl: 0,
    routeCyclesRejectedQuote: 0,
    routeQuoteRejectReasons: {},
    minRoutePoolTvlUsd: 0,
    truncated: false,
    sourceCounts: {},
  };
  console.log(`LIVE_CYCLE_PHASE|phase=FLASHLOAN_LIQUIDITY_START|block=${latestBlock}`);
  const forcedDiscoveryTokens = await loadForcedDiscoveryTokens(provider, tokenCache);
  stats.forcedDiscoveryTokens = forcedDiscoveryTokens.length;
  const flashloanBook = await withBudget(startedAt, maxRuntimeMs, "FLASHLOAN_LIQUIDITY", () =>
    discoverFlashloanLiquidity(provider, tokenCache, latestBlock)
  ).catch((error) => {
    stats.truncated = true;
    console.log(`LIVE_CYCLE_PHASE|phase=FLASHLOAN_LIQUIDITY_TIMEOUT|error=${String(error?.message || error)}`);
    return {
      ordered: [] as FlashloanLiquidity[],
      byAsset: new Map<string, FlashloanLiquidity[]>(),
      balancer: [] as FlashloanLiquidity[],
      aave: [] as FlashloanLiquidity[],
    };
  });
  const flashloanAssets = Array.from(new Map(flashloanBook.ordered.map((item) => [item.asset.address.toLowerCase(), item.asset])).values());
  const discoveryAssets = mergeTokenLists(forcedDiscoveryTokens, flashloanAssets);
  stats.flashloanAssets = flashloanAssets.length;
  stats.flashloanBalancerAssets = flashloanBook.balancer.length;
  stats.flashloanAaveAssets = flashloanBook.aave.length;
  const edges = new Map<string, Edge>();
  const phaseCheckpoints = boolEnv("LIVE_DISCOVERY_PHASED_CHECKPOINTS", true);
  const seenPreSend = new Set<string>();
  const liveEdgeMap = new Map<string, Edge>();
  const checkpoint = async (phase: string) => {
    if (!phaseCheckpoints) return;
    await withBudget(startedAt, maxRuntimeMs, `${phase}_PRESEND`, () =>
      preSendCheckpoint(provider, tokenCache, Array.from(edges.values()), stats, seenPreSend, liveEdgeMap, phase)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=${phase}_PRESEND_TIMEOUT|error=${String(error?.message || error)}|checkpointLiveEdges=${liveEdgeMap.size}`);
    });
  };
  const budgetExpired = (phase: string) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs <= maxRuntimeMs) return false;
    stats.truncated = true;
    console.log(`LIVE_CYCLE_PHASE|phase=DISCOVERY_BUDGET_STOP|after=${phase}|elapsedMs=${elapsedMs}|maxRuntimeMs=${maxRuntimeMs}|checkpointLiveEdges=${liveEdgeMap.size}`);
    return true;
  };

  if (boolEnv("LIVE_DISCOVERY_ENABLE_V2", false)) {
    console.log(`LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_START|flashloanAssets=${flashloanAssets.length}|forcedTokens=${forcedDiscoveryTokens.length}|pairUniverse=${discoveryAssets.length}`);
    await withBudget(startedAt, discoveryPhaseRuntimeMs, "V2", () =>
      discoverV2(provider, tokenCache, edges, stats, latestBlock, discoveryAssets)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_TIMEOUT|error=${String(error?.message || error)}|edges=${edges.size}`);
    });
    console.log(`LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_END|edges=${edges.size}`);
    await checkpoint("V2");
    if (budgetExpired("V2")) {
      stats.tokens = tokenCache.size;
      stats.discoveredEdges = liveEdgeMap.size;
      stats.discoveredPools = new Set(Array.from(liveEdgeMap.values()).map((edge) => edge.poolAddress.toLowerCase())).size;
      return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: Array.from(liveEdgeMap.values()), stats };
    }
  } else {
    console.log("LIVE_CYCLE_PHASE|phase=V2_DISCOVERY_SKIPPED|reason=V2_COMPATIBILITY_LANE_DISABLED|enableWith=LIVE_DISCOVERY_ENABLE_V2_TRUE");
  }
  if (boolEnv("LIVE_DISCOVERY_ENABLE_V3", true)) {
    console.log("LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_START");
    await withBudget(startedAt, discoveryPhaseRuntimeMs, "V3", () =>
      discoverV3(provider, tokenCache, edges, stats, latestBlock, discoveryAssets)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_TIMEOUT|error=${String(error?.message || error)}|edges=${edges.size}`);
    });
    console.log(`LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_END|edges=${edges.size}`);
    await checkpoint("V3");
    if (budgetExpired("V3")) {
      stats.tokens = tokenCache.size;
      stats.discoveredEdges = liveEdgeMap.size;
      stats.discoveredPools = new Set(Array.from(liveEdgeMap.values()).map((edge) => edge.poolAddress.toLowerCase())).size;
      return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: Array.from(liveEdgeMap.values()), stats };
    }
  } else {
    console.log("LIVE_CYCLE_PHASE|phase=V3_DISCOVERY_SKIPPED|reason=VENUE_DISABLED|enableWith=LIVE_DISCOVERY_ENABLE_V3_TRUE");
  }
  if (boolEnv("LIVE_DISCOVERY_ENABLE_ALGEBRA", true)) {
    console.log("LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_START");
    await withBudget(startedAt, discoveryPhaseRuntimeMs, "ALGEBRA", () =>
      discoverAlgebra(provider, tokenCache, edges, stats, latestBlock, discoveryAssets)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_TIMEOUT|error=${String(error?.message || error)}|edges=${edges.size}`);
    });
    console.log(`LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_END|edges=${edges.size}`);
    await checkpoint("ALGEBRA");
    if (budgetExpired("ALGEBRA")) {
      stats.tokens = tokenCache.size;
      stats.discoveredEdges = liveEdgeMap.size;
      stats.discoveredPools = new Set(Array.from(liveEdgeMap.values()).map((edge) => edge.poolAddress.toLowerCase())).size;
      return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: Array.from(liveEdgeMap.values()), stats };
    }
  } else {
    console.log("LIVE_CYCLE_PHASE|phase=ALGEBRA_DISCOVERY_SKIPPED|reason=VENUE_DISABLED|enableWith=LIVE_DISCOVERY_ENABLE_ALGEBRA_TRUE");
  }
  if (boolEnv("LIVE_DISCOVERY_ENABLE_CURVE", true)) {
    console.log("LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_START");
    await withBudget(startedAt, discoveryPhaseRuntimeMs, "CURVE", () =>
      discoverCurve(provider, tokenCache, edges, stats, latestBlock)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_TIMEOUT|error=${String(error?.message || error)}|edges=${edges.size}`);
    });
    console.log(`LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_END|edges=${edges.size}`);
    await checkpoint("CURVE");
    if (budgetExpired("CURVE")) {
      stats.tokens = tokenCache.size;
      stats.discoveredEdges = liveEdgeMap.size;
      stats.discoveredPools = new Set(Array.from(liveEdgeMap.values()).map((edge) => edge.poolAddress.toLowerCase())).size;
      return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: Array.from(liveEdgeMap.values()), stats };
    }
  } else {
    console.log("LIVE_CYCLE_PHASE|phase=CURVE_DISCOVERY_SKIPPED|reason=VENUE_DISABLED|enableWith=LIVE_DISCOVERY_ENABLE_CURVE_TRUE");
  }
  if (boolEnv("LIVE_DISCOVERY_ENABLE_BALANCER", true)) {
    console.log("LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_START");
    await withBudget(startedAt, discoveryPhaseRuntimeMs, "BALANCER", () =>
      discoverBalancer(provider, tokenCache, edges, stats, latestBlock)
    ).catch((error) => {
      stats.truncated = true;
      console.log(`LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_TIMEOUT|error=${String(error?.message || error)}|edges=${edges.size}`);
    });
    console.log(`LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_END|edges=${edges.size}`);
    await checkpoint("BALANCER");
  } else {
    console.log("LIVE_CYCLE_PHASE|phase=BALANCER_DISCOVERY_SKIPPED|reason=VENUE_DISABLED|enableWith=LIVE_DISCOVERY_ENABLE_BALANCER_TRUE");
  }

  if (!phaseCheckpoints) {
    await preSendCheckpoint(provider, tokenCache, Array.from(edges.values()), stats, seenPreSend, liveEdgeMap, "FINAL");
  }
  const liveEdges = Array.from(liveEdgeMap.values());
  stats.tokens = tokenCache.size;
  stats.discoveredEdges = liveEdges.length;
  stats.discoveredPools = new Set(liveEdges.map((edge) => edge.poolAddress.toLowerCase())).size;
  console.log(`LIVE_CYCLE_PHASE|phase=DISCOVERY_GRAPH_END|liveEdges=${liveEdges.length}|tokens=${tokenCache.size}`);
  return { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges: liveEdges, stats };
}

export async function discoverProductionPoolData(options: {
  provider?: ethers.JsonRpcProvider;
} = {}) {
  const provider = options.provider || new ethers.JsonRpcProvider(rpcUrl(), Number(CHAIN_ID), { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error(`CHAIN_ID_MISMATCH:${network.chainId}`);
  return await discoverGraph(provider);
}

async function quoteEdge(provider: ethers.JsonRpcProvider, edge: Edge, amountIn: bigint) {
  if (edge.invariant === "V2_CPMM") {
    return quoteV2Cpmm(amountIn, edge.reserveIn, edge.reserveOut, edge.feeBps);
  }
  if (edge.invariant === "V3_CONCENTRATED_LIQUIDITY") {
    return await quoteV3ExactInputSingle(provider, {
      quoter: edge.extra?.v3Quoter,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      fee: edge.extra?.v3Fee || edge.feeBps * 100,
      amountIn,
    });
  }
  if (edge.invariant === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
    return await quoteAlgebraExactInputSingle(provider, {
      quoter: edge.extra?.algebraQuoter,
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

function reverseRoute(route: Edge[]) {
  return [...route].reverse().map((edge) => reverseEdge(edge));
}

function routeFingerprint(route: Edge[]) {
  return route.map((edge) => `${edge.dexId}:${edge.poolAddress}:${edge.tokenIn}->${edge.tokenOut}:${edge.invariant}`).join("|").toLowerCase();
}

function routeVenueKeys(route: Edge[]) {
  return route.map((edge) => edge.dexId.toUpperCase());
}

function uniqueRouteVenues(route: Edge[]) {
  return new Set(routeVenueKeys(route));
}

function routeVenueDiversityOk(route: Edge[]) {
  if (!boolEnv("LIVE_ROUTE_REQUIRE_CROSS_VENUE", true)) return true;
  const minUniqueVenues = Math.max(1, intEnv("LIVE_ROUTE_MIN_UNIQUE_VENUES", 2));
  return uniqueRouteVenues(route).size >= minUniqueVenues;
}

function routeConsecutiveVenueOk(route: Edge[]) {
  if (!boolEnv("LIVE_ROUTE_REJECT_CONSECUTIVE_SAME_VENUE", true)) return true;
  for (let index = 1; index < route.length; index += 1) {
    if (route[index - 1].dexId.toUpperCase() === route[index].dexId.toUpperCase()) return false;
  }
  return true;
}

function quoteRoutePriority(route: Edge[]) {
  const lowestPoolTvlUsd = Math.min(...route.map((edge) => edge.tvlUsd).filter((value) => Number.isFinite(value) && value > 0));
  const pricedEdges = route.filter((edge) => Number.isFinite(edge.tokenInPriceUsd) || Number.isFinite(edge.tokenOutPriceUsd)).length;
  const venueDiversityBonus = uniqueRouteVenues(route).size * 20_000;
  const invariantBonus = route.reduce((sum, edge) => {
    if (edge.invariant === "V2_CPMM") return sum + 1;
    if (edge.invariant === "CURVE_STABLE_SWAP" || edge.invariant === "STABLE_SWAP") return sum + 2;
    if (edge.invariant === "BALANCER_WEIGHTED") return sum + 2;
    return sum + 3;
  }, 0);
  const routeLengthPenalty = route.length * 250;
  return (Number.isFinite(lowestPoolTvlUsd) ? lowestPoolTvlUsd : 0) + pricedEdges * 10_000 + venueDiversityBonus + invariantBonus * 1_000 - routeLengthPenalty;
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

function sameUndirectedPair(left: Edge, right: Edge) {
  return (sameAddress(left.tokenIn, right.tokenIn) && sameAddress(left.tokenOut, right.tokenOut))
    || (sameAddress(left.tokenIn, right.tokenOut) && sameAddress(left.tokenOut, right.tokenIn));
}

function enumerateCycles(flashloanAssets: TokenMeta[], edges: Edge[], stats: DiscoveryStats) {
  const byIn = buildAdjacency(edges);
  const maxHops = Math.max(2, Math.min(6, intEnv("MAX_ROUTE_HOPS", 4)));
  const maxCycles = intEnv("LIVE_ROUTE_MAX_CYCLES", DEFAULT_ROUTE_MAX_CYCLES);
  const configuredMaxCyclesPerAsset = optionalIntEnv("LIVE_ROUTE_MAX_CYCLES_PER_ASSET");
  const cycles: Edge[][] = [];
  const seenCycles = new Set<string>();
  const flashSet = new Set(flashloanAssets.map((asset) => asset.address.toLowerCase()));
  const orderedAssets = [...flashloanAssets].sort((left, right) => {
    const rightDegree = (byIn.get(right.address.toLowerCase()) || []).length;
    const leftDegree = (byIn.get(left.address.toLowerCase()) || []).length;
    return rightDegree - leftDegree;
  });
  const pushCycle = (route: Edge[]) => {
    if (cycles.length >= maxCycles) {
      stats.truncated = true;
      return false;
    }
    if (!routeVenueDiversityOk(route)) {
      stats.routeCyclesRejectedVenueDiversity += 1;
      return false;
    }
    if (!routeConsecutiveVenueOk(route)) {
      stats.routeCyclesRejectedConsecutiveVenue += 1;
      return false;
    }
    const fingerprint = routeFingerprint(route);
    if (seenCycles.has(fingerprint)) return false;
    seenCycles.add(fingerprint);
    cycles.push([...route]);
    stats.routeCyclesEnumerated += 1;
    return true;
  };

  for (let assetIndex = 0; assetIndex < orderedAssets.length; assetIndex += 1) {
    const asset = orderedAssets[assetIndex];
    const remainingAssets = orderedAssets.length - assetIndex;
    const remainingCycleBudget = Math.max(0, maxCycles - cycles.length);
    if (remainingCycleBudget <= 0) {
      stats.truncated = true;
      break;
    }
    const maxCyclesPerAsset = configuredMaxCyclesPerAsset ?? Math.max(1, Math.ceil(remainingCycleBudget / Math.max(1, remainingAssets)));
    let assetCycleCount = 0;
    const incrementAssetCycle = (route: Edge[]) => {
      if (assetCycleCount >= maxCyclesPerAsset) {
        stats.truncated = true;
        return false;
      }
      const pushed = pushCycle(route);
      if (pushed) assetCycleCount += 1;
      return pushed;
    };
    if (!flashSet.has(asset.address.toLowerCase())) {
      stats.routeCyclesRejectedNonFlashloan += 1;
      continue;
    }

    if (boolEnv("LIVE_ROUTE_PRIORITIZE_CROSS_VENUE_DOCTRINE", true)) {
      const firstLegs = byIn.get(asset.address.toLowerCase()) || [];
      for (const leg1 of firstLegs) {
        if (cycles.length >= maxCycles || assetCycleCount >= maxCyclesPerAsset) break;
        for (const leg2 of byIn.get(leg1.tokenOut.toLowerCase()) || []) {
          if (!sameAddress(leg2.tokenOut, asset.address)) continue;
          if (leg1.poolAddress.toLowerCase() === leg2.poolAddress.toLowerCase()) continue;
          if (leg1.dexId.toUpperCase() === leg2.dexId.toUpperCase()) {
            stats.routeCyclesRejectedVenueDiversity += 1;
            continue;
          }
          if (!sameUndirectedPair(leg1, leg2)) continue;
          incrementAssetCycle([leg1, leg2]);
        }
      }

      if (maxHops >= 3) {
        for (const leg1 of firstLegs) {
          if (cycles.length >= maxCycles || assetCycleCount >= maxCyclesPerAsset) break;
          for (const leg2 of byIn.get(leg1.tokenOut.toLowerCase()) || []) {
            if (cycles.length >= maxCycles || assetCycleCount >= maxCyclesPerAsset) break;
            if (sameAddress(leg2.tokenOut, asset.address) || sameAddress(leg2.tokenOut, leg1.tokenIn)) continue;
            if (leg1.poolAddress.toLowerCase() === leg2.poolAddress.toLowerCase()) continue;
            if (leg1.dexId.toUpperCase() === leg2.dexId.toUpperCase()) {
              stats.routeCyclesRejectedConsecutiveVenue += 1;
              continue;
            }
            for (const leg3 of byIn.get(leg2.tokenOut.toLowerCase()) || []) {
              if (!sameAddress(leg3.tokenOut, asset.address)) continue;
              if (new Set([leg1.poolAddress.toLowerCase(), leg2.poolAddress.toLowerCase(), leg3.poolAddress.toLowerCase()]).size < 3) continue;
              incrementAssetCycle([leg1, leg2, leg3]);
            }
          }
        }
      }

      if (boolEnv("LIVE_ROUTE_ONLY_DOCTRINE_CYCLES", true)) continue;
    }

    const walk = (currentToken: string, route: Edge[], usedPools: Set<string>, usedTokens: Set<string>) => {
      if (cycles.length >= maxCycles || assetCycleCount >= maxCyclesPerAsset) {
        stats.truncated = true;
        return;
      }
      if (route.length >= 2 && sameAddress(currentToken, asset.address)) {
        if (!routeVenueDiversityOk(route)) {
          stats.routeCyclesRejectedVenueDiversity += 1;
          return;
        }
        if (!routeConsecutiveVenueOk(route)) {
          stats.routeCyclesRejectedConsecutiveVenue += 1;
          return;
        }
        incrementAssetCycle(route);
      }
      if (route.length >= maxHops) return;
      for (const edge of byIn.get(currentToken.toLowerCase()) || []) {
        const tokenOutKey = edge.tokenOut.toLowerCase();
        const previousEdge = route[route.length - 1];
        if (previousEdge && boolEnv("LIVE_ROUTE_REJECT_CONSECUTIVE_SAME_VENUE", true) && previousEdge.dexId.toUpperCase() === edge.dexId.toUpperCase()) {
          stats.routeCyclesRejectedConsecutiveVenue += 1;
          continue;
        }
        if (usedPools.has(edge.poolAddress.toLowerCase())) {
          stats.routeCyclesRejectedRepeatedPool += 1;
          continue;
        }
        if (!sameAddress(edge.tokenOut, asset.address) && usedTokens.has(tokenOutKey)) {
          stats.routeCyclesRejectedRepeatedToken += 1;
          continue;
        }
        if (route.length + 1 === maxHops && !sameAddress(edge.tokenOut, asset.address)) {
          continue;
        }
        usedPools.add(edge.poolAddress.toLowerCase());
        usedTokens.add(tokenOutKey);
        route.push(edge);
        walk(edge.tokenOut, route, usedPools, usedTokens);
        route.pop();
        usedTokens.delete(tokenOutKey);
        usedPools.delete(edge.poolAddress.toLowerCase());
      }
    };
    walk(asset.address, [], new Set(), new Set([asset.address.toLowerCase()]));
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
  const slippageBps = BigInt(Math.floor(numberEnv("SLIPPAGE_BPS", 10)));
  const quoteEdgeTimeoutMs = intEnv("LIVE_QUOTE_EDGE_TIMEOUT_MS", intEnv("LIVE_RPC_CALL_TIMEOUT_MS", DEFAULT_RPC_CALL_TIMEOUT_MS));
  const deadline = Math.floor(Date.now() / 1000) + intEnv("EXECUTION_SUBMISSION_EXPIRY_SECONDS", 300);
  const maxFlashTvlFraction = numberEnv("SIM_MAX_FLASH_TVL_FRACTION", 0.15);
  const riskBufferUsd = numberEnv("RISK_BUFFER_USD", 0);
  const requiredPremiumUsd = gasCostUsd + riskBufferUsd + minProfitUsd;
  const {
    candidatesUsd,
    economicMinTradeUsd,
    maxScannableTradeUsd,
    profitabilityTargetEdgeBps,
    economicSizeOk,
  } = buildSizeUsdCandidates(lowestPoolTvlUsd, maxFlashTvlFraction, requiredPremiumUsd);
  if (boolEnv("LIVE_ENFORCE_ECONOMIC_MIN_FLASH", false) && !economicSizeOk) {
    throw new Error(`ECONOMIC_SIZE_CAP:${maxScannableTradeUsd.toFixed(6)}<${economicMinTradeUsd.toFixed(6)}@${profitabilityTargetEdgeBps}bps`);
  }

  let best: Candidate | null = null;
  const seenAmounts = new Set<string>();
  const sizeSearchCandidatesUsd: number[] = [];

  for (const targetUsd of candidatesUsd) {
    const targetAmountIn = floatToRaw(targetUsd / flashloanAsset.priceUsd, flashloanAsset.decimals);
    const flashloanLiquidity = liquidityOptions.find((item) => item.liquidity >= targetAmountIn) || liquidityOptions[0];
    const amountIn = targetAmountIn <= flashloanLiquidity.liquidity ? targetAmountIn : flashloanLiquidity.liquidity;
    if (amountIn <= 0n || seenAmounts.has(amountIn.toString())) continue;
    seenAmounts.add(amountIn.toString());
    sizeSearchCandidatesUsd.push(targetUsd);
    const flashFeeRaw = amountIn * flashloanLiquidity.feeBps / 10000n;

    let amount = amountIn;
    const steps: Array<Omit<RouteQuoteStep, "calldata">> = [];
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
      const amountOut = await withTimeout(
        quoteEdge(provider, edge, amount),
        quoteEdgeTimeoutMs,
        `QUOTE_${edge.invariant}`,
      );
      if (amountOut <= 0n) throw new Error("QUOTE_ZERO_OUTPUT");
      const minAmountOut = bpsMin(amountOut, slippageBps);
      steps.push({ edge, amountIn: amount, amountOut, minAmountOut });
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
    const routeSteps = buildRouteCalldataFromQuote({
      steps,
      flashloanAsset: flashloanAsset.address,
      receiver: targetContract,
      deadline,
    }) as RouteQuoteStep[];
    const priceVariance = evaluatePriceVarianceGate(routeSteps, flashloanAsset, grossProfitRaw);
    const grossProfitUsd = quoteUsd(grossProfitRaw, flashloanAsset);
    const flashFeeUsd = quoteUsd(flashFeeRaw, flashloanAsset);
    const requiredPremiumRaw = usdToRawCeil(requiredPremiumUsd, flashloanAsset);
    const requiredOutputRaw = requiredPremiumRaw === undefined ? undefined : repaymentRaw + requiredPremiumRaw;
    const repaymentUsd = quoteUsd(repaymentRaw, flashloanAsset);
    const requiredOutputUsd = requiredOutputRaw === undefined ? undefined : quoteUsd(requiredOutputRaw, flashloanAsset);
    const executableSurplusRaw = requiredOutputRaw === undefined ? undefined : amountOut - requiredOutputRaw;
    const executableSurplusUsd = executableSurplusRaw === undefined ? undefined : quoteUsd(executableSurplusRaw, flashloanAsset);
    const netProfitUsd = grossProfitUsd === undefined || flashFeeUsd === undefined
      ? undefined
      : grossProfitUsd - flashFeeUsd - gasCostUsd - riskBufferUsd;
    const thresholdOk = requiredOutputRaw !== undefined && amountOut > requiredOutputRaw;
    const status = priceVariance.ok && thresholdOk && netProfitUsd !== undefined && netProfitUsd >= minProfitUsd
      ? "EXECUTABLE_PROFIT_CANDIDATE"
      : "REJECTED_NO_PROFIT";
    const rejectionReason = status === "EXECUTABLE_PROFIT_CANDIDATE"
      ? "NONE"
      : !priceVariance.ok
        ? priceVariance.reason
      : requiredOutputRaw === undefined || netProfitUsd === undefined
        ? "EXECUTABLE_THRESHOLD_UNPRICED"
      : !thresholdOk
        ? `OUTPUT_BELOW_EXECUTABLE_THRESHOLD:${ethers.formatUnits(amountOut, flashloanAsset.decimals)}<=${ethers.formatUnits(requiredOutputRaw, flashloanAsset.decimals)}|deficitUsd=${Math.abs(executableSurplusUsd ?? 0).toFixed(6)}`
      : `NET_PROFIT_BELOW_MIN:${netProfitUsd.toFixed(6)}<${minProfitUsd}`;
    const candidate = {
      routeId: "",
      status,
      flashloanAsset,
      flashloanLiquidity,
      path: route.map((edge) => tokenCache.get(edge.tokenIn.toLowerCase())).filter(Boolean) as TokenMeta[],
      steps: routeSteps,
      amountIn,
      amountOut,
      repaymentRaw,
      repaymentUsd,
      requiredOutputRaw,
      requiredOutputUsd,
      executableSurplusRaw,
      executableSurplusUsd,
      grossProfitRaw,
      grossProfitUsd,
      gasCostUsd,
      economicMinTradeUsd,
      maxScannableTradeUsd,
      profitabilityTargetEdgeBps,
      economicSizeOk,
      flashFeeRaw,
      flashFeeUsd,
      riskBufferUsd,
      minProfitUsd,
      requiredPremiumUsd,
      netProfitUsd,
      lowestPoolTvlUsd,
      rejectionReason,
      sizingRule: "ECONOMIC_SIZE_LADDER: fractions + min economic trade + max route cap, capped by provider liquidity",
      sizeSearchCandidatesUsd: [...sizeSearchCandidatesUsd],
      priceVariance,
    } satisfies Candidate;
    if (!best || (candidate.netProfitUsd ?? Number.NEGATIVE_INFINITY) > (best.netProfitUsd ?? Number.NEGATIVE_INFINITY)) {
      best = candidate;
    }
  }

  if (!best) throw new Error("FLASHLOAN_SIZE_ZERO");
  best.sizeSearchCandidatesUsd = sizeSearchCandidatesUsd;
  return best;
}

async function rankCandidates(provider: ethers.JsonRpcProvider, tokenCache: Map<string, TokenMeta>, flashloanBook: Map<string, FlashloanLiquidity[]>, flashloanAssets: TokenMeta[], edges: Edge[], stats: DiscoveryStats, targetContract: string) {
  const cycles = enumerateCycles(flashloanAssets, edges, stats);
  const autoReverseEnabled = boolEnv("LIVE_ROUTE_AUTO_REVERSE", true);
  const quoteRoutes: Array<{ route: Edge[]; index: number; orientation: "DIRECT" | "AUTO_REVERSE"; reverseOf?: number; priority: number }> = [];
  const seenRouteFingerprints = new Set<string>();
  cycles.forEach((route, index) => {
    const directFingerprint = routeFingerprint(route);
    if (!seenRouteFingerprints.has(directFingerprint)) {
      seenRouteFingerprints.add(directFingerprint);
      quoteRoutes.push({ route, index, orientation: "DIRECT", priority: quoteRoutePriority(route) });
    }
    if (autoReverseEnabled) {
      const reversed = reverseRoute(route);
      const reverseFingerprint = routeFingerprint(reversed);
      if (!seenRouteFingerprints.has(reverseFingerprint)) {
        seenRouteFingerprints.add(reverseFingerprint);
        quoteRoutes.push({ route: reversed, index, orientation: "AUTO_REVERSE", reverseOf: index, priority: quoteRoutePriority(reversed) });
      }
    }
  });
  quoteRoutes.sort((left, right) => right.priority - left.priority || left.route.length - right.route.length || left.index - right.index);
  const gasPrice = await provider.getFeeData().then((fee) => fee.gasPrice || 0n).catch(() => 0n);
  const nativeUsd = numberEnv("NATIVE_TOKEN_USD", 1);
  const estimatedGasUnits = BigInt(intEnv("ESTIMATED_GAS_UNITS", 450000));
  const gasCostUsd = Number(estimatedGasUnits * gasPrice) / 1e18 * nativeUsd;
  const minProfitUsd = numberEnv("MIN_NET_PROFIT_USD", 5);
  const minRoutePoolTvlUsd = numberEnv("ROUTE_MIN_POOL_TVL_USD", numberEnv("MIN_POOL_TVL_USD", 5000));
  stats.minRoutePoolTvlUsd = minRoutePoolTvlUsd;
  const candidates: Candidate[] = [];
  const quoteLanes = intEnv("LIVE_QUOTE_LANES", DEFAULT_QUOTE_LANES);
  const routeQuoteTimeoutMs = intEnv("LIVE_ROUTE_QUOTE_TIMEOUT_MS", 45_000);
  const leg1Helpers = Math.max(1, Math.floor(quoteLanes / 2));
  const leg2Helpers = Math.max(1, quoteLanes - leg1Helpers);
  console.log(`LANE_TEAM_SUMMARY|quoteLanes=${quoteLanes}|leg1Helpers=${leg1Helpers}|leg2PlusHelpers=${leg2Helpers}|cycles=${cycles.length}|quoteRoutes=${quoteRoutes.length}|autoReverse=${autoReverseEnabled}|minRoutePoolTvlUsd=${minRoutePoolTvlUsd}|dependency=LEG2_REQUIRES_LEG1_OUTPUT`);

  await runWithConcurrency(quoteRoutes, quoteLanes, async ({ route, index, orientation, reverseOf }) => {
    try {
      const lowestPoolTvlUsd = Math.min(...route.map((edge) => edge.tvlUsd).filter((value) => Number.isFinite(value) && value > 0));
      if (!Number.isFinite(lowestPoolTvlUsd) || lowestPoolTvlUsd < minRoutePoolTvlUsd) {
        stats.routeCyclesRejectedTvl += 1;
        return;
      }
      const laneId = index % quoteLanes;
      const candidate = await withTimeout(
        quoteCandidate(provider, tokenCache, flashloanBook, route, targetContract, gasCostUsd, minProfitUsd, laneId),
        routeQuoteTimeoutMs,
        "ROUTE_QUOTE",
      );
      candidate.routeOrientation = orientation;
      candidate.reverseOf = reverseOf === undefined ? undefined : `cycle-${reverseOf}`;
      candidates.push(candidate);
    } catch (error: any) {
      stats.routeCyclesRejectedQuote += 1;
      const reason = String(error?.reason || error?.shortMessage || error?.message || "ROUTE_QUOTE_REJECTED").slice(0, 160);
      stats.routeQuoteRejectReasons[reason] = (stats.routeQuoteRejectReasons[reason] || 0) + 1;
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

export function candidateToLedgerPayload(candidate: Candidate) {
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
    routeOrientation: candidate.routeOrientation || "DIRECT",
    reverseOf: candidate.reverseOf,
    flashloanAsset: candidate.flashloanAsset.address,
    flashloanSymbol: candidate.flashloanAsset.symbol,
    flashloanProvider: candidate.flashloanLiquidity.provider,
    flashloanSource: candidate.flashloanLiquidity.sourceCode,
    flashloanAmountRaw: candidate.amountIn,
    leg1AmountInRaw: candidate.steps[0]?.amountIn,
    flashloanAmountEqualsLeg1: candidate.steps[0]?.amountIn === candidate.amountIn,
    routeShape: candidate.steps.length === 2 ? "A_B_A" : candidate.steps.length === 3 ? "A_B_C_A" : `A_${candidate.steps.length}_HOP_A`,
    routeAlgebra: candidate.steps.length === 2 ? "A->B->A" : candidate.steps.length === 3 ? "A->B->C->A" : routePath(candidate),
    c1Role: "ALWAYS_ON_HFT_CHAIN_WIDE_CAPTURE_ENGINE",
    c2Role: "CHILD_REACTION_LANE_ONLY_AFTER_CONFIRMED_C1",
    routeGuardKey: routeKeyFromC1Payload(
      candidate.flashloanAsset.address,
      candidate.steps.map((step) => ({
        venue: step.edge.executorTarget,
        tokenIn: step.edge.tokenIn,
        tokenOut: step.edge.tokenOut,
      })),
    ),
    amountIn: candidate.amountIn,
    amountOut: candidate.amountOut,
    repaymentRaw: candidate.repaymentRaw,
    repaymentUsd: candidate.repaymentUsd,
    requiredOutputRaw: candidate.requiredOutputRaw,
    requiredOutputUsd: candidate.requiredOutputUsd,
    executableSurplusRaw: candidate.executableSurplusRaw,
    executableSurplusUsd: candidate.executableSurplusUsd,
    economicMinTradeUsd: candidate.economicMinTradeUsd,
    maxScannableTradeUsd: candidate.maxScannableTradeUsd,
    profitabilityTargetEdgeBps: candidate.profitabilityTargetEdgeBps,
    economicSizeOk: candidate.economicSizeOk,
    grossProfitUsd: candidate.grossProfitUsd,
    flashFeeUsd: candidate.flashFeeUsd,
    gasCostUsd: candidate.gasCostUsd,
    riskBufferUsd: candidate.riskBufferUsd,
    minProfitUsd: candidate.minProfitUsd,
    requiredPremiumUsd: candidate.requiredPremiumUsd,
    netProfitUsd: candidate.netProfitUsd,
    profit_usd: candidate.netProfitUsd,
    lowestPoolTvlUsd: candidate.lowestPoolTvlUsd,
    priceVariance: candidate.priceVariance,
    reverseMathHint: candidate.priceVariance?.reverseMathHint,
    leg1BuyPrice: candidate.priceVariance?.leg1BuyPrice,
    leg2SellPrice: candidate.priceVariance?.leg2SellPrice,
    priceEdgeBps: candidate.priceVariance?.priceEdgeBps,
    pools: candidate.steps.map((step) => step.edge.poolAddress),
    reason: candidate.rejectionReason,
    chain_id: 137,
    executionReady: Boolean(candidate.c1ExecutionEligible),
    c1ExecutableLimitPerCycle: intEnv("C1_EXECUTABLE_LIMIT_PER_CYCLE", DEFAULT_C1_EXECUTABLE_LIMIT),
  };
}

export async function runDiscoveryCycle(options: {
  targetContract?: string;
  publish?: boolean;
  source?: string;
} = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl(), Number(CHAIN_ID), { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error(`CHAIN_ID_MISMATCH:${network.chainId}`);
  const targetContract = options.targetContract || (DEFAULT_C1_TARGET ? normalize(DEFAULT_C1_TARGET) : "");
  if (!targetContract) throw new Error("C1_TARGET_MISSING");

  const { latestBlock, tokenCache, flashloanAssets, flashloanBook, edges, stats } = await discoverGraph(provider);
  const { candidates, gasCostUsd, minProfitUsd } = await rankCandidates(provider, tokenCache, flashloanBook.byAsset, flashloanAssets, edges, stats, targetContract);
  const topRouteDisplayLimit = intEnv("TOP_ROUTE_DISPLAY_LIMIT", DEFAULT_TOP_ROUTE_DISPLAY_LIMIT);
  const ledgerPayloads = candidates.slice(0, topRouteDisplayLimit).map(candidateToLedgerPayload);
  if (options.publish !== false) {
    await publishOpportunitySnapshot(ledgerPayloads, options.source || "live-cycle-module");
  }
  return {
    latestBlock,
    targetContract,
    flashloanAssets,
    flashloanLiquidity: flashloanBook.ordered,
    edges,
    stats,
    candidates,
    ledgerPayloads,
    gasCostUsd,
    minProfitUsd,
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
    const reverseSteps: Array<Omit<RouteQuoteStep, "calldata">> = [];
    let amount = reverseFlashloanAmount;
    for (const reverse of [...candidate.steps].reverse().map((step) => reverseEdge(step.edge))) {
      const amountOut = await quoteEdge(provider, reverse, amount);
      if (amountOut <= 0n) throw new Error("REVERSE_QUOTE_ZERO_OUTPUT");
      const minAmountOut = bpsMin(amountOut, slippageBps);
      reverseSteps.push({ edge: reverse, amountIn: amount, amountOut, minAmountOut });
      amount = amountOut;
    }
    const reverseRouteSteps = buildRouteCalldataFromQuote({
      steps: reverseSteps,
      flashloanAsset: candidate.flashloanAsset.address,
      receiver: targetContract,
      deadline,
    }) as RouteQuoteStep[];

    const flashFeeRaw = reverseFlashloanAmount * candidate.flashloanLiquidity.feeBps / 10000n;
    const reverseContext = {
      profitAsset: candidate.flashloanAsset.address,
      minNetProfit: flashFeeRaw + 1n,
      nonce: c1Nonce + 1n,
      merkleRoot: ethers.ZeroHash,
      proof: [],
      steps: reverseRouteSteps.map((step) => ({
        venue: step.edge.executorTarget,
        tokenIn: step.edge.tokenIn,
        tokenOut: step.edge.tokenOut,
        amountIn: step.amountIn,
        minAmountOut: step.minAmountOut,
        callValue: 0n,
        payload: step.calldata,
      })),
    };

    const reversePathSymbols = reverseRouteSteps.map((step) => step.edge.tokenInSymbol);
    reversePathSymbols.push(reverseRouteSteps[reverseRouteSteps.length - 1]?.edge.tokenOutSymbol || candidate.flashloanAsset.symbol);
    return {
      available: true,
      reverseFlashloanSource: candidate.flashloanLiquidity.sourceCode,
      reverseFlashloanAsset: candidate.flashloanAsset.address,
      reverseFlashloanAmount: reverseFlashloanAmount.toString(),
      reverseContext,
      reversePath: reversePathSymbols.join("->"),
      reverseVenues: reverseRouteSteps.map((step) => `${step.edge.venueName}:${step.edge.invariant}`).join("->"),
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

function rejectionBucket(reason: string) {
  if (!reason || reason === "NONE") return "EXECUTABLE";
  return reason.split(":")[0] || reason;
}

function candidateGateSummary(candidates: Candidate[], stats: DiscoveryStats) {
  const reasonCounts = candidates.reduce((acc: Record<string, number>, candidate) => {
    const key = candidate.status === "EXECUTABLE_PROFIT_CANDIDATE" ? "EXECUTABLE" : rejectionBucket(candidate.rejectionReason);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const tokenCounts = candidates.reduce((acc: Record<string, number>, candidate) => {
    acc[candidate.flashloanAsset.symbol] = (acc[candidate.flashloanAsset.symbol] || 0) + 1;
    return acc;
  }, {});
  const venueCounts = candidates.reduce((acc: Record<string, number>, candidate) => {
    for (const step of candidate.steps) {
      acc[step.edge.venueName] = (acc[step.edge.venueName] || 0) + 1;
    }
    return acc;
  }, {});
  const topEntries = (values: Record<string, number>) => Object.entries(values)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
  return {
    total: candidates.length,
    executable: candidates.filter((candidate) => candidate.status === "EXECUTABLE_PROFIT_CANDIDATE").length,
    c1Eligible: candidates.filter((candidate) => candidate.c1ExecutionEligible).length,
    rejectedQuote: stats.routeCyclesRejectedQuote,
    rejectedTvl: stats.routeCyclesRejectedTvl,
    reasonCounts,
    topTokens: topEntries(tokenCounts),
    topVenues: topEntries(venueCounts),
  };
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
  console.log(`DISCOVERY_SUMMARY|flashloanAssets=${stats.flashloanAssets}|flashloanBalancerAssets=${stats.flashloanBalancerAssets}|flashloanAaveAssets=${stats.flashloanAaveAssets}|forcedDiscoveryTokens=${stats.forcedDiscoveryTokens}|tokens=${stats.tokens}|discoveredPools=${stats.discoveredPools}|directedEdges=${stats.discoveredEdges}|sourceCounts=${JSON.stringify(stats.sourceCounts)}|rejectedMetadata=${stats.rejectedMetadata}|rejectedZeroLiquidity=${stats.rejectedZeroLiquidity}|rejectedDuplicateEdge=${stats.rejectedDuplicateEdge}|rejectedUnsupportedInvariant=${stats.rejectedUnsupportedInvariant}|rejectedLowTvlEdge=${stats.rejectedLowTvlEdge}|rejectedPreSend=${stats.rejectedPreSend}|preSendRejectReasons=${JSON.stringify(stats.preSendRejectReasons)}|rejectedLogScanChunks=${stats.rejectedLogScan}|routeCycles=${stats.routeCyclesEnumerated}|routeRepeatedTokenRejects=${stats.routeCyclesRejectedRepeatedToken}|routeVenueDiversityRejects=${stats.routeCyclesRejectedVenueDiversity}|routeConsecutiveVenueRejects=${stats.routeCyclesRejectedConsecutiveVenue}|routeTvlRejects=${stats.routeCyclesRejectedTvl}|routeQuoteRejects=${stats.routeCyclesRejectedQuote}|routeQuoteRejectReasons=${JSON.stringify(stats.routeQuoteRejectReasons)}|truncated=${stats.truncated}|gasCostUsd=${gasCostUsd.toFixed(6)}|minProfitUsd=${minProfitUsd}|minRoutePoolTvlUsd=${stats.minRoutePoolTvlUsd}|pnlUpdated=false`);
  console.log(`FLASHLOAN_LIQUIDITY|${flashloanBook.ordered.map((item) => `${item.provider}:${item.asset.symbol}:${item.asset.address}:liquidity=${ethers.formatUnits(item.liquidity, item.asset.decimals)}:feeBps=${item.feeBps}`).join(",")}`);
  console.log(`FLASHLOAN_ASSETS|${flashloanAssets.map((asset) => `${asset.symbol}:${asset.address}`).join(",")}`);
  console.log(`DISCOVERY_FORCE_TOKENS|${Array.from(tokenCache.values()).filter((token) => DEFAULT_DISCOVERY_FORCE_TOKENS[token.symbol.toUpperCase()]?.toLowerCase() === token.address.toLowerCase()).map((token) => `${token.symbol}:${token.address}`).join(",")}`);
  console.log(`PRICE_MAP|${JSON.stringify(Object.fromEntries(Array.from(tokenCache.values()).filter((token) => token.priceUsd).map((token) => [token.symbol, Number(token.priceUsd?.toFixed(8))])))}`);

  const topRouteDisplayLimit = intEnv("TOP_ROUTE_DISPLAY_LIMIT", DEFAULT_TOP_ROUTE_DISPLAY_LIMIT);
  console.log(`ROUTE_LIMITS|totalRoutes=${candidates.length}|topRouteDisplayLimit=${topRouteDisplayLimit}|c1ExecutableLimitPerCycle=${intEnv("C1_EXECUTABLE_LIMIT_PER_CYCLE", DEFAULT_C1_EXECUTABLE_LIMIT)}|c2DecisionLimitPerCycle=${Number(process.env.C2_DECISION_LIMIT_PER_CYCLE || 50)}`);
  console.log(`ROUTE_UNIVERSE_PROOF|doctrineOnly=${boolEnv("LIVE_ROUTE_ONLY_DOCTRINE_CYCLES", true)}|prioritizeDoctrine=${boolEnv("LIVE_ROUTE_PRIORITIZE_CROSS_VENUE_DOCTRINE", true)}|maxHops=${Math.max(2, Math.min(6, intEnv("MAX_ROUTE_HOPS", 4)))}|maxCycles=${intEnv("LIVE_ROUTE_MAX_CYCLES", DEFAULT_ROUTE_MAX_CYCLES)}|maxCyclesPerAsset=${optionalIntEnv("LIVE_ROUTE_MAX_CYCLES_PER_ASSET") ?? "AUTO"}|discoveredEdges=${stats.discoveredEdges}|routeCycles=${stats.routeCyclesEnumerated}|truncated=${stats.truncated}|sameVenueRejects=${stats.routeCyclesRejectedConsecutiveVenue}|venueDiversityRejects=${stats.routeCyclesRejectedVenueDiversity}|repeatedTokenRejects=${stats.routeCyclesRejectedRepeatedToken}|repeatedPoolRejects=${stats.routeCyclesRejectedRepeatedPool}|pnlUpdated=false`);
  const gateSummary = candidateGateSummary(candidates, stats);
  console.log(`ROUTE_GATE_SUMMARY|total=${gateSummary.total}|executable=${gateSummary.executable}|c1Eligible=${gateSummary.c1Eligible}|rejectedQuote=${gateSummary.rejectedQuote}|rejectedTvl=${gateSummary.rejectedTvl}|reasons=${JSON.stringify(gateSummary.reasonCounts)}|topTokens=${gateSummary.topTokens}|topVenues=${gateSummary.topVenues}|pnlUpdated=false`);

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
      `routeShape=${candidate.steps.length === 2 ? "A_B_A" : candidate.steps.length === 3 ? "A_B_C_A" : `A_${candidate.steps.length}_HOP_A`}`,
      `flashloanAmountEqualsLeg1=${candidate.steps[0]?.amountIn === candidate.amountIn}`,
      `amountIn=${ethers.formatUnits(candidate.amountIn, candidate.flashloanAsset.decimals)}`,
      `amountOut=${ethers.formatUnits(candidate.amountOut, candidate.flashloanAsset.decimals)}`,
      `repayment=${ethers.formatUnits(candidate.repaymentRaw, candidate.flashloanAsset.decimals)}`,
      `requiredOut=${candidate.requiredOutputRaw === undefined ? "UNPRICED" : ethers.formatUnits(candidate.requiredOutputRaw, candidate.flashloanAsset.decimals)}`,
      `requiredOutputUsd=${candidate.requiredOutputUsd?.toFixed(6) ?? "UNPRICED"}`,
      `executableSurplus=${candidate.executableSurplusRaw === undefined ? "UNPRICED" : ethers.formatUnits(candidate.executableSurplusRaw, candidate.flashloanAsset.decimals)}`,
      `executableSurplusUsd=${candidate.executableSurplusUsd?.toFixed(6) ?? "UNPRICED"}`,
      `economicMinTradeUsd=${candidate.economicMinTradeUsd?.toFixed(6) ?? "UNPRICED"}`,
      `maxScannableTradeUsd=${candidate.maxScannableTradeUsd?.toFixed(6) ?? "UNPRICED"}`,
      `profitabilityTargetEdgeBps=${candidate.profitabilityTargetEdgeBps?.toFixed(2) ?? "UNPRICED"}`,
      `economicSizeOk=${candidate.economicSizeOk ?? "UNPRICED"}`,
      `grossProfitUsd=${candidate.grossProfitUsd?.toFixed(6) ?? "UNPRICED"}`,
      `flashFeeUsd=${candidate.flashFeeUsd?.toFixed(6) ?? "UNPRICED"}`,
      `gasCostUsd=${candidate.gasCostUsd?.toFixed(6) ?? "UNPRICED"}`,
      `riskBufferUsd=${candidate.riskBufferUsd?.toFixed(6) ?? "UNPRICED"}`,
      `minProfitUsd=${candidate.minProfitUsd?.toFixed(6) ?? "UNPRICED"}`,
      `requiredPremiumUsd=${candidate.requiredPremiumUsd?.toFixed(6) ?? "UNPRICED"}`,
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
  await flushLaneEventBatch("cycle_end");
  console.log("LIVE_CYCLE_END|status=COMPLETE|broadcasted=false_unless_hash_printed_above");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/live-cycle.ts")) {
  main().then(() => {
    process.exit(0);
  }).catch((error) => {
    console.error(`LIVE_CYCLE_FAILED|error=${error?.message || error}|broadcasted=false|pnlUpdated=false`);
    process.exit(1);
  });
}
