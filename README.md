# Apex Omega

Apex Omega is a Polygon PoS execution workstation for flashloan-backed arbitrage and liquidation payloads. It includes a React control surface, an Express/Node execution API, route adapter coverage checks, exact-calldata fork simulation gates, C1/C2 payload broadcasting, liquidation payload broadcasting, and P&L attribution rules that only count verified internal payload settlement.

This repository is private-execution infrastructure. Do not publish real `.env` files, private keys, relay credentials, API keys, runtime logs, or local config snapshots.

## Current System Status

Last local validation: 2026-06-24.

Local services were booted and verified:

| Surface | URL | Status |
| --- | --- | --- |
| Backend/API | `http://127.0.0.1:3000` | Running |
| Frontend/Vite | `http://127.0.0.1:5173` | Running |
| Local fork sim RPC | `http://127.0.0.1:8545` | Running |

The API reported `OPERATIONAL` and `LIVE_READY` during testing. That means runtime keys, chain reads, gas reads, configured target checks, and signer checks passed. It does not mean a profitable live arbitrage was found or submitted.

## Execution Model

Apex Omega recognizes three internal payload families:

| Payload | Purpose | Hash Rule |
| --- | --- | --- |
| `FLASHLOAN_INTEGRATED_C1_PAYLOADS` | Open an atomic C1 flashloan route. | Every submitted C1 creates its own tx hash. |
| `FLASHLOAN_INTEGRATED_C2_PAYLOADS` | React to a confirmed C1 with mirror or reverse execution. | Only `MIRROR` or `REVERSE` creates a C2 tx hash. `DO_NOTHING` does not. |
| `FLASHLOAN_INTEGRATED_LIQUIDATIONS` | Run liquidation path with flashloan capital, Aave liquidation, unwind, repay, and surplus settlement. | Every submitted liquidation creates its own tx hash. |

C2 lifecycle:

```text
C1_CONFIRMED
  -> C2_PENDING(block N+1..N+5)
  -> DO_NOTHING | MIRROR_TX | REVERSE_TX | EXPIRED
```

Only submitted transactions can affect the internal P&L tracker. Balance changes alone are telemetry, not P&L.

## Safety Gates

Live submission is gated by:

1. Runtime config readiness.
2. Chain ID match for Polygon `137`.
3. Target contract code presence.
4. Owner/signer alignment.
5. Payload structure validation.
6. Exact calldata construction.
7. Exact calldata fork simulation through `FORK_SIM_RPC_URL`.
8. Pre-send route state revalidation.
9. Flashloan repayment and fee accounting.
10. Net profit threshold.
11. P&L attribution from verified on-chain receipt/log evidence only.

If exact fork simulation fails, the execution path returns `FORK_SIMULATION_BLOCKED` and does not broadcast.

## Flashloan Capital Separation

Flashloan liquidity is intentionally separate from arbitrage pool discovery.

| Component | Role |
| --- | --- |
| Flashloan liquidity book | Finds possible capital source for the starting/ending route asset. |
| Arbitrage pool graph | Finds executable swap edges across DEX/AMM venues. |
| Liquidation hunter | Separate Aave account-health strategy, not part of cyclic arb route discovery. |

Desired priority:

1. Balancer Vault flashloan liquidity first when available.
2. Aave V3 Pool fallback.

Important current compatibility note: the dynamic route lister now models Balancer-first flashloan selection, but the deployed C1/C2 `ApexOmegaExecutionVM` contract path currently calls Aave V3 `flashLoanSimple`. The liquidation executor is Balancer-flashloan based. Full Balancer-first C1/C2 execution requires the C1/C2 on-chain executor to implement the Balancer Vault flashloan callback path, not only the off-chain selector.

## Discovery And Route Engine

The route adapter layer covers these invariant families:

| Invariant | Discovery Source | State Reader | Quote Adapter | Calldata Adapter | Pre-Send Revalidation |
| --- | --- | --- | --- | --- | --- |
| V2 CPMM | `PairCreated` events | `token0`, `token1`, `getReserves` | Constant product math | `swapExactTokensForTokens` | Reserve/token validation |
| V3 concentrated liquidity | `PoolCreated` events | `slot0`, `liquidity`, `fee` | V3 quoter | V3 router calldata | Slot0/liquidity validation |
| Algebra concentrated liquidity | Algebra pool events | `globalState`, `liquidity` | Algebra quoter | Algebra router calldata | Global state/liquidity validation |
| Curve stable swap | Curve address provider/registry | coins/balances | `get_dy` | Curve exchange adapter | Registry balance validation |
| Balancer weighted | Vault `PoolRegistered` events | Vault tokens, weights, fee | Weighted invariant math | Vault single swap | Token/weight/balance validation |
| Stable swap | Stable pool registry/factory | balances | `get_dy` | pool exchange adapter | balance validation |

Route rules:

- Start asset must be a flashloan asset.
- End asset must equal the flashloan asset.
- Repeated pool addresses are rejected.
- Unsupported invariants are rejected.
- Missing token metadata is rejected.
- Zero liquidity is rejected.
- Stale state is rejected.
- Missing quote/calldata adapters are rejected.
- Net profit must clear configured gates.

Route depth remains the mandate-supported cyclic depth: 2-hop, 3-hop, and 4-hop routes.

## Runtime Test Metrics

The following tests were run locally against the current runtime configuration unless noted.

