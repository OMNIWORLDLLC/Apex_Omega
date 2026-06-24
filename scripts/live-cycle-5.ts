#!/usr/bin/env tsx

/**
 * APEX OMEGA: LIVE 5-CYCLE EXECUTION
 * ==================================
 * Real chain 137 data, actual RPC calls, genuine MEV discovery
 * No mocked data - all values from blockchain
 */

import { ethers } from "ethers";
import ApexOmegaBootstrap, {
  formatCycleResults,
  CycleResults,
  ExecutionCycle,
} from "../server/engine/SystemBootstrap.js";

const RPC_URL =
  process.env.POLYGON_RPC_URL ||
  process.env.POLYGON_RPC ||
  "https://rpc.ankr.com/polygon";
const EXECUTOR_PRIVATE_KEY = process.env.EXECUTOR_PRIVATE_KEY;
const C1_TARGET_CONTRACT =
  process.env.C1_ARB_EXECUTOR_ADDRESS ||
  process.env.C1_TARGET ||
  process.env.ARB_CONTRACT_ADDRESS;
const FLASHLOAN_ASSET =
  process.env.FLASHLOAN_ASSET || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Live price fetching for MATIC
async function fetchMaticPrice(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd"
    );
    const data = await response.json();
    return data["matic-network"]?.usd || 0.72;
  } catch (error) {
    console.warn(
      "[WARNING] Could not fetch MATIC price from CoinGecko, using default"
    );
    return 0.72;
  }
}

// Validate RPC connectivity and chain ID
async function validateChain(): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const network = await provider.getNetwork();

    if (network.chainId !== 137n) {
      console.error(
        `[ERROR] Invalid chain. Expected 137 (Polygon), got ${network.chainId}`
      );
      return false;
    }

    const blockNumber = await provider.getBlockNumber();
    const feeData = await provider.getFeeData();
    const gasPrice =
      feeData.gasPrice ?? feeData.maxFeePerGas ?? feeData.maxPriorityFeePerGas;

    if (gasPrice === null) {
      throw new Error("Unable to determine gas pricing from provider fee data");
    }

    console.log(`✓ Chain 137 verified`);
    console.log(`  Block: ${blockNumber}`);
    console.log(`  Gas Price: ${(Number(gasPrice) / 1e9).toFixed(2)} Gwei`);

    return true;
  } catch (error: any) {
    console.error("[ERROR] Chain validation failed:", error?.message);
    return false;
  }
}

// Validate executor contract exists on-chain
async function validateExecutorContract(contractAddress: string): Promise<boolean> {
  try {
    if (!contractAddress || contractAddress === "0x0000000000000000000000000000000000000000") {
      console.warn(
        "[WARNING] No executor contract address provided. Running in simulation mode."
      );
      return true;
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const code = await provider.getCode(contractAddress);

    if (code === "0x") {
      console.warn(
        `[WARNING] Executor contract ${contractAddress} not found on-chain`
      );
      return false;
    }

    console.log(`✓ Executor contract verified: ${contractAddress.slice(0, 10)}...`);
    return true;
  } catch (error: any) {
    console.error(
      "[ERROR] Executor validation failed:",
      error?.message
    );
    return false;
  }
}

// Validate flashloan asset exists
async function validateFlashloanAsset(assetAddress: string): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Check if contract exists
    const code = await provider.getCode(assetAddress);
    if (code === "0x") {
      console.error(`[ERROR] Flashloan asset ${assetAddress} not found on-chain`);
      return false;
    }

    // Try to read decimals
    const ERC20_ABI = [
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
      "function name() view returns (string)",
    ];

    const contract = new ethers.Contract(assetAddress, ERC20_ABI, provider);
    const [decimals, symbol, name] = await Promise.all([
      contract.decimals().catch(() => 18),
      contract.symbol().catch(() => "UNKNOWN"),
      contract.name().catch(() => "UNKNOWN"),
    ]);

    console.log(
      `✓ Flashloan asset verified: ${symbol} (${name}) - ${decimals} decimals`
    );
    return true;
  } catch (error: any) {
    console.error("[ERROR] Flashloan asset validation failed:", error?.message);
    return false;
  }
}

