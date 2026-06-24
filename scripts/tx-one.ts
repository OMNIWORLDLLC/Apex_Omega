import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { simulateExactCalldataOnFork } from "../server/engine/routeAdapters.js";

const POLYGON_CHAIN_ID = 137n;
const ZERO_VALUE = 0n;
const SUBMIT_ACK = "I_ACCEPT_LIVE_TX";
const DEFAULT_GAS_LIMIT = 1_200_000n;
const POSITIONAL_FLAGS = new Set(["simulate", "submit", "sign", "no-sign", "include-raw"]);

const APEX_VM_ABI = [
  "function executeC1(uint8 flashloanSource, address flashloanAsset, uint256 flashloanAmount, tuple(address profitAsset,uint256 minNetProfit,uint256 nonce,bytes32 merkleRoot,bytes32[] proof,tuple(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 callValue,bytes payload)[] steps) context) external",
  "function executeC2(bytes32 c1InternalId, uint8 flashloanSource, address flashloanAsset, uint256 flashloanAmount, tuple(address profitAsset,uint256 minNetProfit,uint256 nonce,bytes32 merkleRoot,bytes32[] proof,tuple(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 callValue,bytes payload)[] steps) context) external",
];

const LIQUIDATION_EXECUTOR_ABI = [
  "function executeLiquidation(tuple(address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minProfitBps,uint8 swapProtocol,uint24 swapFee,uint256 minDebtAmountOut,address curvePool,uint256 maxSlippageBps) params) external",
];

type JsonObject = Record<string, any>;

