import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, ArrowRight, Activity, Zap, ShieldAlert, Cpu } from "lucide-react";

interface Opportunity {
  routeId?: string;
  routeOrientation?: string;
  reverseOf?: string;
  pair: string;
  route?: string;
  spread_bps?: number;
  profit_usd?: number;
  grossProfitUsd?: number;
  flashFeeUsd?: number;
  gasCostUsd?: number;
  netProfitUsd?: number;
  lowestPoolTvlUsd?: number;
  amountIn?: string;
  amountOut?: string;
  hops?: number;
  reason?: string;
  leg1BuyPrice?: number;
  leg2SellPrice?: number;
  priceEdgeBps?: number;
  priceVariance?: {
    ok?: boolean;
    mode?: string;
    rule?: string;
    reason?: string;
    reverseMathHint?: {
      buyLeg1IfReversed?: number;
      sellLeg2IfReversed?: number;
      naiveReverseEdgeBps?: number;
      naiveReverseGrossPositive?: boolean;
      warning?: string;
    };
  };
  reverseMathHint?: {
    buyLeg1IfReversed?: number;
    sellLeg2IfReversed?: number;
    naiveReverseEdgeBps?: number;
    naiveReverseGrossPositive?: boolean;
    warning?: string;
  };
  flashloanSymbol?: string;
  dex_a?: string;
  dex_b?: string;
  confidence?: number;
  c1ExecutionEligible?: boolean;
  c1ExecutionSlot?: number;
  status?: string;
  path?: string;
  venues?: string;
}

interface HyperImmersiveOpportunitiesProps {
  opportunities: Opportunity[];
  diagnostics?: any;
  connectionStatus?: "live" | "poll" | "reconnecting" | "connecting" | "error";
}