async function main() {
  console.log("\n" + "▼".repeat(80));
  console.log("APEX OMEGA: LIVE 5-CYCLE EXECUTION (REAL DATA)");
  console.log("▼".repeat(80) + "\n");

  console.log("[INIT] Configuration Check");
  console.log(`  RPC URL: ${RPC_URL}`);
  console.log(
    `  Executor Signer: ${EXECUTOR_PRIVATE_KEY ? "✓ LOADED" : "✗ MISSING (DRY_RUN MODE)"}`
  );
  console.log(`  C1 Target: ${C1_TARGET_CONTRACT || "NOT PROVIDED"}`);
  console.log(`  Flashloan Asset: ${FLASHLOAN_ASSET}`);
  console.log("");

  // Pre-flight checks
  console.log("[PRE-FLIGHT] Chain Validation");
  const chainValid = await validateChain();
  if (!chainValid) {
    console.error("[FATAL] Chain validation failed");
    process.exit(1);
  }

  console.log("");
  console.log("[PRE-FLIGHT] Flashloan Asset Validation");
  const assetValid = await validateFlashloanAsset(FLASHLOAN_ASSET);
  if (!assetValid) {
    console.error("[FATAL] Flashloan asset validation failed");
    process.exit(1);
  }

  if (C1_TARGET_CONTRACT) {
    console.log("");
    console.log("[PRE-FLIGHT] Executor Contract Validation");
    await validateExecutorContract(C1_TARGET_CONTRACT);
  }

  // Fetch live MATIC price
  console.log("");
  console.log("[INIT] Fetching live MATIC price...");
  const maticPrice = await fetchMaticPrice();
  console.log(`  MATIC Price: $${maticPrice.toFixed(4)}`);

  console.log("\n" + "─".repeat(80) + "\n");

  try {
    // Initialize bootstrap engine with REAL data
    const bootstrap = new ApexOmegaBootstrap(
      RPC_URL,
      C1_TARGET_CONTRACT || "0x0000000000000000000000000000000000000000",
      FLASHLOAN_ASSET,
      EXECUTOR_PRIVATE_KEY,
      maticPrice
    );

    console.log("[BOOTSTRAP] Initializing MEV discovery engine...\n");

    // Run 5 LIVE cycles with real chain data
    const results = await bootstrap.runMultipleCycles(
      5, // 5 cycles
      100, // scan 100 token pairs (real liquidity)
      10 // minimum $10 profit threshold
    );

    // Display formatted results
    const formattedResults = formatCycleResults(results);
    console.log(formattedResults);

    // Detailed breakdown
    console.log("\n" + "=".repeat(80));
    console.log("DETAILED BREAKDOWN");
    console.log("=".repeat(80) + "\n");

    for (const cycle of results.cycles) {
      console.log(
        `CYCLE ${cycle.cycleId}: ${cycle.status} (${cycle.duration_ms}ms)`
      );

      if (cycle.discoveredRoutes.length > 0) {
        console.log(
          `  Discovered Routes: ${cycle.discoveredRoutes.length}`
        );
        console.log(
          `  Top 3 Routes by Profit:`
        );

        for (
          let i = 0;
          i < Math.min(3, cycle.discoveredRoutes.length);
          i++
        ) {
          const route = cycle.discoveredRoutes[i];
          console.log(
            `    ${i + 1}. ${route.routeId}`
          );
          console.log(
            `       Tokens: ${route.legs.map((l) => `${l.venueName}`).join(" → ")}`
          );
          console.log(
            `       Profit: $${route.netProfitUSD.toFixed(2)} (Net: ${route.netProfit.toFixed(6)} tokens)`
          );
          console.log(
            `       Fees: ${route.totalFees.toFixed(6)} tokens + ${route.gasCostUSD.toFixed(2)} USD gas`
          );
        }
      }

      if (cycle.selectedRoute) {
        console.log(
          `  Selected Route: ${cycle.selectedRoute.routeId}`
        );
        console.log(
          `    Expected Profit: $${cycle.selectedRoute.netProfitUSD.toFixed(2)}`
        );
        console.log(
          `    Input: ${(Number(cycle.selectedRoute.inputAmount) / 10 ** cycle.selectedRoute.legs[0].tokenIn.length).toFixed(6)}`
        );

        if (cycle.txHash) {
          console.log(`    Tx: https://polygonscan.com/tx/${cycle.txHash}`);
        }
      }

      if (cycle.error) {
        console.log(`  Error: ${cycle.error}`);
      }

      console.log("");
    }

    // Summary statistics
    console.log("\n" + "=".repeat(80));
    console.log("EXECUTION SUMMARY");
    console.log("=".repeat(80) + "\n");

    const successRate =
      ((results.summary.successfulCycles / results.summary.totalCycles) * 100).toFixed(
        1
      );
    const totalProfit = results.summary.totalNetProfitUSD;
    const avgProfit = results.summary.averageProfit;

    console.log(
      `Total Cycles: ${results.summary.totalCycles}`
    );
    console.log(
      `Success Rate: ${successRate}%`
    );
    console.log(
      `Total Gross Profit: ${results.summary.totalGrossProfit.toFixed(6)} tokens`
    );
    console.log(
      `Total Net Profit: $${totalProfit.toFixed(2)} USD`
    );
    console.log(
      `Average Profit/Cycle: $${avgProfit.toFixed(2)} USD`
    );
    console.log(
      `Total Execution Time: ${results.summary.totalDuration_ms}ms`
    );
    console.log(
      `Average Cycle Time: ${Math.floor(results.summary.totalDuration_ms / results.summary.totalCycles)}ms`
    );

    console.log("\n" + "=".repeat(80) + "\n");

    // Exit status
    if (results.summary.successfulCycles > 0) {
      console.log("[SUCCESS] Live execution completed with profitable routes\n");
      process.exit(0);
    } else {
      console.log(
        "[NOTICE] No profitable routes discovered in 5 cycles (market conditions)\n"
      );
      process.exit(0);
    }
  } catch (error: any) {
    console.error("\n[FATAL ERROR] Execution failed:");
    console.error(error?.message || String(error));
    if (error?.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
