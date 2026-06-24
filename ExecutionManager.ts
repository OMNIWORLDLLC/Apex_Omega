import { ethers } from "ethers";
import { simulateExactCalldataOnFork } from "./server/engine/routeAdapters.js";

export interface VmRouteStep {
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint | string;
  minAmountOut: bigint | string;
  callValue?: bigint | string;
  payload: string;
}

export interface VmExecutionContext {
  profitAsset: string;
  minNetProfit: bigint | string;
  nonce: bigint | string;
  merkleRoot?: string;
  proof?: string[];
  steps: VmRouteStep[];
}

export interface LiquidationParams {
  collateralAsset: string;
  debtAsset: string;
  user: string;
  debtToCover: bigint | string;
  minProfitBps: number;
  swapProtocol: number;
  swapFee: number;
  minDebtAmountOut: bigint | string;
  curvePool?: string;
  maxSlippageBps: number;
}

export type VmBroadcastResult = {
  success: boolean;
  hash?: string;
  expectedProfit?: string;
  error?: string;
  payloadKind?: string;
  hashLink?: string;
  forkSimulation?: { ok: boolean; error?: string };
};

const APEX_VM_ABI = [
  "function executeC1(uint8 flashloanSource, address flashloanAsset, uint256 flashloanAmount, tuple(address profitAsset,uint256 minNetProfit,uint256 nonce,bytes32 merkleRoot,bytes32[] proof,tuple(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 callValue,bytes payload)[] steps) context) external",
  "function executeC2(bytes32 c1InternalId, uint8 flashloanSource, address flashloanAsset, uint256 flashloanAmount, tuple(address profitAsset,uint256 minNetProfit,uint256 nonce,bytes32 merkleRoot,bytes32[] proof,tuple(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 callValue,bytes payload)[] steps) context) external",
  "function globalNonce() view returns (uint256)",
];

const LIQUIDATION_EXECUTOR_ABI = [
  "function executeLiquidation(tuple(address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minProfitBps,uint8 swapProtocol,uint24 swapFee,uint256 minDebtAmountOut,address curvePool,uint256 maxSlippageBps) params) external",
];

export class DeFiExecutorManager {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet | null = null;
  private isDryRun: boolean;

