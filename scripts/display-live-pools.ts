import "dotenv/config";
import fs from "fs";
import { ethers } from "ethers";
import {
  ALGEBRA_FACTORY_ABI,
  ALGEBRA_POOL_ABI,
  ERC20_METADATA_ABI,
  UNISWAP_V2_FACTORY_ABI,
  UNISWAP_V2_PAIR_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
} from "../server/engine/routeAdapters.js";

const FACTORIES = [
  {
    family: "V2_CPMM",
    venue: "QuickSwapV2",
    address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    abi: UNISWAP_V2_FACTORY_ABI,
    event: "PairCreated",
  },
  {
    family: "V2_CPMM",
    venue: "SushiSwapV2",
    address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    abi: UNISWAP_V2_FACTORY_ABI,
    event: "PairCreated",
  },
  {
    family: "V3_CONCENTRATED_LIQUIDITY",
    venue: "UniswapV3",
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    abi: UNISWAP_V3_FACTORY_ABI,
    event: "PoolCreated",
  },
  {
    family: "ALGEBRA_CONCENTRATED_LIQUIDITY",
    venue: "QuickSwapAlgebra",
    address: process.env.ALGEBRA_FACTORY || "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
    abi: ALGEBRA_FACTORY_ABI,
    event: "Pool",
  },
] as const;

type ProductionPool = {
  venue: string;
  invariant: string;
  factory: string;
  pool: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  fee?: string;
  blockNumber: number;
  txHash: string;
  codeValidated: boolean;
  stateValidated: boolean;
  stateSummary: string;
};

type CachedDiscoveryLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash?: string;
};

type DiscoveryCacheEntry = {
  fromBlock: number;
  toBlock: number;
  logs: CachedDiscoveryLog[];
};

type DiscoveryCache = Record<string, DiscoveryCacheEntry>;

function rpcUrl() {
  return process.env.POLYGON_RPC_URL || process.env.POLYGON_RPC || process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com";
}

function cachePath() {
  return process.env.LIVE_DISCOVERY_CACHE_PATH || ".cache/live-discovery-cache.json";
}

function readDiscoveryCache(): DiscoveryCache {
  try {
    if (!fs.existsSync(cachePath())) return {};
    return JSON.parse(fs.readFileSync(cachePath(), "utf-8")) as DiscoveryCache;
  } catch {
    return {};
  }
}

function cachedFactoryLogs(factoryAddress: string, topic: string) {
  const lowerFactory = factoryAddress.toLowerCase();
  return Object.entries(readDiscoveryCache())
    .filter(([key]) => key.toLowerCase().includes(lowerFactory) && key.toLowerCase().includes(topic.toLowerCase()))
    .flatMap(([, entry]) => entry.logs || []);
}

async function liveFactoryLogs(provider: ethers.JsonRpcProvider, address: string, topic: string) {
  const lookback = Number.parseInt(process.env.LIVE_POOL_DISPLAY_LOOKBACK_BLOCKS || "2500", 10);
  const latest = await provider.getBlockNumber();
  return await provider.getLogs({
    address,
    topics: [topic],
    fromBlock: Math.max(0, latest - (Number.isFinite(lookback) ? lookback : 2500)),
    toBlock: latest,
  });
}

async function symbol(provider: ethers.JsonRpcProvider, token: string) {
  try {
    const contract = new ethers.Contract(token, ERC20_METADATA_ABI, provider);
    return String(await contract.symbol());
  } catch {
    return "UNKNOWN";
  }
}

