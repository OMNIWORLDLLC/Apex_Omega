import MevRouteDiscoveryEngine, { type ArbitrageRoute } from "./MevRouteDiscovery.js";

export interface ExecutionCycle {
  cycleId: number;
  status: "SUCCESS" | "NO_ROUTE" | "ERROR";
  duration_ms: number;
  discoveredRoutes: ArbitrageRoute[];
  selectedRoute?: ArbitrageRoute;
  txHash?: string;
  error?: string;
}

export interface CycleResults {
  cycles: ExecutionCycle[];
  summary: {
    totalCycles: number;
    successfulCycles: number;
    totalGrossProfit: number;
    totalNetProfitUSD: number;
    averageProfit: number;
    totalDuration_ms: number;
    targetContract: string;
    flashloanAsset: string;
    executorConfigured: boolean;
  };
}

export function formatCycleResults(results: CycleResults): string {
  const lines = [
    "=".repeat(80),
    "APEX OMEGA 5-CYCLE SUMMARY",
    "=".repeat(80),
    `Cycles Run: ${results.summary.totalCycles}`,
    `Successful Cycles: ${results.summary.successfulCycles}`,
    `Total Net Profit: $${results.summary.totalNetProfitUSD.toFixed(2)}`,
    `Average Profit/Cycle: $${results.summary.averageProfit.toFixed(2)}`,
    `Total Duration: ${results.summary.totalDuration_ms}ms`,
  ];

  for (const cycle of results.cycles) {
    lines.push(
      `Cycle ${cycle.cycleId}: ${cycle.status} (${cycle.duration_ms}ms)`,
      `  Routes Discovered: ${cycle.discoveredRoutes.length}`,
      `  Best Net Profit: $${(cycle.selectedRoute?.netProfitUSD || 0).toFixed(2)}`
    );
    if (cycle.error) {
      lines.push(`  Error: ${cycle.error}`);
    }
  }

  return lines.join("\n");
}

export default class ApexOmegaBootstrap {
  private readonly discoveryEngine: MevRouteDiscoveryEngine;

  constructor(
    private readonly rpcUrl: string,
    private readonly targetContract: string,
    private readonly flashloanAsset: string,
    private readonly executorPrivateKey?: string,
    private readonly maticPriceUsd: number = 0.72
  ) {
    this.discoveryEngine = new MevRouteDiscoveryEngine(rpcUrl, maticPriceUsd);
  }

  async runMultipleCycles(
    totalCycles: number,
    searchDepth: number,
    minProfitUSD: number
  ): Promise<CycleResults> {
    const cycles: ExecutionCycle[] = [];
    let successfulCycles = 0;
    let totalGrossProfit = 0;
    let totalNetProfitUSD = 0;
    let totalDuration_ms = 0;

    for (let cycleId = 1; cycleId <= totalCycles; cycleId++) {
      const startedAt = Date.now();

      try {
        const discoveredRoutes = await this.discoveryEngine.discoverArbitrageRoutes(
          searchDepth,
          minProfitUSD
        );
        const selectedRoute = discoveredRoutes[0];
        const duration_ms = Date.now() - startedAt;
        const status = selectedRoute ? "SUCCESS" : "NO_ROUTE";

        cycles.push({
          cycleId,
          status,
          duration_ms,
          discoveredRoutes,
          selectedRoute,
        });

        totalDuration_ms += duration_ms;

        if (selectedRoute) {
          successfulCycles += 1;
          totalGrossProfit += selectedRoute.grossProfit;
          totalNetProfitUSD += selectedRoute.netProfitUSD;
        }
      } catch (error) {
        const duration_ms = Date.now() - startedAt;
        totalDuration_ms += duration_ms;

        cycles.push({
          cycleId,
          status: "ERROR",
          duration_ms,
          discoveredRoutes: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      cycles,
      summary: {
        totalCycles,
        successfulCycles,
        totalGrossProfit,
        totalNetProfitUSD,
        averageProfit: totalCycles > 0 ? totalNetProfitUSD / totalCycles : 0,
        totalDuration_ms,
        targetContract: this.targetContract,
        flashloanAsset: this.flashloanAsset,
        executorConfigured: Boolean(this.executorPrivateKey),
      },
    };
  }
}
