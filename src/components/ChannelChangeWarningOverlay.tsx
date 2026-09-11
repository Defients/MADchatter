import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, Download, FileJson, X, Loader2 } from "lucide-react";
import type { ChannelExportWorthwhile, ChannelExportResult } from "../lib/exportChannelData";

interface ChannelChangeWarningOverlayProps {
  open: boolean;
  newChannel: string;
  oldChannel: string;
  worthwhile: ChannelExportWorthwhile;
  onExportAndContinue: () => Promise<ChannelExportResult>;
  onContinueWithoutExport: () => void;
  onCancel: () => void;
}

interface SourceRow {
  key: keyof ChannelExportWorthwhile;
  label: string;
  icon: typeof FileJson;
  persists: boolean;
}

const SOURCES: SourceRow[] = [
  { key: "autoForgeReport", label: "AutoForge Report", icon: FileJson, persists: true },
  { key: "autoMemory", label: "Auto-Memory System", icon: FileJson, persists: true },
  { key: "longTermMemory", label: "Long-Term Memory", icon: FileJson, persists: false },
];

export function ChannelChangeWarningOverlay({
  open,
  newChannel,
  oldChannel,
  worthwhile,
  onExportAndContinue,
  onContinueWithoutExport,
  onCancel,
}: ChannelChangeWarningOverlayProps) {
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await onExportAndContinue();
    } finally {
      setExporting(false);
    }
  };

  const activeSources = SOURCES.filter((s) => worthwhile[s.key]);
  const anyPersists = activeSources.some((s) => s.persists);
  const anyCleared = activeSources.some((s) => !s.persists);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/85 backdrop-blur-lg overflow-y-auto py-8"
          onClick={(e) => {
            if (e.target === e.currentTarget && !exporting) onCancel();
          }}
        >
          <motion.div
            initial={{ scale: 0.92, y: 30 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.92, y: 30 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-lg mx-4 bg-gradient-to-b from-[#141419] to-[#0a0a0f] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            {/* Top accent bar */}
            <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-amber-500 to-red-500" />

            {/* Close button */}
            <button
              type="button"
              onClick={onCancel}
              disabled={exporting}
              className="absolute top-3 right-3 p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Cancel channel change"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="p-7">
              {/* Header */}
              <div className="flex items-start gap-3 mb-5">
                <div className="shrink-0 w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold text-white mb-1">Switching channels</h2>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    You're about to switch from{" "}
                    <span className="text-orange-400 font-semibold">@{oldChannel || "—"}</span> to{" "}
                    <span className="text-orange-400 font-semibold">@{newChannel}</span>. Some
                    channel-specific data will be cleared.
                  </p>
                </div>
              </div>

              {/* Source list */}
              <div className="space-y-2 mb-5">
                <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
                  Exportable data
                </p>
                {activeSources.map((source) => {
                  const Icon = source.icon;
                  return (
                    <div
                      key={source.key}
                      className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5"
                    >
                      <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-200 font-medium">{source.label}</p>
                        <p className="text-[10px] text-gray-500">
                          {source.persists
                            ? "Persists across channels — export for archival"
                            : "Will be cleared — export to preserve"}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                          source.persists
                            ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                            : "bg-red-500/10 text-red-400 border border-red-500/20"
                        }`}
                      >
                        {source.persists ? "Persists" : "Cleared"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Clarification note */}
              {anyPersists && anyCleared && (
                <p className="text-[11px] text-gray-500 leading-relaxed mb-5 bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2">
                  Only <span className="text-red-400 font-medium">Long-Term Memory</span> is cleared
                  on channel switch. <span className="text-blue-400 font-medium">AutoForge Report</span>{" "}
                  and <span className="text-blue-400 font-medium">Auto-Memory</span> persist but may be
                  channel-specific — exporting gives you a per-channel snapshot.
                </p>
              )}

              {/* Actions */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exporting}
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-semibold text-sm transition-all shadow-[0_4px_20px_rgba(249,115,22,0.25)] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {exporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Export & Continue
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={onContinueWithoutExport}
                  disabled={exporting}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-gray-300 font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue without exporting
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={exporting}
                  className="w-full px-4 py-2 rounded-xl text-gray-500 hover:text-gray-300 font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