async function decodePoolLog(
  provider: ethers.JsonRpcProvider,
  factory: (typeof FACTORIES)[number],
  log: ethers.Log | CachedDiscoveryLog,
): Promise<ProductionPool | undefined> {
  try {
    const iface = new ethers.Interface(factory.abi);
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return undefined;

    const token0 = ethers.getAddress(parsed.args.token0);
    const token1 = ethers.getAddress(parsed.args.token1);
    const pool = ethers.getAddress(parsed.args.pair || parsed.args.pool);
    const codeValidated = await provider.getCode(pool).then((code) => code !== "0x").catch(() => false);
    if (!codeValidated) return undefined;

    let fee: string | undefined;
    let stateValidated = false;
    let stateSummary = "UNREAD";
    if (factory.family === "V3_CONCENTRATED_LIQUIDITY") {
      fee = parsed.args.fee?.toString();
      if (!fee) {
        fee = await new ethers.Contract(pool, UNISWAP_V3_POOL_ABI, provider).fee().then((value: bigint) => value.toString()).catch(() => undefined);
      }
      const liquidity = await new ethers.Contract(pool, UNISWAP_V3_POOL_ABI, provider).liquidity().catch(() => 0n);
      stateValidated = liquidity > 0n;
      stateSummary = `liquidity=${liquidity.toString()}`;
    }
    if (factory.family === "V2_CPMM") {
      const pair = new ethers.Contract(pool, UNISWAP_V2_PAIR_ABI, provider);
      const [readToken0, readToken1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
      if (ethers.getAddress(readToken0).toLowerCase() !== token0.toLowerCase()) return undefined;
      if (ethers.getAddress(readToken1).toLowerCase() !== token1.toLowerCase()) return undefined;
      stateValidated = reserves.reserve0 > 0n && reserves.reserve1 > 0n;
      stateSummary = `reserve0=${reserves.reserve0.toString()},reserve1=${reserves.reserve1.toString()}`;
    }
    if (factory.family === "ALGEBRA_CONCENTRATED_LIQUIDITY") {
      const liquidity = await new ethers.Contract(pool, ALGEBRA_POOL_ABI, provider).liquidity().catch(() => 0n);
      stateValidated = liquidity > 0n;
      stateSummary = `liquidity=${liquidity.toString()}`;
    }
    if (!stateValidated) return undefined;

    const [symbol0, symbol1] = await Promise.all([symbol(provider, token0), symbol(provider, token1)]);
    return {
      venue: factory.venue,
      invariant: factory.family,
      factory: ethers.getAddress(factory.address),
      pool,
      token0,
      token1,
      symbol0,
      symbol1,
      fee,
      blockNumber: Number(log.blockNumber || 0),
      txHash: String(log.transactionHash || "UNKNOWN"),
      codeValidated,
      stateValidated,
      stateSummary,
    };
  } catch {
    return undefined;
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl(), 137, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== 137n) throw new Error(`CHAIN_ID_MISMATCH:${network.chainId}`);

  const maxRows = Number.parseInt(process.env.LIVE_POOL_DISPLAY_LIMIT || "30", 10);
  const useCache = process.env.LIVE_POOL_DISPLAY_USE_CACHE !== "false";
  const pools: ProductionPool[] = [];
  const sourceCounts: Record<string, number> = {};

  for (const factory of FACTORIES) {
    const iface = new ethers.Interface(factory.abi);
    const event = iface.getEvent(factory.event);
    if (!event?.topicHash) continue;

    const logs = useCache
      ? cachedFactoryLogs(factory.address, event.topicHash)
      : await liveFactoryLogs(provider, factory.address, event.topicHash);
    sourceCounts[factory.venue] = logs.length;

    for (const log of logs.slice(-Math.max(1, maxRows))) {
      const pool = await decodePoolLog(provider, factory, log);
      if (pool) pools.push(pool);
      if (pools.length >= maxRows) break;
    }
    if (pools.length >= maxRows) break;
  }

  if (pools.length === 0) {
    throw new Error("NO_REAL_PRODUCTION_POOLS_DISCOVERED_OR_CODE_VALIDATED");
  }

  const latestBlock = await provider.getBlockNumber();
  console.log([
    "LIVE_POOL_DISPLAY",
    `chainId=${network.chainId}`,
    `block=${latestBlock}`,
    "mockDataAllowed=false",
    `source=${useCache ? "discovery_cache_plus_code_validation" : "live_factory_logs_plus_code_validation"}`,
    `pools=${pools.length}`,
    `sourceCounts=${JSON.stringify(sourceCounts)}`,
  ].join("|"));

  for (const [index, pool] of pools.entries()) {
    console.log([
      "LIVE_POOL",
      `rank=${index + 1}`,
      `venue=${pool.venue}`,
      `invariant=${pool.invariant}`,
      `factory=${pool.factory}`,
      `pool=${pool.pool}`,
      `pair=${pool.symbol0}/${pool.symbol1}`,
      `token0=${pool.token0}`,
      `token1=${pool.token1}`,
      `fee=${pool.fee || "N/A"}`,
      `createdBlock=${pool.blockNumber}`,
      `createdTx=${pool.txHash}`,
      `codeValidated=${pool.codeValidated}`,
      `stateValidated=${pool.stateValidated}`,
      `state=${pool.stateSummary}`,
    ].join("|"));
  }
}

main().catch((error) => {
  console.error(`LIVE_POOL_DISPLAY_FAILED|mockDataAllowed=false|error=${error?.message || error}`);
  process.exit(1);
});
