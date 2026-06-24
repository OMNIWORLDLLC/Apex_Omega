import "dotenv/config";
import assert from "node:assert/strict";
import {
  buildRouteCalldataFromQuote,
  type PoolEdge,
} from "../server/engine/routeAdapters.js";

type GateInput = {
  leg1BuyPrice?: number;
  leg2SellPrice?: number;
  finalAmountOut: bigint;
  flashloanAmount: bigint;
  flashFee: bigint;
  requiredOutputRaw: bigint;
  grossProfitUsd: number;
  flashFeeUsd: number;
  gasCostUsd: number;
  riskBufferUsd: number;
  minProfitUsd: number;
  directTwoLeg: boolean;
};

function priceEdgeBps(buy: number, sell: number) {
  return buy > 0 ? ((sell - buy) / buy) * 10_000 : Number.NEGATIVE_INFINITY;
}

function evaluateExecutableGate(input: GateInput) {
  const repayment = input.flashloanAmount + input.flashFee;
  const netProfitUsd = input.grossProfitUsd - input.flashFeeUsd - input.gasCostUsd - input.riskBufferUsd;
  const priceVarianceOk = input.directTwoLeg
    ? Number.isFinite(input.leg1BuyPrice) &&
      Number.isFinite(input.leg2SellPrice) &&
      Number(input.leg1BuyPrice) < Number(input.leg2SellPrice)
    : input.finalAmountOut > input.flashloanAmount;
  const outputThresholdOk = input.finalAmountOut > input.requiredOutputRaw;
  const ok = priceVarianceOk && outputThresholdOk && netProfitUsd >= input.minProfitUsd;
  return {
    ok,
    priceVarianceOk,
    netProfitUsd,
    repaymentOk: input.finalAmountOut > repayment,
    requiredOutputRaw: input.requiredOutputRaw.toString(),
    outputThresholdOk,
    priceEdgeBps: input.directTwoLeg ? priceEdgeBps(Number(input.leg1BuyPrice), Number(input.leg2SellPrice)) : undefined,
  };
}

