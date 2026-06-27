import React, { useState, useEffect } from "react";
import {
  Sliders,
  Save,
  ShieldAlert,
  Cpu,
  Network,
  Check,
  Key,
} from "lucide-react";

interface ConfigTabProps {
  addLog?: (
    tag: "C1" | "C2" | "DEX" | "SYS" | "ERR" | "AAVE" | "ARB",
    msg: string,
  ) => void;
  setConfigChanged?: () => void;
}

export default function ConfigTab({ addLog, setConfigChanged }: ConfigTabProps) {
  const [cfg, setCfg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<
    "flags" | "wallets" | "rpcs" | "subgraphs"
  >("flags");

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setCfg(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load config:", err);
        setLoading(false);
      });
  }, []);

  const handleInputChange = (key: string, value: any) => {
    setCfg((prev: any) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });

      if (res.ok) {
        const saved = await res.json();
        if (saved.config) setCfg(saved.config);
        if (addLog) addLog(
          "SYS",
          `User updated core system configurations. Persisted to ${saved.path || "config.json"}.`,
        );
        if (setConfigChanged) setConfigChanged();
        
        setSaveStatus("SUCCESSFULLY_SAVED");
        setTimeout(() => setSaveStatus(null), 3000);
      } else {
        setSaveStatus("SAVE_FAILED");
      }
    } catch (err) {
      console.error(err);
      setSaveStatus("SAVE_FAILED");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-500 font-mono text-[10px]">
        <span className="animate-spin border-2 border-t-transparent border-cyan-400 w-4 h-4 rounded-full mr-2" />
        Sourcing core system configuration registers...
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="font-mono text-[10px] space-y-4">
      <div className="bg-[#0d0e12]/80 border border-[#1e2025] rounded-sm p-4 relative flex flex-col glass-specular glass-inset">
        {/* Abstract futuristic corner accents */}
        <div className="absolute top-0 right-0 w-2.5 h-2.5 border-t border-r border-[#00e5ff]/40" />
        <div className="absolute bottom-0 left-0 w-2.5 h-2.5 border-b border-l border-[#00e5ff]/40" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-[#1e2025]/60 pb-3 mb-3">
          <div className="flex items-center gap-2">
            <Sliders size={13} className="text-[#00e5ff]" />
            <div>
              <h3 className="uppercase tracking-[0.15em] font-bold text-white text-[10px]">
                APEX CORE REGISTER MANAGER
              </h3>
              <p className="text-[7.5px] text-gray-500 uppercase font-bold leading-normal">
                Synchronized live to config.json
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 text-cyan-400 border border-cyan-500/30 rounded-sm font-bold uppercase transition-all shadow-[0_0_8px_rgba(0,229,255,0.05)] cursor-pointer text-[8.5px]"
          >
            {saving ? (
              <span className="w-2.5 h-2.5 border border-t-transparent border-cyan-400 rounded-full animate-spin" />
            ) : saveStatus === "SUCCESSFULLY_SAVED" ? (
              <Check size={11} className="text-emerald-400" />
            ) : (
              <Save size={11} />
            )}
            <span>
              {saving
                ? "Writing registers..."
                : saveStatus === "SUCCESSFULLY_SAVED"
                  ? "Regs synched"
                  : "Write changes"}
            </span>
          </button>
        </div>

        {/* Section Navigation */}
        <div className="flex border-b border-[#1e2025]/40 mb-3 overflow-x-auto pb-1 gap-1">
          {[
            { id: "flags", label: "EXECUTION FLAGS", icon: ShieldAlert },
            { id: "wallets", label: "WALLETS & SIGNERS", icon: Key },
            { id: "rpcs", label: "RPC NETWORK LANES", icon: Network },
            { id: "subgraphs", label: "SUBGRAPH FILTERS", icon: Cpu },
          ].map((sec) => {
            const Icon = sec.icon;
            const active = activeSection === sec.id;
            return (
              <button
                type="button"
                key={sec.id}
                onClick={() => setActiveSection(sec.id as any)}
                className={`flex items-center gap-1 px-2.5 py-1 text-[8px] font-bold uppercase transition-all rounded-sm border ${
                  active
                    ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                <Icon size={10} />
                <span>{sec.label}</span>
              </button>
            );
          })}
        </div>

        {/* Dynamic section display */}
        <div className="space-y-3 min-h-[220px]">
          {activeSection === "flags" && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Checkboxes */}
                {[
                  {
                    key: "LIVE_EXECUTION",
                    label: "Live Core Execution Enabled",
                    desc: "Allows actual transaction submission to Polygon Mainnet Router",
                  },
                  {
                    key: "SHADOW_MODE",
                    label: "Live Mainnet Monitoring Phase",
                    desc: "Passively monitors mainnet states without executing",
                  },
                  {
                    key: "REQUIRE_FORK_SIM_BEFORE_SUBMIT",
                    label: "Force Live Network State Check",
                    desc: "Requires MEV network query validation before route broadcast",
                  },
                  {
                    key: "REQUIRE_CHAIN_ID_MATCH",
                    label: "Strict Net Chain ID Check",
                    desc: "Aborts trade if RPC returns alternate chain sequence",
                  },
                  {
                    key: "REQUIRE_NONCE_LOCK",
                    label: "Thread Safety Nonce Lock",
                    desc: "Prevents race conditions by locking thread nonce index",
                  },
                  {
                    key: "REQUIRE_GAS_CAP",
                    label: "Dynamic gas ceiling Cap",
                    desc: "Calculates active gas fee threshold based on current base fee",
                  },
                  {
                    key: "REQUIRE_PROFIT_PROTECTION",
                    label: "Minimum Profit gate policy",
                    desc: "Cancels execution bundles if output is below minimum fee gate",
                  },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="flex items-start gap-2.5 p-2 border border-[#1e2025]/40 bg-black/10 hover:bg-black/30 transition-all rounded-sm"
                  >
                    <input
                      type="checkbox"
                      id={`flag-${item.key}`}
                      checked={!!cfg[item.key]}
                      onChange={(e) =>
                        handleInputChange(item.key, e.target.checked)
                      }
                      className="mt-0.5 rounded border-[#1e2025] bg-black text-cyan-400 focus:ring-cyan-400"
                    />
                    <div className="space-y-0.5">
                      <label
                        htmlFor={`flag-${item.key}`}
                        className="font-bold text-white cursor-pointer hover:text-cyan-400 select-none"
                      >
                        {item.key}
                      </label>
                      <p className="text-[7.5px] text-gray-500 leading-tight">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                ))}

                {/* Dropdown mode choice */}
                <div className="p-2 border border-[#1e2025]/40 bg-black/10 rounded-sm">
                  <label className="block text-gray-400 font-bold mb-1 uppercase text-[7.5px]">
                    EXECUTION_MODE
                  </label>
                  <select
                    value={cfg.EXECUTION_MODE || ""}
                    onChange={(e) =>
                      handleInputChange("EXECUTION_MODE", e.target.value)
                    }
                    className="w-full bg-black border border-[#1e2025] p-2 text-white font-mono font-bold outline-none rounded-sm focus:border-cyan-400"
                  >
                    <option value="PRIVATE_FIRST">
                      PRIVATE_FIRST (Protect MEV)
                    </option>
                    <option value="PUBLIC_BROADCAST">
                      PUBLIC_BROADCAST (Fastest Muted)
                    </option>
                    <option value="MEMPOOL_FRONT">
                      MEMPOOL_FRONT (Pre-simulate)
                    </option>
                  </select>
                  <p className="text-[7px] text-gray-500 mt-1 uppercase">
                    Dictates mempool routing configuration
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeSection === "wallets" && (
            <div className="space-y-2.5">
              <span className="text-gray-500 block text-[7.5px] font-bold uppercase leading-none pb-1">
                MEV SIGNING HASHES & TARGET CONTRACT ADDRS
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {[
                  {
                    key: "EXECUTOR_WALLET",
                    label: "Primary Executor Signer Wallet",
                  },
                  {
                    key: "C1_ARB_EXECUTOR_ADDRESS",
                    label: "C1 Arbitrage Smart Contract",
                  },
                  {
                    key: "C2_ARB_EXECUTOR_ADDRESS",
                    label: "C2 Arbitrage Smart Contract",
                  },
                  { key: "C1_TARGET", label: "C1 Entry target proxy" },
                  { key: "C2_TARGET", label: "C2 Entry target proxy" },
                  {
                    key: "LIQUIDATION_EXECUTOR_ADDRESS",
                    label: "Aave V3 Liquidation multicall contract",
                  },
                  {
                    key: "DEPLOYER_WALLET",
                    label: "Deployer master signature index",
                  },
                  {
                    key: "BOT_PROFIT_RECEIVER",
                    label: "Bot profit recipient vault",
                  },
                ].map((item) => (
                  <div key={item.key} className="space-y-1">
                    <label className="text-gray-400 block font-bold text-[7.5px] tracking-wide uppercase leading-none">
                      {item.key}
                    </label>
                    <input
                      type="text"
                      value={cfg[item.key] || ""}
                      onChange={(e) =>
                        handleInputChange(item.key, e.target.value)
                      }
                      className="w-full bg-black/60 border border-[#1e2025] p-1.5 text-white font-mono outline-none rounded-sm focus:border-cyan-400 text-[9px]"
                      placeholder="0x..."
                    />
                    <p className="text-[6.5px] text-gray-500 uppercase leading-none">
                      {item.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === "rpcs" && (
            <div className="space-y-2.5">
              <span className="text-gray-500 block text-[7.5px] font-bold uppercase leading-none pb-1">
                ACTIVE COGNIZANT RPC LANES (POLYGON CORE FEEDERS)
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {[
                  {
                    key: "POLYGON_RPC_URL",
                    label: "Primary DRPC Gateway HTTP",
                  },
                  { key: "POLYGON_RPC", label: "Primary DRPC Mirror Endpoint" },
                  {
                    key: "POLYGON_HTTP",
                    label: "High Performance Managed RPC HTTP",
                  },
                  {
                    key: "ALCHEMY_HTTP_1",
                    label: "Alchemy Primary Backup Service",
                  },
                  {
                    key: "ALCHEMY_HTTP_2",
                    label: "Alchemy Secondary Backup Service",
                  },
                  { key: "INFURA_HTTP", label: "Infura Cloud Core Router" },
                  {
                    key: "INFURA_WSS",
                    label: "Infura Websocket Node endpoint",
                  },
                  {
                    key: "CHAINSTACK_HTTP",
                    label: "Chainstack High Latency Sync Feed",
                  },
                  { key: "ANKR_HTTP", label: "Ankr Consensus Cluster gateway" },
                  { key: "DRPC_HTTP", label: "dRPC Network Direct HTTP API" },
                  {
                    key: "PUBLIC_1RPC",
                    label: "1rpc Decentralised Private network",
                  },
                  {
                    key: "PUBLIC_LLAMA",
                    label: "Llama Node high performance community feed",
                  },
                  {
                    key: "PUBLIC_POLYGON_RPC",
                    label: "Polygon Network public backup server",
                  },
                ].map((item) => (
                  <div key={item.key} className="space-y-1">
                    <label className="text-gray-400 block font-bold text-[7.5px] tracking-wide uppercase leading-none">
                      {item.key}
                    </label>
                    <input
                      type="text"
                      value={cfg[item.key] || ""}
                      onChange={(e) =>
                        handleInputChange(item.key, e.target.value)
                      }
                      className="w-full bg-black/60 border border-[#1e2025] p-1.5 text-white font-mono outline-none rounded-sm focus:border-cyan-400 text-[9px]"
                      placeholder="https://..."
                    />
                    <p className="text-[6.5px] text-gray-500 uppercase leading-none">
                      {item.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === "subgraphs" && (
            <div className="space-y-2.5">
              <span className="text-gray-500 block text-[7.5px] font-bold uppercase leading-none pb-1">
                THEGRAPH API KEY SYNC & FACTORY SCANNERS
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {[
                  {
                    key: "POLYGON_GAS_STATION_URL",
                    label: "Gas station pricing feed endpoint",
                  },
                  {
                    key: "QUICKSWAP_V3_SUBGRAPH_URL",
                    label: "Quickswap V3 Subgraph node target",
                  },
                  {
                    key: "UNISWAP_V3_POLYGON_SUBGRAPH_URL",
                    label: "Uniswap V3 Polygon subgraph endpoint",
                  },
                  {
                    key: "MAX_ACTIVE_POOL_MATRIX_SIZE",
                    label: "Allowed in-memory pools limit size",
                    type: "number",
                  },
                  {
                    key: "V3_SUBGRAPH_POOL_LIMIT",
                    label: "Direct query nodes volume capacity",
                    type: "number",
                  },
                ].map((item) => (
                  <div key={item.key} className="space-y-1">
                    <label className="text-gray-400 block font-bold text-[7.5px] tracking-wide uppercase leading-none">
                      {item.key}
                    </label>
                    <input
                      type={item.type === "number" ? "number" : "text"}
                      value={cfg[item.key] || ""}
                      onChange={(e) =>
                        handleInputChange(
                          item.key,
                          item.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                        )
                      }
                      className="w-full bg-black/60 border border-[#1e2025] p-1.5 text-white font-mono outline-none rounded-sm focus:border-cyan-400 text-[9px]"
                    />
                    <p className="text-[6.5px] text-gray-500 uppercase leading-none">
                      {item.label}
                    </p>
                  </div>
                ))}

                {[
                  {
                    key: "FACTORY_SYNC_USE_V3_SUBGRAPHS",
                    label: "Enable Graph synchronization query structure",
                  },
                  {
                    key: "FACTORY_SYNC_SUBGRAPH_ONLY",
                    label: "Force sync exclusively from external endpoints",
                  },
                  {
                    key: "DIRECT_ONCHAIN_REGISTRY_SYNC",
                    label: "Verify pool registry via multi-venue contracts",
                  },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="flex items-start gap-2 p-2 border border-[#1e2025]/40 bg-black/10 rounded-sm"
                  >
                    <input
                      type="checkbox"
                      id={`flag-${item.key}`}
                      checked={
                        cfg[item.key] === true ||
                        String(cfg[item.key]) === "true"
                      }
                      onChange={(e) =>
                        handleInputChange(item.key, e.target.checked)
                      }
                      className="mt-0.5 rounded border-[#1e2025] bg-black text-cyan-400 focus:ring-cyan-400"
                    />
                    <div className="space-y-0.5">
                      <label
                        htmlFor={`flag-${item.key}`}
                        className="font-bold text-white cursor-pointer select-none"
                      >
                        {item.key}
                      </label>
                      <p className="text-[6.5px] text-gray-500 leading-normal uppercase">
                        {item.label}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {saveStatus && (
          <div
            className={`mt-3 p-2 font-mono text-[8px] font-bold tracking-widest uppercase border rounded-sm text-center animate-pulse ${
              saveStatus === "SUCCESSFULLY_SAVED"
                ? "bg-emerald-500/10 border-emerald-500/30 text-[#00f5a0]"
                : "bg-red-500/10 border-red-500/30 text-red-400"
            }`}
          >
            {saveStatus === "SUCCESSFULLY_SAVED"
              ? "✓ SUCCESS: core system parameters synchronized to config.json"
              : "❌ ERROR: Failed to write parameters to system registry file"}
          </div>
        )}
      </div>
    </form>
  );
}
