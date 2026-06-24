/**
 * APEX_OMEGA Math Core
 * Precision AMM formulas for DEX Arbitrage
 */

export interface Pool {
  id: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  fee: number; // e.g. 0.003 for 0.3%
}

/**
 * Uniswap V2 Get Amount Out
 * Formula: (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
 */
export function getAmountOutV2(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 30 // 0.3%
): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

/**
 * Uniswap V2 Get Amount In
 * Formula: (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1
 */
export function getAmountInV2(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 30
): bigint {
  if (amountOut <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (amountOut >= reserveOut) throw new Error("INSUFFICIENT_LIQUIDITY");

  const numerator = reserveIn * amountOut * 10000n;
  const denominator = (reserveOut - amountOut) * BigInt(10000 - feeBps);
  return (numerator / denominator) + 1n;
}

export interface SpreadResult {
  /** Gross profit: sellOut - amountIn (before fees and gas) */
  profit: bigint;
  /** Net profit: sellOut - amountIn - flashloanFee - gasCost - bribe (strictly positive) */
  netProfit: bigint;
  /** [leg1Dex, leg2Dex] */
  path: string[];
  /** Which token direction was selected: "AB" = token0→token1→token0, "BA" = token1→token0→token1 */
  direction: "AB" | "BA";
  /**
   * Effective Ask price for Leg 1 (Acquisition), scaled by 1e18.
   * buyPrice = amountIn * 1e18 / buyOut  (source-token cost per intermediate-token unit)
   */
  buyPrice: bigint;
  /**
   * Effective Bid price for Leg 2 (Distribution), scaled by 1e18.
   * sellPrice = sellOut * 1e18 / buyOut  (source-token revenue per intermediate-token unit)
   * PRICE INVARIANT requires: buyPrice < sellPrice
   */
  sellPrice: bigint;
}

/**
 * Calculate spread between two pools, enforcing all execution invariants.
 *
 * VENUE AGNOSTIC  : poolA and poolB can be any supported DEX.
 * DIRECTION AGNOSTIC: both token0→token1→token0 (AB) and
 *                     token1→token0→token1 (BA) are evaluated; the best
 *                     direction that satisfies all invariants is returned.
 * PRICE INVARIANT : buyPrice < sellPrice (Ask Leg1 < Bid Leg2) is enforced.
 *                   Violated routes are discarded.
 * YIELD INVARIANT : sellOut > amountIn + flashloanFee + gasCostTokenUnits + bribeTokenUnits.
 *                   Routes that do not produce strictly positive net profit after
 *                   all costs are discarded and null is returned.
 *
 * @param poolA              - first liquidity pool
 * @param poolB              - second liquidity pool
 * @param amountIn           - input amount (in token0 for AB, token1 for BA)
 * @param flashloanFeeBps    - flashloan fee in basis points (default 5 = Aave V3 0.05%)
 * @param gasCostTokenUnits  - estimated gas cost expressed in the same token units as amountIn
 * @param bribeTokenUnits    - MEV bribe expressed in the same token units as amountIn
 * @returns SpreadResult when a profitable, invariant-compliant route exists, else null
 */
export function calculateSpread(
  poolA: Pool,
  poolB: Pool,
  amountIn: bigint,
  flashloanFeeBps: number = 5,
  gasCostTokenUnits: bigint = 0n,
  bribeTokenUnits: bigint = 0n,
): SpreadResult | null {
  if (amountIn <= 0n) return null;

  const SCALE = 1_000_000_000_000_000_000n; // 1e18 fixed-point scale
  const feeBpsA = Math.floor(poolA.fee * 10000);
  const feeBpsB = Math.floor(poolB.fee * 10000);

  const tryDirection = (
    p1ReserveIn: bigint,
    p1ReserveOut: bigint,
    p1FeeBps: number,
    p2ReserveIn: bigint,
    p2ReserveOut: bigint,
    p2FeeBps: number,
    direction: "AB" | "BA",
  ): SpreadResult | null => {
    const buyOut = getAmountOutV2(amountIn, p1ReserveIn, p1ReserveOut, p1FeeBps);
    if (buyOut <= 0n) return null;
    const sellOut = getAmountOutV2(buyOut, p2ReserveIn, p2ReserveOut, p2FeeBps);
    if (sellOut <= 0n) return null;

    // PRICE INVARIANT: effective Ask (Leg 1) must be strictly below effective Bid (Leg 2).
    // buyPrice  = amountIn  * 1e18 / buyOut  (cost per intermediate token unit)
    // sellPrice = sellOut   * 1e18 / buyOut  (revenue per intermediate token unit)
    // Required: buyPrice < sellPrice  ⟺  amountIn < sellOut
    const buyPrice = (amountIn * SCALE) / buyOut;
    const sellPrice = (sellOut * SCALE) / buyOut;
    if (buyPrice >= sellPrice) return null; // PRICE INVARIANT violated — discard

    // YIELD INVARIANT: Total Output > Total Input + (Flashloan Fees + Gas + Bribes)
    const flashloanFee = (amountIn * BigInt(flashloanFeeBps)) / 10000n;
    const totalCost = amountIn + flashloanFee + gasCostTokenUnits + bribeTokenUnits;
    if (sellOut <= totalCost) return null; // YIELD INVARIANT violated — discard

    return {
      profit: sellOut - amountIn,
      netProfit: sellOut - totalCost,
      path: [poolA.dex, poolB.dex],
      direction,
      buyPrice,
      sellPrice,
    };
  };

  // Direction AB: token0 → token1 on poolA (buy), token1 → token0 on poolB (sell)
  const dirAB = tryDirection(
    poolA.reserve0, poolA.reserve1, feeBpsA,
    poolB.reserve1, poolB.reserve0, feeBpsB,
    "AB",
  );

  // Direction BA: token1 → token0 on poolA (buy), token0 → token1 on poolB (sell)
  const dirBA = tryDirection(
    poolA.reserve1, poolA.reserve0, feeBpsA,
    poolB.reserve0, poolB.reserve1, feeBpsB,
    "BA",
  );

  // Return the direction with the highest net profit; discard if neither is valid.
  if (!dirAB && !dirBA) return null;
  if (!dirAB) return dirBA;
  if (!dirBA) return dirAB;
  return dirAB.netProfit >= dirBA.netProfit ? dirAB : dirBA;
}

/**
 * Aave V3 Liquidation Math
 * Health Factor = (Sum of Collateral in ETH * Liquidation Threshold) / Total Debt in ETH
 */
export function calculateHealthFactor(
  collateralInEth: number,
  debtInEth: number,
  liquidationThreshold: number // e.g. 0.8
): number {
  if (debtInEth === 0) return Infinity;
  return (collateralInEth * liquidationThreshold) / debtInEth;
}