  constructor(rpcUrl: string, privateKey?: string, isDryRun: boolean = false) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    if (privateKey) {
      try {
        this.signer = new ethers.Wallet(privateKey, this.provider);
      } catch (e) {
        console.warn("[DeFiExecutorManager] Invalid private key. Running in read-only mode.");
      }
    }
    this.isDryRun = isDryRun;
  }

  setDryRun(dryRun: boolean) {
    this.isDryRun = dryRun;
  }

  setRpcUrl(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    if (this.signer) {
      this.signer = new ethers.Wallet(this.signer.privateKey, this.provider);
    }
  }

  getWalletAddress(): string {
    return this.signer?.address || "0x0000000000000000000000000000000000000000";
  }

  isArmed(): boolean {
    return !this.isDryRun && this.signer !== null;
  }

  hasSigner(): boolean {
    return this.signer !== null;
  }

  private blockedResult(action: string): VmBroadcastResult | null {
    if (this.isDryRun || !this.signer) {
      return {
        success: false,
        error: this.isDryRun
          ? `DRY_RUN_BLOCKED: ${action} disabled by runtime mode.`
          : `SIGNER_UNAVAILABLE: no private key loaded for ${action}.`,
      };
    }
    return null;
  }

  private async requireForkSimulation(payloadKind: string, to: string, data: string): Promise<VmBroadcastResult | null> {
    if (!this.signer) {
      return { success: false, error: `SIGNER_UNAVAILABLE: no private key loaded for ${payloadKind}.`, payloadKind };
    }
    const sim = await simulateExactCalldataOnFork({
      to,
      from: this.signer.address,
      data,
      value: 0n,
    });
    if (!sim.ok) {
      return {
        success: false,
        error: `FORK_SIMULATION_BLOCKED: ${sim.error || "unknown fork simulation failure"}`,
        payloadKind,
        forkSimulation: { ok: false, error: sim.error },
      };
    }
    return null;
  }
  private requireAddress(value: string, label: string) {
    if (!ethers.isAddress(value)) {
      throw new Error(`INVALID_${label.toUpperCase()}: ${value}`);
    }
  }

  private normalizeContext(context: VmExecutionContext) {
    this.requireAddress(context.profitAsset, "profitAsset");
    if (!context.steps?.length) {
      throw new Error("INVALID_EXECUTION_CONTEXT: at least one route step is required.");
    }

    return {
      profitAsset: context.profitAsset,
      minNetProfit: BigInt(context.minNetProfit),
      nonce: BigInt(context.nonce),
      merkleRoot: context.merkleRoot || ethers.ZeroHash,
      proof: context.proof || [],
      steps: context.steps.map((step, idx) => {
        this.requireAddress(step.venue, `steps[${idx}].venue`);
        this.requireAddress(step.tokenIn, `steps[${idx}].tokenIn`);
        this.requireAddress(step.tokenOut, `steps[${idx}].tokenOut`);
        if (!ethers.isHexString(step.payload)) {
          throw new Error(`INVALID_STEPS_${idx}_PAYLOAD: payload must be hex calldata.`);
        }
        return {
          venue: step.venue,
          tokenIn: step.tokenIn,
          tokenOut: step.tokenOut,
          amountIn: BigInt(step.amountIn),
          minAmountOut: BigInt(step.minAmountOut),
          callValue: BigInt(step.callValue || 0),
          payload: step.payload,
        };
      }),
    };
  }

  private normalizeLiquidationParams(params: LiquidationParams) {
    this.requireAddress(params.collateralAsset, "collateralAsset");
    this.requireAddress(params.debtAsset, "debtAsset");
    this.requireAddress(params.user, "user");
    const curvePool = params.curvePool || ethers.ZeroAddress;
    if (params.swapProtocol === 4) this.requireAddress(curvePool, "curvePool");
    if (params.maxSlippageBps > 10000) throw new Error("INVALID_MAX_SLIPPAGE_BPS");
    if (BigInt(params.minDebtAmountOut) <= 0n) throw new Error("INVALID_MIN_DEBT_AMOUNT_OUT");
    return {
      collateralAsset: params.collateralAsset,
      debtAsset: params.debtAsset,
      user: params.user,
      debtToCover: BigInt(params.debtToCover),
      minProfitBps: BigInt(params.minProfitBps),
      swapProtocol: params.swapProtocol,
      swapFee: params.swapFee,
      minDebtAmountOut: BigInt(params.minDebtAmountOut),
      curvePool,
      maxSlippageBps: BigInt(params.maxSlippageBps),
    };
  }

  async getVmNonce(targetContract: string): Promise<bigint> {
    this.requireAddress(targetContract, "targetContract");
    const contract = new ethers.Contract(targetContract, APEX_VM_ABI, this.provider);
    return await contract.globalNonce();
  }

  buildVmCallData(kind: "C1" | "C2", args: any[]) {
    const iface = new ethers.Interface(APEX_VM_ABI);
    return iface.encodeFunctionData(kind === "C1" ? "executeC1" : "executeC2", args);
  }

  buildLiquidationCallData(params: LiquidationParams) {
    const iface = new ethers.Interface(LIQUIDATION_EXECUTOR_ABI);
    return iface.encodeFunctionData("executeLiquidation", [this.normalizeLiquidationParams(params)]);
  }

  async broadcastFlashloanIntegratedC1Payload(
    targetContract: string,
    flashloanSource: number,
    flashloanAsset: string,
    flashloanAmount: bigint | string,
    context: VmExecutionContext
  ): Promise<VmBroadcastResult> {
    const blocked = this.blockedResult("FLASHLOAN INTEGRATED C1 PAYLOADS broadcast");
    if (blocked) return { ...blocked, payloadKind: "FLASHLOAN_INTEGRATED_C1_PAYLOADS" };

    try {
      this.requireAddress(targetContract, "targetContract");
      this.requireAddress(flashloanAsset, "flashloanAsset");
      const normalized = this.normalizeContext(context);
      const data = this.buildVmCallData("C1", [flashloanSource, flashloanAsset, BigInt(flashloanAmount), normalized]);
      const forkBlocked = await this.requireForkSimulation("FLASHLOAN_INTEGRATED_C1_PAYLOADS", targetContract, data);
      if (forkBlocked) return forkBlocked;
      const tx = await this.signer!.sendTransaction({ to: targetContract, data, value: 0n });
      return { success: true, hash: tx.hash, hashLink: `https://polygonscan.com/tx/${tx.hash}`, payloadKind: "FLASHLOAN_INTEGRATED_C1_PAYLOADS", forkSimulation: { ok: true } };
    } catch (error: any) {
      return { success: false, error: error?.message || "C1 execution failed", payloadKind: "FLASHLOAN_INTEGRATED_C1_PAYLOADS" };
    }
  }

  async broadcastFlashloanIntegratedC2Payload(
    targetContract: string,
    c1InternalId: string,
    flashloanSource: number,
    flashloanAsset: string,
    flashloanAmount: bigint | string,
    context: VmExecutionContext
  ): Promise<VmBroadcastResult> {
    const blocked = this.blockedResult("FLASHLOAN INTEGRATED C2 PAYLOADS broadcast");
    if (blocked) return { ...blocked, payloadKind: "FLASHLOAN_INTEGRATED_C2_PAYLOADS" };

    try {
      this.requireAddress(targetContract, "targetContract");
      this.requireAddress(flashloanAsset, "flashloanAsset");
      if (!ethers.isHexString(c1InternalId, 32)) throw new Error("INVALID_C1_INTERNAL_ID: expected bytes32.");
      const normalized = this.normalizeContext(context);
      const data = this.buildVmCallData("C2", [c1InternalId, flashloanSource, flashloanAsset, BigInt(flashloanAmount), normalized]);
      const forkBlocked = await this.requireForkSimulation("FLASHLOAN_INTEGRATED_C2_PAYLOADS", targetContract, data);
      if (forkBlocked) return forkBlocked;
      const tx = await this.signer!.sendTransaction({ to: targetContract, data, value: 0n });
      return { success: true, hash: tx.hash, hashLink: `https://polygonscan.com/tx/${tx.hash}`, payloadKind: "FLASHLOAN_INTEGRATED_C2_PAYLOADS", forkSimulation: { ok: true } };
    } catch (error: any) {
      return { success: false, error: error?.message || "C2 execution failed", payloadKind: "FLASHLOAN_INTEGRATED_C2_PAYLOADS" };
    }
  }

  async broadcastFlashloanIntegratedLiquidation(params: {
    targetContract: string;
    liquidation: LiquidationParams;
  }): Promise<VmBroadcastResult> {
    const blocked = this.blockedResult("FLASHLOAN INTEGRATED LIQUIDATIONS broadcast");
    if (blocked) return { ...blocked, payloadKind: "FLASHLOAN_INTEGRATED_LIQUIDATIONS" };

    try {
      this.requireAddress(params.targetContract, "targetContract");
      const data = this.buildLiquidationCallData(params.liquidation);
      const forkBlocked = await this.requireForkSimulation("FLASHLOAN_INTEGRATED_LIQUIDATIONS", params.targetContract, data);
      if (forkBlocked) return forkBlocked;
      const tx = await this.signer!.sendTransaction({ to: params.targetContract, data, value: 0n });
      return { success: true, hash: tx.hash, hashLink: `https://polygonscan.com/tx/${tx.hash}`, payloadKind: "FLASHLOAN_INTEGRATED_LIQUIDATIONS", forkSimulation: { ok: true } };
    } catch (error: any) {
      return { success: false, error: error?.message || "Liquidation execution failed", payloadKind: "FLASHLOAN_INTEGRATED_LIQUIDATIONS" };
    }
  }

  async calculateLiveMath(tier: number, rawInput: number, marketIndexPrice: number): Promise<number> {
    return Number(rawInput.toFixed(6));
  }
}
