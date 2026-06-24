import React from "react";

interface Opportunity {
  pair: string;
  profit_usd: number;
  spread_bps: number;
  chain_id: number;
}

interface TickerProps {
  opportunities: Opportunity[];
}

export default function Ticker({ opportunities }: TickerProps) {
  const currentOpps = opportunities.length
    ? opportunities
    : [
        {
          pair: "AWAITING/MUTATIVE_FEEDS",
          profit_usd: 0,
          spread_bps: 0,
          chain_id: 137,
        },
      ];

  // Double the list to support perfect loop coverage
  const loopList = [...currentOpps, ...currentOpps, ...currentOpps];

  return (
    <div className="h-4 min-h-[16px] bg-black/50 border-b border-[#1e2025]/50 flex items-center overflow-hidden shrink-0 select-none font-mono text-[7px]">
      <div className="flex whitespace-nowrap animate-ticker whitespace-nowrap gap-8 py-0.5">
        {loopList.map((opp, idx) => {
          const chainName =
            opp.chain_id === 137
              ? "CHAIN 137"
              : opp.chain_id === 1
                ? "ETH"
                : "L2";
          const chainColor =
            opp.chain_id === 137 ? "text-[#b388ff]" : "text-cyan-400";
          const spreadPct = (opp.spread_bps / 100).toFixed(3);

          return (
            <div
              key={idx}
              className="inline-flex items-center gap-2 text-gray-400"
            >
              <span className="text-[#00e5ff] font-bold tracking-wider">
                {opp.pair}
              </span>
              <span className="w-1 h-1 bg-[#1e2025] rounded-full shrink-0" />
              <span className="text-[#00f5a0] font-semibold">
                {(opp.profit_usd || 0) > 0 ? `+${spreadPct}%` : "WATCHING"}
              </span>
              <span className="w-1 h-1 bg-[#1e2025] rounded-full shrink-0" />
              <span className="text-[#ffc840] font-bold">
                ${opp.profit_usd?.toFixed(2)} USD
              </span>
              <span className="w-1 h-1 bg-[#1e2025] rounded-full shrink-0" />
              <span className={`${chainColor} font-bold text-[7.5px]`}>
                {chainName}
              </span>
              <span className="text-[#1e2025] font-extrabold px-1">|</span>
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes ticker-slide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-33.33%); }
        }
        .animate-ticker {
          animation: ticker-slide 28s linear infinite;
        }
        .animate-ticker:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}
