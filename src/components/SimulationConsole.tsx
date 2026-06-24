import React, { useState, useEffect } from "react";
import {
  Terminal,
  Database,
  Play,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";

export default function SimulationConsole() {
  const [simulations, setSimulations] = useState<any[]>([]);

  useEffect(() => {
    // Awaiting valid payload
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#07080a] border border-[#1e2025] rounded-sm font-mono text-[10px]">
      <div className="flex items-center justify-between p-2 border-b border-[#1e2025] bg-[#0d0e12]">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-cyan-400" />
          <h2 className="font-bold text-gray-300 uppercase tracking-wider">
            C1 Live Mainnet Execution Console
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[8px] text-gray-500 uppercase font-bold">
          <div className="flex items-center gap-1">
            <Database size={10} className="text-emerald-500" /> Active Mainnet Node
          </div>
        </div>
      </div>
      <div className="flex-1 p-2 overflow-y-auto space-y-1.5 custom-scrollbar bg-[#0b0c10]">
        {simulations.length === 0 ? (
          <div className="text-center text-gray-600 mt-4 uppercase animate-pulse">
            Waiting for live executions...
          </div>
        ) : (
          simulations.map((sim, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 p-1.5 border-l-2 ${sim.status === "VERIFIED" ? "border-emerald-500 bg-emerald-500/5" : "border-red-500 bg-red-500/5"}`}
            >
              <div className="text-gray-500 shrink-0">[{sim.time}]</div>
              <div className="flex-1 flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">
                    Target ID:{" "}
                    <span className="text-gray-300 select-all">{sim.id}</span>
                  </span>
                  <span className="text-gray-500">|</span>
                  <span className="text-cyan-400">{sim.route}</span>
                </div>
                <div className="flex items-center gap-4 text-[9px]">
                  <span className="text-emerald-400 font-bold">
                    +${sim.profit} Expected
                  </span>
                  <span className="text-gray-500">{sim.gasEst} gas</span>
                  {sim.status === "VERIFIED" ? (
                    <span className="text-emerald-500 flex items-center gap-1">
                      <CheckCircle2 size={10} /> {sim.status}
                    </span>
                  ) : (
                    <span className="text-red-500 flex items-center gap-1">
                      <AlertCircle size={10} /> {sim.status}
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 pt-0.5">
                {sim.status === "VERIFIED" ? (
                  <button className="flex items-center gap-1 px-2 py-0.5 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 rounded-sm uppercase tracking-wider text-[8px] transition-colors cursor-pointer">
                    <Play size={8} /> Execute
                  </button>
                ) : (
                  <span className="px-2 py-0.5 border border-red-500/30 text-red-500 bg-red-500/10 rounded-sm uppercase tracking-wider text-[8px]">
                    Discarded
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