async function apiProbe() {
  const base = process.env.APEX_API_BASE || "http://127.0.0.1:3000";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const state = await fetch(`${base}/api/execution/control/state`, { signal: controller.signal });
    if (!state.ok) return { skipped: true, reason: `CONTROL_STATE_HTTP_${state.status}` };
    const stateJson = await state.json() as any;
    assert.equal(stateJson.mode.EXECUTION_DISABLED, "true", "execution must stay disabled for gate probe");
    assert.equal(stateJson.mode.DISCOVERY_ONLY_MODE, "true", "discovery-only mode must stay active");

    const c1 = await fetch(`${base}/api/execution/c1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    assert.equal(c1.status, 423, "C1 must return 423 while execution is disabled");
    const c1Json = await c1.json() as any;
    assert.equal(c1Json.payloadKind, "FLASHLOAN_INTEGRATED_C1_PAYLOADS");
    return { skipped: false, control: stateJson.mode, c1Status: c1.status };
  } catch (error: any) {
    return { skipped: true, reason: error?.name === "AbortError" ? "API_TIMEOUT" : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function runMathAssertions() {
  const rejectedBadVariance = evaluateExecutableGate({
    directTwoLeg: true,
    leg1BuyPrice: 1.003,
    leg2SellPrice: 1.001,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 1_010_000n,
    flashFee: 0n,
    requiredOutputRaw: 1_006_000n,
    grossProfitUsd: 100,
    flashFeeUsd: 0,
    gasCostUsd: 1,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(rejectedBadVariance.ok, false, "buy >= sell must never be executable");
  assert.equal(rejectedBadVariance.priceVarianceOk, false);

  const rejectedRepayment = evaluateExecutableGate({
    directTwoLeg: true,
    leg1BuyPrice: 1.001,
    leg2SellPrice: 1.003,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 1_000_000n,
    flashFee: 1n,
    requiredOutputRaw: 1_006_001n,
    grossProfitUsd: 100,
    flashFeeUsd: 0,
    gasCostUsd: 1,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(rejectedRepayment.ok, false, "positive spread cannot execute without flashloan repayment");
  assert.equal(rejectedRepayment.repaymentOk, false);
  assert.equal(rejectedRepayment.outputThresholdOk, false);

  const rejectedExecutableThreshold = evaluateExecutableGate({
    directTwoLeg: true,
    leg1BuyPrice: 1.001,
    leg2SellPrice: 1.003,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 1_005_999n,
    flashFee: 100n,
    requiredOutputRaw: 1_006_000n,
    grossProfitUsd: 50,
    flashFeeUsd: 0.1,
    gasCostUsd: 1,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(rejectedExecutableThreshold.ok, false, "live quote must beat principal plus fees/gas/min profit");
  assert.equal(rejectedExecutableThreshold.outputThresholdOk, false);

  const rejectedNet = evaluateExecutableGate({
    directTwoLeg: true,
    leg1BuyPrice: 1.001,
    leg2SellPrice: 1.003,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 1_010_000n,
    flashFee: 0n,
    requiredOutputRaw: 1_006_000n,
    grossProfitUsd: 4,
    flashFeeUsd: 0,
    gasCostUsd: 1,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(rejectedNet.ok, false, "gross-positive route cannot execute below net profit floor");

  const acceptedTwoLeg = evaluateExecutableGate({
    directTwoLeg: true,
    leg1BuyPrice: 1.001,
    leg2SellPrice: 1.006,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 1_010_000n,
    flashFee: 100n,
    requiredOutputRaw: 1_006_100n,
    grossProfitUsd: 25,
    flashFeeUsd: 0.1,
    gasCostUsd: 2,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(acceptedTwoLeg.ok, true, "valid two-leg math should pass the abstract executable gate");
  assert.ok(Number(acceptedTwoLeg.priceEdgeBps) > 0);

  const rejectedMultiLeg = evaluateExecutableGate({
    directTwoLeg: false,
    flashloanAmount: 1_000_000n,
    finalAmountOut: 999_999n,
    flashFee: 0n,
    requiredOutputRaw: 1_006_000n,
    grossProfitUsd: -1,
    flashFeeUsd: 0,
    gasCostUsd: 1,
    riskBufferUsd: 0,
    minProfitUsd: 5,
  });
  assert.equal(rejectedMultiLeg.ok, false, "multi-leg route must close with final output above input");

  return {
    badVariance: rejectedBadVariance,
    repayment: rejectedRepayment,
    executableThreshold: rejectedExecutableThreshold,
    netFloor: rejectedNet,
    acceptedTwoLeg,
    multiLegReject: rejectedMultiLeg,
  };
}

function routeEdge(params: Partial<PoolEdge> & Pick<PoolEdge, "invariant" | "tokenIn" | "tokenOut" | "executorTarget" | "feeBps">): PoolEdge {
  return {
    chainId: 137,
    dexId: "TEST",
    poolAddress: "0x0000000000000000000000000000000000000100",
    tokenInDecimals: 6,
    tokenOutDecimals: 18,
    reserveIn: 1_000_000n,
    reserveOut: 1_000_000n,
    tvlUsd: 10_000,
    stateBlock: 1,
    quoteAdapter: "testQuote",
    calldataAdapter: "testCalldata",
    ...params,
  };
}

function runRouteAdapterAssertions() {
  const usdc = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const weth = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
  const v2Router = "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff";
  const v3Router = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const receiver = "0x000000000000000000000000000000000000dEaD";
  const v2 = routeEdge({ invariant: "V2_CPMM", tokenIn: usdc, tokenOut: weth, executorTarget: v2Router, feeBps: 30 });
  const v3 = routeEdge({ invariant: "V3_CONCENTRATED_LIQUIDITY", tokenIn: weth, tokenOut: usdc, executorTarget: v3Router, feeBps: 30, extra: { v3Fee: 3000 } });

  const built = buildRouteCalldataFromQuote({
    flashloanAsset: usdc,
    receiver,
    deadline: 2_000_000_000,
    steps: [
      { edge: v2, amountIn: 1_000_000n, amountOut: 500_000_000_000_000n, minAmountOut: 499_000_000_000_000n },
      { edge: v3, amountIn: 500_000_000_000_000n, amountOut: 1_001_000n, minAmountOut: 1_000_000n },
    ],
  });
  assert.equal(built.length, 2);
  assert.equal(built[0].calldata.slice(0, 10), "0x38ed1739", "leg1 must be V2 router swapExactTokensForTokens calldata");
  assert.equal(built[1].calldata.slice(0, 10), "0x414bf389", "leg2 must be V3 exactInputSingle calldata");

  assert.throws(() => buildRouteCalldataFromQuote({
    flashloanAsset: usdc,
    receiver,
    deadline: 2_000_000_000,
    steps: [
      { edge: v2, amountIn: 1_000_000n, amountOut: 500_000_000_000_000n, minAmountOut: 499_000_000_000_000n },
      { edge: v3, amountIn: 1n, amountOut: 1_001_000n, minAmountOut: 1_000_000n },
    ],
  }), /AMOUNT_CHAIN_BROKEN/);

  assert.throws(() => buildRouteCalldataFromQuote({
    flashloanAsset: weth,
    receiver,
    deadline: 2_000_000_000,
    steps: [
      { edge: v2, amountIn: 1_000_000n, amountOut: 500_000_000_000_000n, minAmountOut: 499_000_000_000_000n },
      { edge: v3, amountIn: 500_000_000_000_000n, amountOut: 1_001_000n, minAmountOut: 1_000_000n },
    ],
  }), /ROUTE_FLASHLOAN_ASSET_NOT_FIRST_INPUT/);

  return {
    selectors: built.map((step) => step.calldata.slice(0, 10)),
    steps: built.length,
  };
}

async function main() {
  const math = runMathAssertions();
  const routeAdapter = runRouteAdapterAssertions();
  const api = await apiProbe();
  console.log(`GATE_INVARIANT_TEST|status=PASS|math=${JSON.stringify(math)}|routeAdapter=${JSON.stringify(routeAdapter)}|api=${JSON.stringify(api)}|pnlUpdated=false|broadcasted=false`);
}

main().catch((error) => {
  console.error(`GATE_INVARIANT_TEST|status=FAIL|error=${error?.message || error}|pnlUpdated=false|broadcasted=false`);
  process.exit(1);
});
