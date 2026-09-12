/**
 * Director Note shared primitives.
 *
 * Used by both the multi-bot DirectorNoteInput (MultiBotPanel.tsx) and the
 * single-bot SingleBotDirectorNoteInput (AutoForgeHUD.tsx). Keeping these
 * in one place ensures duration options, expiry formatting, and chip
 * styling stay consistent across both modes.
 */

import { Clock, XCircle, GripVertical } from "lucide-react";

/** Duration options for timed director notes. `null` = until manually canceled. */
export const DIRECTOR_NOTE_DURATIONS: { label: string; ms: number | null }[] = [
  { label: "Until canceled", ms: null },
  { label: "5 min", ms: 5 * 60_000 },
  { label: "15 min", ms: 15 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
];

/** Human-readable remaining time for a note's expiry. */
export function formatNoteExpiry(expiresAt: number | null | undefined): string {
  if (expiresAt == null) return "until canceled";
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "expired";
  const mins = Math.ceil(remaining / 60_000);
  if (mins < 60) return `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m left`;
}

/** Build the event-log summary string for a newly added director note. */
export function directorNoteSummary(message: string, durationMs: number | null): string {
  const truncated = message.substring(0, 80) + (message.length > 80 ? "..." : "");
  const expiry = durationMs ? ` (${formatNoteExpiry(Date.now() + durationMs)})` : "";
  return `Director note: "${truncated}"${expiry}`;
}

/** Priority badge color for a note's position in the list.
 *  Position 0 = PRIORITY 1 (highest), 1 = PRIORITY 2, 2 = PRIORITY 3,
 *  3+ = STANDARD. */
export function priorityBadge(index: number): { label: string; className: string } | null {
  if (index === 0) return { label: "1", className: "bg-pink-500/30 text-pink-300 border-pink-500/40" };
  if (index === 1) return { label: "2", className: "bg-purple-500/30 text-purple-300 border-purple-500/40" };
  if (index === 2) return { label: "3", className: "bg-indigo-500/30 text-indigo-300 border-indigo-500/40" };
  return null; // STANDARD — no badge
}

/** A single dismissible director note chip. */
export function DirectorNoteChip({
  text,
  expiresAt,
  scopeLabel,
  onRemove,
  removeTitle,
  priority,
  draggable,
}: {
  text: string;
  expiresAt: number | null;
  scopeLabel?: string;
  onRemove: () => void;
  removeTitle?: string;
  /** Priority badge (1, 2, or 3). Omit for STANDARD priority. */
  priority?: { label: string; className: string } | null;
  /** Show a drag handle grip icon (when inside a Reorder.Item). */
  draggable?: boolean;
}) {
  return (
    <div className="flex items-start gap-1.5 bg-purple-950/30 border border-purple-500/20 rounded px-1.5 py-1">
      {draggable && <GripVertical className="w-2.5 h-2.5 text-gray-600 shrink-0 mt-0.5 cursor-grab active:cursor-grabbing" />}
      {priority && (
        <span className={`shrink-0 mt-0.5 text-[8px] font-bold border rounded px-1 py-0.5 leading-none ${priority.className}`}>
          {priority.label}
        </span>
      )}
      <Clock className="w-2.5 h-2.5 text-purple-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-gray-300 leading-snug truncate">{text}</div>
        <div className="text-[8px] text-gray-500 mt-0.5">
          {scopeLabel ? `${scopeLabel} · ` : ""}{formatNoteExpiry(expiresAt)}
        </div>
      </div>
      <button
        onClick={onRemove}
        className="shrink-0 text-gray-500 hover:text-red-400 transition-colors p-0.5"
        title={removeTitle ?? "Cancel this note"}
      >
        <XCircle className="w-3 h-3" />
      </button>
    </div>
  );
}