| Test | Result | Wall Time | Evidence |
| --- | --- | ---: | --- |
| API health | PASS | 2.277s | `/api/system/healthz` returned `OPERATIONAL`. |
| API readiness | PASS | 2.259s | `/api/system/readiness` returned `LIVE_READY`, block `89056266`, gas `280.80 gwei`, signer available. |
| P&L summary | PASS | 2.305s | Session P&L raw `0`, lifetime P&L raw `0`, attribution `ONLY_VERIFIED_INTERNAL_PAYLOAD_HASH_TRANSFERS_TO_PROFIT_RECEIVER`. |
| Frontend root | PASS | 2.293s | Vite returned HTTP `200` and served `index.html`. |
| TypeScript lint | PASS | 13.638s | `npm run lint`. |
| Production build | PASS | 15.214s | `npm run build`. |
| Fork calldata simulation | PASS | 4.330s | `FORK_CALLDATA_SIM|ok=true`, chain `137`, exact calldata hash printed. |
| Route adapter/source verification | PASS | 43.653s | All six adapter classes reported `routeEligible=true`; recent discovery log probes succeeded. |
| Cloud readiness | PASS | 4.706s | `CLOUD_READINESS|status=PASS`; target code, owners, signer, Aave pool, liquidation target checked. |
| Full dynamic live-cycle under runtime config | TIMEOUT | 301.727s | `npm run live:cycle` did not emit a route table before timeout. |

### Runtime Interpretation

The positive checks prove that the API, UI, build, exact calldata fork simulation, adapter declarations, discovery source reachability, and cloud readiness gates are functioning.

The live-cycle timeout is a real limitation. Under the current full dynamic discovery implementation, uncached historical discovery can exceed practical runtime limits on the current RPC/fork setup. This means the system is not yet proven as a 24/7 full-dynamic route lister without an indexed discovery cache, bounded incremental refresh, or a dedicated archive/indexing RPC layer.

Do not interpret `LIVE_READY` as proof that the full discovery-to-opportunity loop is production-fast. It is a readiness gate, not a performance guarantee.

## Local Boot

Install dependencies:

```powershell
npm install
```

Start the backend/API:

```powershell
npm run dev
```

Start the frontend:

```powershell
npm exec -- vite --host 127.0.0.1 --port 5173
```

Verify listeners:

```powershell
Get-NetTCPConnection -LocalPort 3000,5173,8545
```

Open:

- API: `http://127.0.0.1:3000`
- Frontend: `http://127.0.0.1:5173`

## Validation Commands

Core validation:

```powershell
npm run lint
npm run build
npm run fork:calldata
npm run routes:verify
npm run cloud:readiness
```

Dynamic route cycle:

```powershell
npm run live:cycle
```

For performance diagnostics only, explicit environment bounds can be used. Bounded runs are not full-runtime proof:

```powershell
$env:LIVE_DISCOVERY_LOOKBACK_BLOCKS='5'
$env:LIVE_CURVE_MAX_POOLS='5'
$env:LIVE_BALANCER_MAX_POOLS='5'
$env:LIVE_ROUTE_MAX_CYCLES='20'
$env:LIVE_ROUTE_PRINT_LIMIT='10'
npm run live:cycle
```

## Docker

The repository includes:

- `Dockerfile` for the Apex Omega API/runtime image.
- `docker-compose.yml` with a mandatory Anvil fork sidecar.
- `docker/bor/Dockerfile` as a Bor binary build target.
- `.env.cloud.example` as a secret-free cloud runtime template.

Build:

```powershell
docker build -t apex-omega:local .
```

Compose boot:

```powershell
docker compose --env-file .env.production up -d --build apex-omega
```

Bor build target:

```powershell
docker compose --profile bor build bor-rpc
```

Local Docker status during validation: Docker Desktop was installed, but the Linux engine returned HTTP `500` on `_ping`, so the image build was not locally proven in this run.

## Required Cloud Configuration

Use a secret manager for all private values. Do not bake secrets into images.

Required:

- `POLYGON_RPC_URL`
- `DISCOVERY_RPC_URL`
- `FORK_UPSTREAM_RPC_URL`
- `FORK_SIM_RPC_URL`
- `EXECUTOR_PRIVATE_KEY` or `BOT_PRIVATE_KEY`
- `BOT_PROFIT_RECEIVER`
- `PROFIT_RECIPIENT_ADDRESS`
- `MIN_NET_PROFIT_USD`

Default deploy posture is monitor-only:

```env
LIVE_EXECUTION=false
SHADOW_MODE=true
```

To arm live execution:

```env
LIVE_EXECUTION=true
SHADOW_MODE=false
FORK_UPSTREAM_RPC_URL=<low-latency Polygon RPC>
FORK_SIM_RPC_URL=http://anvil-fork:8545
```

## Production Gaps

The following gaps must be closed before claiming fully autonomous 24/7 production operation:

1. Full dynamic route listing needs an indexed/incremental discovery layer. Current uncached full historical discovery timed out at 301.727 seconds.
2. Balancer-first flashloan selection for C1/C2 needs matching on-chain Balancer callback support in the C1/C2 executor. The liquidation executor already uses Balancer flashloan semantics.
3. Docker image build needs a healthy Docker Desktop/Linux engine or CI builder proof.
4. A real profitable route has not succeeded in this validation pass. No C1/C2 hash was produced because no profitable, fully gated candidate was proven during the completed tests.

## Integrity Rules

- No mock route data in production claims.
- No assumed P&L.
- No wallet-balance-only P&L.
- No route execution without final asset matching flashloan repayment asset.
- No live broadcast without exact fork simulation pass.
- No production readiness claim based only on code wiring.