type BuiltPayload = {
  payloadKind: string;
  canonicalName: string;
  to: string;
  data: string;
  value: bigint;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      if (POSITIONAL_FLAGS.has(arg)) flags.set(arg, true);
      const [key, inlineValue] = arg.split("=", 2);
      if (inlineValue !== undefined && key.trim()) flags.set(key.trim(), inlineValue);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
    } else if (args[i + 1] && !args[i + 1].startsWith("--")) {
      flags.set(key, args[i + 1]);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function usage(): never {
  console.error([
    "Usage:",
    "  npm run tx:one -- path/to/payload.json [simulate] [submit] [sign] [no-sign] [include-raw] [out=result.json] [ack=I_ACCEPT_LIVE_TX]",
    "  npx tsx scripts/tx-one.ts --payload path/to/payload.json [--simulate] [--submit] [--out tx-result.json]",
    "",
    "Payload kinds:",
    "  C1:          { payloadKind, targetContract, flashloanSource, flashloanAsset, flashloanAmount, context }",
    "  C2:          { payloadKind, targetContract, c1InternalId, flashloanSource, flashloanAsset, flashloanAmount, context }",
    "  Liquidation: { payloadKind, targetContract, liquidation }",
    "  Raw:         { payloadKind: \"RAW_TX\", to, data, value? }",
    "",
    "Submit gates:",
    "  simulate encodes, decodes, and fork-simulates exact calldata without signing by default.",
    "  add sign only when you intentionally want a signed, unsubmitted artifact.",
    "  --submit also requires LIVE_EXECUTION=true, SHADOW_MODE=false, TX_ONE_ACK=I_ACCEPT_LIVE_TX, signer key, RPC, and fork sim pass.",
    "  Signed raw bytes are hidden unless --include-raw or TX_ONE_INCLUDE_RAW=true is set.",
  ].join("\n"));
  process.exit(1);
}

function readConfig(): JsonObject {
  const configPath = path.join(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function readPayload(flags: Map<string, string | boolean>): JsonObject {
  const positionalPayloadPath = process.argv.slice(2).find((arg) => !arg.startsWith("--") && !POSITIONAL_FLAGS.has(arg));
  const payloadPath = flags.get("payload") || positionalPayloadPath;
  if (typeof payloadPath !== "string" || !payloadPath.trim()) usage();
  const resolved = path.resolve(payloadPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PAYLOAD_FILE_NOT_FOUND:${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf-8"));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function requireAddress(label: string, value: unknown): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label}_MISSING_OR_INVALID`);
  }
  return ethers.getAddress(value);
}

function optionalAddress(value: unknown): string | undefined {
  return typeof value === "string" && ethers.isAddress(value) ? ethers.getAddress(value) : undefined;
}

function requireHex(label: string, value: unknown, length?: number): string {
  if (typeof value !== "string" || !ethers.isHexString(value, length)) {
    throw new Error(`${label}_MISSING_OR_INVALID_HEX`);
  }
  return value;
}

function bigintValue(label: string, value: unknown, fallback?: bigint): bigint {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label}_MISSING`);
  }
  if (!["string", "number", "bigint", "boolean"].includes(typeof value)) {
    throw new Error(`${label}_INVALID_BIGINT`);
  }
  try {
    return BigInt(value as string | number | bigint | boolean);
  } catch {
    throw new Error(`${label}_INVALID_BIGINT`);
  }
}

function numberValue(label: string, value: unknown, fallback?: number): number {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label}_MISSING`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label}_INVALID_NUMBER`);
  return parsed;
}

function normalizeContext(context: JsonObject) {
  if (!context || typeof context !== "object") throw new Error("CONTEXT_MISSING");
  const steps = Array.isArray(context.steps) ? context.steps : [];
  if (steps.length === 0) throw new Error("CONTEXT_STEPS_MISSING");

  return {
    profitAsset: requireAddress("CONTEXT_PROFIT_ASSET", context.profitAsset),
    minNetProfit: bigintValue("CONTEXT_MIN_NET_PROFIT", context.minNetProfit),
    nonce: bigintValue("CONTEXT_NONCE", context.nonce),
    merkleRoot: context.merkleRoot === undefined ? ethers.ZeroHash : requireHex("CONTEXT_MERKLE_ROOT", context.merkleRoot, 32),
    proof: Array.isArray(context.proof) ? context.proof.map((item, idx) => requireHex(`CONTEXT_PROOF_${idx}`, item, 32)) : [],
    steps: steps.map((step: JsonObject, idx: number) => ({
      venue: requireAddress(`CONTEXT_STEPS_${idx}_VENUE`, step.venue),
      tokenIn: requireAddress(`CONTEXT_STEPS_${idx}_TOKEN_IN`, step.tokenIn),
      tokenOut: requireAddress(`CONTEXT_STEPS_${idx}_TOKEN_OUT`, step.tokenOut),
      amountIn: bigintValue(`CONTEXT_STEPS_${idx}_AMOUNT_IN`, step.amountIn),
      minAmountOut: bigintValue(`CONTEXT_STEPS_${idx}_MIN_AMOUNT_OUT`, step.minAmountOut),
      callValue: bigintValue(`CONTEXT_STEPS_${idx}_CALL_VALUE`, step.callValue, 0n),
      payload: requireHex(`CONTEXT_STEPS_${idx}_PAYLOAD`, step.payload),
    })),
  };
}

function normalizeLiquidation(liquidation: JsonObject) {
  if (!liquidation || typeof liquidation !== "object") throw new Error("LIQUIDATION_MISSING");
  const swapProtocol = numberValue("LIQUIDATION_SWAP_PROTOCOL", liquidation.swapProtocol);
  const curvePool = liquidation.curvePool === undefined || liquidation.curvePool === ""
    ? ethers.ZeroAddress
    : requireAddress("LIQUIDATION_CURVE_POOL", liquidation.curvePool);
  if (swapProtocol === 4 && curvePool === ethers.ZeroAddress) throw new Error("LIQUIDATION_CURVE_POOL_REQUIRED");
  const maxSlippageBps = numberValue("LIQUIDATION_MAX_SLIPPAGE_BPS", liquidation.maxSlippageBps);
  if (maxSlippageBps > 10_000) throw new Error("LIQUIDATION_MAX_SLIPPAGE_BPS_TOO_HIGH");

  return {
    collateralAsset: requireAddress("LIQUIDATION_COLLATERAL_ASSET", liquidation.collateralAsset),
    debtAsset: requireAddress("LIQUIDATION_DEBT_ASSET", liquidation.debtAsset),
    user: requireAddress("LIQUIDATION_USER", liquidation.user),
    debtToCover: bigintValue("LIQUIDATION_DEBT_TO_COVER", liquidation.debtToCover),
    minProfitBps: bigintValue("LIQUIDATION_MIN_PROFIT_BPS", liquidation.minProfitBps),
    swapProtocol,
    swapFee: numberValue("LIQUIDATION_SWAP_FEE", liquidation.swapFee),
    minDebtAmountOut: bigintValue("LIQUIDATION_MIN_DEBT_AMOUNT_OUT", liquidation.minDebtAmountOut),
    curvePool,
    maxSlippageBps,
  };
}

function targetFromConfig(input: JsonObject, cfg: JsonObject, kind: "c1" | "c2" | "liquidation" | "raw") {
  if (kind === "raw") return requireAddress("RAW_TO", firstString(input.to, input.targetContract));
  if (kind === "c1") {
    return requireAddress("C1_TARGET", firstString(input.targetContract, cfg.C1_ARB_EXECUTOR_ADDRESS, cfg.C1_TARGET, cfg.ARB_CONTRACT_ADDRESS, process.env.C1_ARB_EXECUTOR_ADDRESS, process.env.C1_TARGET, process.env.ARB_CONTRACT_ADDRESS));
  }
  if (kind === "c2") {
    return requireAddress("C2_TARGET", firstString(input.targetContract, cfg.C2_ARB_EXECUTOR_ADDRESS, cfg.C2_TARGET, cfg.C1_ARB_EXECUTOR_ADDRESS, cfg.C1_TARGET, cfg.ARB_CONTRACT_ADDRESS, process.env.C2_ARB_EXECUTOR_ADDRESS, process.env.C2_TARGET, process.env.C1_ARB_EXECUTOR_ADDRESS, process.env.C1_TARGET, process.env.ARB_CONTRACT_ADDRESS));
  }
  return requireAddress("LIQUIDATION_TARGET", firstString(input.targetContract, cfg.LIQUIDATION_EXECUTOR_ADDRESS, cfg.LIQUIDATION_EXECUTOR_CONTRACT, process.env.LIQUIDATION_EXECUTOR_ADDRESS, process.env.LIQUIDATION_EXECUTOR_CONTRACT));
}

function classifyKind(input: JsonObject): "c1" | "c2" | "liquidation" | "raw" {
  const raw = String(input.payloadKind || input.kind || "").toLowerCase();
  if (raw === "c1" || raw.includes("c1_payload")) return "c1";
  if (raw === "c2" || raw.includes("c2_payload")) return "c2";
  if (raw === "liquidation" || raw.includes("liquidation")) return "liquidation";
  if (raw === "raw" || raw === "raw_tx" || raw === "transaction") return "raw";
  if (input.data && (input.to || input.targetContract)) return "raw";
  throw new Error("PAYLOAD_KIND_UNSUPPORTED");
}

function buildPayload(input: JsonObject, cfg: JsonObject): BuiltPayload {
  const kind = classifyKind(input);
  const to = targetFromConfig(input, cfg, kind);
  if (kind === "raw") {
    return {
      payloadKind: "RAW_TX",
      canonicalName: "RAW TRANSACTION",
      to,
      data: requireHex("RAW_DATA", input.data),
      value: bigintValue("RAW_VALUE", input.value, 0n),
    };
  }

  if (kind === "liquidation") {
    const iface = new ethers.Interface(LIQUIDATION_EXECUTOR_ABI);
    return {
      payloadKind: "FLASHLOAN_INTEGRATED_LIQUIDATIONS",
      canonicalName: "FLASHLOAN INTEGRATED LIQUIDATIONS",
      to,
      data: iface.encodeFunctionData("executeLiquidation", [normalizeLiquidation(input.liquidation || input.params)]),
      value: ZERO_VALUE,
    };
  }

  const iface = new ethers.Interface(APEX_VM_ABI);
  const flashloanSource = numberValue("FLASHLOAN_SOURCE", input.flashloanSource);
  const flashloanAsset = requireAddress("FLASHLOAN_ASSET", input.flashloanAsset);
  const flashloanAmount = bigintValue("FLASHLOAN_AMOUNT", input.flashloanAmount);
  const context = normalizeContext(input.context);

  if (kind === "c1") {
    return {
      payloadKind: "FLASHLOAN_INTEGRATED_C1_PAYLOADS",
      canonicalName: "FLASHLOAN INTEGRATED C1 PAYLOADS",
      to,
      data: iface.encodeFunctionData("executeC1", [flashloanSource, flashloanAsset, flashloanAmount, context]),
      value: ZERO_VALUE,
    };
  }

  return {
    payloadKind: "FLASHLOAN_INTEGRATED_C2_PAYLOADS",
    canonicalName: "FLASHLOAN INTEGRATED C2 PAYLOADS",
    to,
    data: iface.encodeFunctionData("executeC2", [
      requireHex("C1_INTERNAL_ID", input.c1InternalId, 32),
      flashloanSource,
      flashloanAsset,
      flashloanAmount,
      context,
    ]),
    value: ZERO_VALUE,
  };
}

function decodeBuiltPayload(payload: BuiltPayload) {
  const abi = payload.payloadKind === "FLASHLOAN_INTEGRATED_LIQUIDATIONS"
    ? LIQUIDATION_EXECUTOR_ABI
    : payload.payloadKind === "RAW_TX"
      ? undefined
      : APEX_VM_ABI;
  if (!abi) return { ok: false, reason: "RAW_PAYLOAD_ABI_NOT_AVAILABLE" };
  const parsed = new ethers.Interface(abi).parseTransaction({ data: payload.data, value: payload.value });
  if (!parsed) return { ok: false, reason: "FUNCTION_SELECTOR_NOT_RECOGNIZED" };
  return {
    ok: true,
    functionName: parsed.name,
    signature: parsed.signature,
    selector: ethers.id(parsed.signature).slice(0, 10),
    args: parsed.args.length,
  };
}

function getRpcUrl(cfg: JsonObject): string | undefined {
  return firstString(
    process.env.POLYGON_RPC_URL,
    process.env.POLYGON_RPC,
    process.env.RPC_URL,
    cfg.POLYGON_RPC_URL,
    cfg.DRPC_HTTP,
    cfg.PUBLIC_1RPC,
    cfg.PUBLIC_LLAMA,
    cfg.PUBLIC_POLYGON_RPC,
  );
}

function getPrivateKey(): string | undefined {
  return firstString(process.env.EXECUTOR_PRIVATE_KEY, process.env.BOT_PRIVATE_KEY, process.env.PRIVATE_KEY);
}

function getSimulationFrom(input: JsonObject, cfg: JsonObject, wallet?: ethers.Wallet): string | undefined {
  return wallet?.address || optionalAddress(firstString(
    input.from,
    cfg.EXECUTOR_WALLET,
    cfg.EXECUTOR_WALLET_ADDRESS,
    cfg.WALLET_ADDRESS,
    process.env.EXECUTOR_WALLET,
    process.env.EXECUTOR_WALLET_ADDRESS,
    process.env.WALLET_ADDRESS,
    process.env.BOT_WALLET,
  ));
}

function parseChainId(flags: Map<string, string | boolean>) {
  const raw = firstString(flags.get("chain-id"), process.env.CHAIN_ID, String(POLYGON_CHAIN_ID));
  return BigInt(raw);
}

function flagBigInt(flags: Map<string, string | boolean>, key: string, envKey: string, fallback?: bigint) {
  return bigintValue(key.toUpperCase().replace(/-/g, "_"), firstString(flags.get(key), process.env[envKey]), fallback);
}

function requireSubmitArmed(flags: Map<string, string | boolean>, signerAvailable: boolean) {
  if (!flags.has("submit")) return;
  if (process.env.LIVE_EXECUTION !== "true") throw new Error("SUBMIT_BLOCKED_LIVE_EXECUTION_NOT_TRUE");
  if (process.env.SHADOW_MODE !== "false") throw new Error("SUBMIT_BLOCKED_SHADOW_MODE_NOT_FALSE");
  if (firstString(flags.get("ack"), process.env.TX_ONE_ACK) !== SUBMIT_ACK) throw new Error("SUBMIT_BLOCKED_TX_ONE_ACK_REQUIRED");
  if (!signerAvailable) throw new Error("SUBMIT_BLOCKED_SIGNER_MISSING");
}

async function maybeBuildTransaction(
  flags: Map<string, string | boolean>,
  payload: BuiltPayload,
  provider: ethers.JsonRpcProvider | undefined,
  wallet: ethers.Wallet | undefined,
  chainId: bigint,
) {
  if (!provider) return undefined;
  const network = await provider.getNetwork();
  if (network.chainId !== chainId) throw new Error(`CHAIN_ID_MISMATCH:${network.chainId.toString()}!=${chainId.toString()}`);
  if (!wallet) return undefined;

  const gasLimit = flagBigInt(flags, "gas-limit", "TX_ONE_GAS_LIMIT", DEFAULT_GAS_LIMIT);
  const nonce = flags.has("nonce")
    ? Number(flagBigInt(flags, "nonce", "TX_ONE_NONCE"))
    : await provider.getTransactionCount(wallet.address, "pending");
  const feeData = await provider.getFeeData();
  const maxFeePerGas = flagBigInt(flags, "max-fee-per-gas", "TX_ONE_MAX_FEE_PER_GAS", feeData.maxFeePerGas ?? ethers.parseUnits("80", "gwei"));
  const maxPriorityFeePerGas = flagBigInt(flags, "max-priority-fee-per-gas", "TX_ONE_MAX_PRIORITY_FEE_PER_GAS", feeData.maxPriorityFeePerGas ?? ethers.parseUnits("30", "gwei"));

  return {
    type: 2,
    chainId,
    to: payload.to,
    nonce,
    value: payload.value,
    data: payload.data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  } satisfies ethers.TransactionRequest;
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  const flags = parseArgs();
  if (flags.has("help")) usage();

  const cfg = readConfig();
  const input = readPayload(flags);
  const payload = buildPayload(input, cfg);
  const chainId = parseChainId(flags);
  const rpcUrl = getRpcUrl(cfg);
  const provider = rpcUrl ? new ethers.JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }) : undefined;
  const privateKey = getPrivateKey();
  const shouldSimulate = flags.has("simulate") || flags.has("submit");
  const simulateOnly = flags.has("simulate") && !flags.has("submit");
  const signingDisabled = flags.has("no-sign") || process.env.TX_ONE_NO_SIGN === "true" || (simulateOnly && !flags.has("sign"));
  const wallet = !signingDisabled && privateKey && provider ? new ethers.Wallet(privateKey, provider) : !signingDisabled && privateKey ? new ethers.Wallet(privateKey) : undefined;

  requireSubmitArmed(flags, Boolean(wallet && provider));

  const result: JsonObject = {
    payloadKind: payload.payloadKind,
    canonicalName: payload.canonicalName,
    chainId: chainId.toString(),
    to: payload.to,
    value: payload.value,
    selector: payload.data.slice(0, 10),
    calldata: payload.data,
    calldataHash: ethers.keccak256(payload.data),
    abiDecode: decodeBuiltPayload(payload),
    signer: wallet?.address ?? null,
    rpcConfigured: Boolean(provider),
    signed: false,
    submitted: false,
    broadcasted: false,
    pnlUpdated: false,
  };

  if (shouldSimulate) {
    const from = getSimulationFrom(input, cfg, wallet);
    if (!from) throw new Error("SIMULATION_FROM_MISSING");
    const sim = await simulateExactCalldataOnFork({
      to: payload.to,
      from,
      data: payload.data,
      value: payload.value,
      forkRpcUrl: firstString(flags.get("fork-rpc"), process.env.FORK_SIM_RPC_URL),
    });
    result.forkSimulation = sim;
    if (!sim.ok) throw new Error(`FORK_SIMULATION_BLOCKED:${sim.error || "unknown"}`);
  }

  const txRequest = await maybeBuildTransaction(flags, payload, provider, wallet, chainId);
  if (txRequest) {
    result.unsignedTx = txRequest;
    const signedRawTx = await wallet!.signTransaction(txRequest);
    const parsed = ethers.Transaction.from(signedRawTx);
    const includeRaw = flags.has("include-raw") || process.env.TX_ONE_INCLUDE_RAW === "true";
    result.signed = true;
    result.signedRawTxBytes = (signedRawTx.length - 2) / 2;
    if (includeRaw) result.signedRawTx = signedRawTx;
    result.signedRawTxHash = ethers.keccak256(signedRawTx);
    result.parsedTxHash = parsed.hash;
    result.from = parsed.from;
    result.hashMatches = result.signedRawTxHash === parsed.hash;
    result.fromMatches = parsed.from?.toLowerCase() === wallet!.address.toLowerCase();
    if (!result.hashMatches || !result.fromMatches) throw new Error("SIGNED_TX_VALIDATION_FAILED");

    if (flags.has("submit")) {
      const response = await provider!.broadcastTransaction(signedRawTx);
      result.submitted = true;
      result.broadcasted = true;
      result.txHash = response.hash;
      result.hashLink = chainId === POLYGON_CHAIN_ID ? `https://polygonscan.com/tx/${response.hash}` : null;
    }
  }

  const output = JSON.stringify(result, jsonReplacer, 2);
  const outPath = flags.get("out");
  if (typeof outPath === "string" && outPath.trim()) {
    fs.writeFileSync(path.resolve(outPath), `${output}\n`);
  }
  console.log(`TX_ONE|payloadKind=${payload.payloadKind}|to=${payload.to}|selector=${payload.data.slice(0, 10)}|calldataHash=${result.calldataHash}|signed=${result.signed}|submitted=${result.submitted}|hash=${result.txHash ?? "NONE"}`);
  console.log(output);
}

main().catch((error) => {
  console.error(`TX_ONE_FAILED|${error?.message || error}`);
  process.exit(1);
});