export default function HyperImmersiveOpportunities({ opportunities, diagnostics, connectionStatus = "poll" }: HyperImmersiveOpportunitiesProps) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const discovery = diagnostics?.discovery || {};
  const routeLimits = diagnostics?.routeLimits || {};
  const totalRoutes = discovery.total_routes_observed ?? routeLimits.totalRoutesObserved ?? opportunities.length;
  const topRouteLimit = routeLimits.topRouteDisplayLimit ?? discovery.top_50_routes_visible ?? 50;
  const visibleRoutes = routeLimits.visibleRoutes ?? opportunities.length;
  const c1ExecutableVisible = discovery.c1_executable_visible ?? routeLimits.c1ExecutableVisible ?? opportunities.filter((opp) => opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE").length;
  const c1Limit = routeLimits.c1ExecutableLimitPerCycle ?? discovery.c1_executable_limit_per_cycle ?? 10;
  const c2PerC1Limit = routeLimits.c2PerC1Limit ?? discovery.c2_per_c1_limit ?? 5;
  const c2Limit = routeLimits.c2DecisionLimitPerCycle ?? discovery.c2_decision_limit_per_cycle ?? 50;
  const c2DecisionCount = routeLimits.c2DecisionCount ?? discovery.c2_decision_count ?? 0;
  const statusText = connectionStatus === "live"
    ? diagnostics?.summary || "Live opportunity feed connected"
    : "API feed disconnected or returning invalid data";
  const statusTone = connectionStatus === "live" ? "text-cyan-400" : "text-red-400";
  const minProfitUsd = Number(discovery.min_profit_usd ?? 5);

  const formatUsd = (value: unknown, digits = 2) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    const sign = numeric > 0 ? "+" : "";
    return `${sign}$${numeric.toFixed(digits)}`;
  };
  const formatNumber = (value: unknown, digits = 6) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(digits) : "--";
  };

  const assetGroup = (symbol?: string) => {
    const normalized = (symbol || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
    if (["USDC", "USDC.E", "USDT", "USDT0", "DAI", "MAI", "MIMATIC"].includes(normalized)) return "USD STABLES";
    if (["WPOL", "WMATIC", "POL", "MATIC"].includes(normalized)) return "POL / MATIC";
    if (["WETH", "ETH"].includes(normalized)) return "ETH";
    if (["WBTC", "BTC"].includes(normalized)) return "BTC";
    return normalized || "OTHER";
  };

  const graphGroups = Object.values(opportunities.reduce((acc, opp) => {
    const key = assetGroup(opp.flashloanSymbol || opp.pair?.split(" ")[0]);
    const group = acc[key] || {
      key,
      routes: 0,
      direct: 0,
      reversed: 0,
      executable: 0,
      blocked: 0,
      naiveReversePositive: 0,
      bestEdgeBps: Number.NEGATIVE_INFINITY,
      bestNaiveReverseEdgeBps: Number.NEGATIVE_INFINITY,
      bestRoute: "",
      symbols: new Set<string>(),
    };
    const edge = Number(opp.priceEdgeBps);
    const naiveReverseEdge = Number((opp.reverseMathHint || opp.priceVariance?.reverseMathHint)?.naiveReverseEdgeBps);
    group.routes += 1;
    group.direct += opp.routeOrientation === "AUTO_REVERSE" ? 0 : 1;
    group.reversed += opp.routeOrientation === "AUTO_REVERSE" ? 1 : 0;
    group.executable += opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE" ? 1 : 0;
    group.blocked += opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE" ? 0 : 1;
    group.naiveReversePositive += Number.isFinite(naiveReverseEdge) && naiveReverseEdge > 0 ? 1 : 0;
    if (Number.isFinite(edge) && edge > group.bestEdgeBps) {
      group.bestEdgeBps = edge;
      group.bestRoute = opp.routeId || opp.path || "";
    }
    if (Number.isFinite(naiveReverseEdge) && naiveReverseEdge > group.bestNaiveReverseEdgeBps) {
      group.bestNaiveReverseEdgeBps = naiveReverseEdge;
    }
    if (opp.flashloanSymbol) group.symbols.add(opp.flashloanSymbol);
    acc[key] = group;
    return acc;
  }, {} as Record<string, {
    key: string;
    routes: number;
    direct: number;
    reversed: number;
    executable: number;
    blocked: number;
    naiveReversePositive: number;
    bestEdgeBps: number;
    bestNaiveReverseEdgeBps: number;
    bestRoute: string;
    symbols: Set<string>;
  }>)).sort((left, right) => right.routes - left.routes);

  const compactVenue = (value: string) => value.split(":")[0] || value;
  const splitVenues = (value?: string) => (value || "").split("->").map((item) => item.trim()).filter(Boolean);
  const gateProgress = (opp: Opportunity) => {
    const net = Number(opp.netProfitUsd ?? opp.profit_usd ?? 0);
    if (opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE") return 100;
    if (net <= 0 || minProfitUsd <= 0) return 0;
    return Math.max(1, Math.min(99, Math.round((net / minProfitUsd) * 100)));
  };
  const gateLabel = (opp: Opportunity) => {
    const net = Number(opp.netProfitUsd ?? opp.profit_usd ?? 0);
    const gross = Number(opp.grossProfitUsd ?? 0);
    if (opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE") return "EXECUTABLE";
    if (net > 0) return "BELOW FLOOR";
    if (gross > 0) return "GAS BLOCKED";
    return "NO PROFIT";
  };

  // Background grid animation logic could be added here
  
  return (
    <div className="relative w-full h-full min-h-[400px] bg-[#050505] overflow-hidden rounded-xl border border-cyan-500/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),inset_0_0_32px_rgba(0,0,0,0.38),0_0_40px_rgba(0,255,255,0.05)] glass-specular p-6 font-mono">
      {/* Immersive Background Effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-30" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_50%,#000_70%,transparent_100%)]" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-cyan-900/10 blur-[100px] rounded-full mix-blend-screen" />
      </div>

      <div className="relative z-10 flex flex-col h-full">
        {/* Header Section */}
        <div className="flex items-center justify-between mb-8 pb-4 border-b border-cyan-500/20">
          <div className="flex items-center gap-4">
            <div className="relative flex items-center justify-center w-12 h-12 bg-cyan-950/50 rounded-lg border border-cyan-500/40 shadow-[0_0_15px_rgba(0,255,255,0.2)] overflow-hidden">
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 border-t-2 border-cyan-400 rounded-full opacity-50 m-1"
              />
              <Zap className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-400">
                HYPER IMMERSIVE 2.0
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <span className={`w-2 h-2 rounded-full ${connectionStatus === "live" ? "bg-cyan-400" : "bg-red-500"} animate-pulse`} />
                <span className={`text-xs tracking-widest uppercase ${connectionStatus === "live" ? "text-cyan-500/70" : "text-red-400/80"}`}>
                  {connectionStatus === "live" ? "Nexus Detection Matrix active" : "API feed not synchronized"}
                </span>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col items-end">
            <span className="text-4xl font-bold tracking-tighter text-cyan-400 drop-shadow-[0_0_10px_rgba(0,255,255,0.4)]">
              {opportunities.length.toString().padStart(2, '0')}
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-gray-500">
              Live Vectors
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5 text-[10px] uppercase tracking-wider">
          <div className="border border-cyan-500/15 bg-black/30 rounded-md px-3 py-2">
            <span className="block text-gray-600">Total Routes</span>
            <span className="text-cyan-300 font-bold">{totalRoutes}</span>
          </div>
          <div className="border border-cyan-500/15 bg-black/30 rounded-md px-3 py-2">
            <span className="block text-gray-600">Top Routes</span>
            <span className="text-cyan-300 font-bold">{visibleRoutes}/{topRouteLimit}</span>
          </div>
          <div className="border border-cyan-500/15 bg-black/30 rounded-md px-3 py-2">
            <span className="block text-gray-600">C1 Exec Top</span>
            <span className="text-emerald-300 font-bold">{c1ExecutableVisible}/{c1Limit}</span>
          </div>
          <div className="border border-cyan-500/15 bg-black/30 rounded-md px-3 py-2">
            <span className="block text-gray-600">C2 {c1Limit}x{c2PerC1Limit}</span>
            <span className="text-yellow-300 font-bold">{c2DecisionCount}/{c2Limit}</span>
          </div>
        </div>

        {graphGroups.length > 0 && (
          <div className="mb-5 border border-cyan-500/15 bg-black/25 rounded-md p-3">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300 font-bold">Real-Time Discovery Graph</div>
                <div className="text-[9px] uppercase tracking-wider text-gray-600 mt-1">Grouped by like asset class; routes only execute when buy [leg1] is below sell [leg2]</div>
              </div>
              <div className="text-[9px] uppercase tracking-wider text-gray-500">
                {graphGroups.length} groups
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
              {graphGroups.map((group) => {
                const bestEdge = Number.isFinite(group.bestEdgeBps) ? group.bestEdgeBps : undefined;
                const bestNaiveReverseEdge = Number.isFinite(group.bestNaiveReverseEdgeBps) ? group.bestNaiveReverseEdgeBps : undefined;
                return (
                  <div key={group.key} className="border border-[#1e2025] bg-[#08090d]/80 rounded px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-white font-bold">{group.key}</div>
                        <div className="text-[8px] uppercase tracking-wider text-gray-600 mt-1">
                          {Array.from(group.symbols).join(" / ") || "unlabeled"}
                        </div>
                      </div>
                      <div className={`text-[10px] font-bold ${group.executable > 0 ? "text-emerald-300" : "text-red-300"}`}>
                        {group.executable}/{group.routes}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-3 text-[8px] uppercase tracking-wider">
                      <div>
                        <span className="block text-gray-600">Direct</span>
                        <span className="text-cyan-300">{group.direct}</span>
                      </div>
                      <div>
                        <span className="block text-gray-600">Reverse</span>
                        <span className="text-yellow-300">{group.reversed}</span>
                      </div>
                      <div>
                        <span className="block text-gray-600">Blocked</span>
                        <span className="text-red-300">{group.blocked}</span>
                      </div>
                      <div>
                        <span className="block text-gray-600">Naive Rev+</span>
                        <span className="text-yellow-300">{group.naiveReversePositive}</span>
                      </div>
                    </div>
                    <div className="mt-3 text-[8px] uppercase tracking-wider">
                      <span className="text-gray-600">Best Edge </span>
                      <span className={(bestEdge ?? 0) > 0 ? "text-emerald-300" : "text-red-300"}>
                        {bestEdge === undefined ? "--" : `${bestEdge.toFixed(2)} bps`}
                      </span>
                      {group.bestRoute && <span className="text-gray-600"> / {group.bestRoute}</span>}
                    </div>
                    <div className="mt-1 text-[8px] uppercase tracking-wider">
                      <span className="text-gray-600">Naive Reverse </span>
                      <span className={(bestNaiveReverseEdge ?? 0) > 0 ? "text-yellow-300" : "text-gray-600"}>
                        {bestNaiveReverseEdge === undefined ? "--" : `${bestNaiveReverseEdge.toFixed(2)} bps`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Opportunity Grid */}
        <div className="flex-1 overflow-y-auto pr-2 scrollbar-none">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
            <AnimatePresence>
              {opportunities.map((opp, idx) => {
                const venues = splitVenues(opp.venues);
                const firstVenue = venues[0] ? compactVenue(venues[0]) : opp.dex_a;
                const lastVenue = venues.length > 1 ? compactVenue(venues[venues.length - 1]) : opp.dex_b;
                const executable = Boolean(opp.c1ExecutionEligible || opp.status === "EXECUTABLE_PROFIT_CANDIDATE");
                const netProfit = Number(opp.netProfitUsd ?? opp.profit_usd ?? 0);
                const grossProfit = Number(opp.grossProfitUsd ?? 0);
                const progress = gateProgress(opp);
                const tone = executable
                  ? "text-emerald-300"
                  : netProfit > 0
                    ? "text-yellow-300"
                    : grossProfit > 0
                      ? "text-amber-300"
                      : "text-red-300";
                const barTone = executable
                  ? "from-emerald-600 to-emerald-300"
                  : netProfit > 0
                    ? "from-yellow-600 to-yellow-300"
                    : grossProfit > 0
                      ? "from-amber-600 to-amber-300"
                      : "from-red-700 to-red-400";
                return (
                <motion.div
                  key={`${opp.routeId || opp.pair}-${idx}`}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.4, delay: idx * 0.05 }}
                  onMouseEnter={() => setActiveId(idx)}
                  onMouseLeave={() => setActiveId(null)}
                  className={`
                    relative group cursor-pointer overflow-hidden rounded-xl border transition-all duration-300
                    ${activeId === idx 
                      ? 'bg-cyan-950/40 border-cyan-400 shadow-[0_0_30px_rgba(0,255,255,0.15)] z-20' 
                      : 'bg-[#0a0a0c] border-[#1e2025] hover:border-cyan-500/50 hover:bg-[#0c0f12] z-10'}
                  `}
                >
                  {/* Card Glow Effect */}
                  <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  
                  <div className="p-5 flex flex-col h-full relative z-10">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="text-xs text-cyan-500 font-bold tracking-widest mb-1">{opp.routeId || opp.pair || opp.path || "ROUTE"}</div>
                        <div className={`text-[8px] font-bold tracking-widest mb-1 ${opp.routeOrientation === "AUTO_REVERSE" ? "text-yellow-300" : "text-gray-500"}`}>
                          {opp.routeOrientation === "AUTO_REVERSE" ? "AUTO-REVERSED ROUTE" : "DIRECT ROUTE"}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-gray-400 tracking-wider font-semibold">
                          <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{firstVenue || "SOURCE"}</span>
                          <ArrowRight className="w-3 h-3 text-cyan-500" />
                          <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{lastVenue || "RETURN"}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className={`text-lg font-bold leading-none ${tone}`}>
                          {formatUsd(opp.netProfitUsd ?? opp.profit_usd)}
                        </span>
                        <span className="text-[9px] text-gray-500 mt-1 uppercase tracking-wider">{opp.spread_bps ?? 0} BPS</span>
                        <span className={`text-[8px] mt-1 uppercase tracking-wider ${opp.c1ExecutionEligible ? "text-emerald-300" : "text-gray-500"}`}>
                          {opp.c1ExecutionEligible ? `C1 SLOT ${opp.c1ExecutionSlot}` : "LIST ONLY"}
                        </span>
                      </div>
                    </div>

                    <div className="mt-auto">
                      <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-semibold tracking-wider">
                        <span>NET GATE</span>
                        <span className={tone}>{gateLabel(opp)} {progress}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-gray-900 rounded-full overflow-hidden relative">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          transition={{ duration: 1, ease: "easeOut" }}
                          className={`absolute top-0 left-0 h-full bg-gradient-to-r ${barTone}`}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3 text-[9px] uppercase tracking-wider">
                      <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-1.5">
                        <span className="block text-gray-600">Gross</span>
                        <span className={grossProfit >= 0 ? "text-emerald-300" : "text-red-300"}>{formatUsd(opp.grossProfitUsd, 4)}</span>
                      </div>
                      <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-1.5">
                        <span className="block text-gray-600">Gas</span>
                        <span className="text-yellow-300">{formatUsd(opp.gasCostUsd, 4)}</span>
                      </div>
                      <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-1.5">
                        <span className="block text-gray-600">Fee</span>
                        <span className="text-gray-300">{formatUsd(opp.flashFeeUsd, 4)}</span>
                      </div>
                      <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-1.5">
                        <span className="block text-gray-600">TVL</span>
                        <span className="text-cyan-300">{formatUsd(opp.lowestPoolTvlUsd, 0)}</span>
                      </div>
                    </div>

                    {(opp.leg1BuyPrice || opp.leg2SellPrice || opp.priceEdgeBps !== undefined) && (
                      <div className="mt-2 border border-[#1e2025] bg-black/30 rounded px-2 py-2">
                        <div className="grid grid-cols-3 gap-2 text-[9px] uppercase tracking-wider">
                          <div>
                            <span className="block text-gray-600">Buy Price [Leg1]</span>
                            <span className="text-gray-200">{formatNumber(opp.leg1BuyPrice)}</span>
                          </div>
                          <div>
                            <span className="block text-gray-600">Sell Price [Leg2]</span>
                            <span className="text-gray-200">{formatNumber(opp.leg2SellPrice)}</span>
                          </div>
                          <div>
                            <span className="block text-gray-600">Variance Edge</span>
                            <span className={(opp.priceEdgeBps ?? 0) > 0 ? "text-emerald-300" : "text-red-300"}>
                              {formatNumber(opp.priceEdgeBps, 2)} bps
                            </span>
                          </div>
                        </div>
                        <div className={`mt-2 text-[8px] uppercase tracking-wider ${(opp.priceVariance?.ok ?? false) ? "text-emerald-300" : "text-red-300"}`}>
                          Rule: buy price [leg1] &lt; sell price [leg2]
                        </div>
                        {(() => {
                          const hint = opp.reverseMathHint || opp.priceVariance?.reverseMathHint;
                          return hint ? (
                            <div className="mt-2 border-t border-[#1e2025] pt-2 text-[8px] uppercase tracking-wider">
                              <div className="grid grid-cols-3 gap-2">
                                <div>
                                  <span className="block text-gray-600">Naive Rev Buy</span>
                                  <span className="text-yellow-200">{formatNumber(hint.buyLeg1IfReversed)}</span>
                                </div>
                                <div>
                                  <span className="block text-gray-600">Naive Rev Sell</span>
                                  <span className="text-yellow-200">{formatNumber(hint.sellLeg2IfReversed)}</span>
                                </div>
                                <div>
                                  <span className="block text-gray-600">Naive Rev Edge</span>
                                  <span className={(hint.naiveReverseEdgeBps ?? 0) > 0 ? "text-emerald-300" : "text-red-300"}>
                                    {formatNumber(hint.naiveReverseEdgeBps, 2)} bps
                                  </span>
                                </div>
                              </div>
                              <div className="mt-1 text-gray-500 normal-case tracking-normal leading-snug">
                                Live AUTO_REVERSE is re-quoted separately with pool fees, slippage, curve impact, gas, and flash fee.
                              </div>
                            </div>
                          ) : null;
                        })()}
                      </div>
                    )}

                    {(opp.path || opp.venues) && (
                      <div className="mt-3 text-[9px] text-gray-500 leading-relaxed break-words">
                        {opp.path && <div>{opp.path}</div>}
                        {opp.venues && <div className="text-gray-600">{opp.venues}</div>}
                      </div>
                    )}

                    {opp.reason && (
                      <div className="mt-3 text-[9px] text-yellow-300/80 leading-relaxed break-words">
                        {opp.reason}
                      </div>
                    )}

                    {/* Cyber Glitch Detail on Hover */}
                    <AnimatePresence>
                      {activeId === idx && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="pt-4 mt-4 border-t border-cyan-500/20 flex items-center justify-between"
                        >
                           <div className="flex items-center gap-1.5 text-[9px] text-cyan-300 tracking-widest">
                             <Activity className="w-3 h-3" />
                             <span>{opp.c1ExecutionEligible ? "SYNCED & EXEC SLOT" : gateLabel(opp)}</span>
                           </div>
                           <button className="px-3 py-1 bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-100 rounded text-[9px] tracking-widest transition-colors uppercase border border-cyan-500/30">
                             {opp.c1ExecutionEligible ? "Execute Vector" : "Gate Details"}
                           </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
                );
              })}
            </AnimatePresence>
            
            {opportunities.length === 0 && (
              <div className="col-span-full min-h-44 flex flex-col items-center justify-center border border-dashed border-[#1e2025] rounded-xl text-gray-500 px-4 text-center">
                <ShieldAlert className={`w-8 h-8 mb-3 opacity-70 ${statusTone}`} />
                <span className={`text-xs uppercase tracking-widest font-bold ${statusTone}`}>
                  {connectionStatus === "live" ? "No executable vectors" : "Opportunity API disconnected"}
                </span>
                <span className="text-[10px] mt-2 max-w-2xl leading-relaxed">
                  {statusText}
                </span>
                {connectionStatus === "live" && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 w-full max-w-2xl text-[9px] uppercase tracking-wider">
                    <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-2">
                      <span className="block text-gray-600">Ready Pools</span>
                      <span className="text-cyan-300 font-bold">{discovery.ready_pools ?? 0}</span>
                    </div>
                    <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-2">
                      <span className="block text-gray-600">Total Pools</span>
                      <span className="text-cyan-300 font-bold">{discovery.total_pools ?? 0}</span>
                    </div>
                    <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-2">
                      <span className="block text-gray-600">Top Routes</span>
                      <span className="text-cyan-300 font-bold">{discovery.cached_spreads ?? 0}</span>
                    </div>
                    <div className="border border-[#1e2025] bg-black/30 rounded px-2 py-2">
                      <span className="block text-gray-600">Reason</span>
                      <span className="text-yellow-300 font-bold normal-case tracking-normal">{discovery.summary || "No executable spread passed gates"}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
