import React, { useMemo } from "react";
import { parseEmotes, parseTwitchEmotes, getCachedChannelEmotes, type TextSegment } from "../lib/emotes";
import { ThemedTooltip } from "./ui/tooltip";

interface EmoteTextProps {
  text: string;
  channel?: string;
  className?: string;
  /** Twitch native emotes from IRC tags: emoteId → array of [start, end] ranges. */
  twitchEmotes?: Record<string, number[][]>;
}

export function EmoteText({ text, channel, className, twitchEmotes }: EmoteTextProps) {
  const segments = useMemo<TextSegment[]>(() => {
    // Twitch native emotes (from IRC tags) take priority — they're exact
    // character ranges, not name-matching heuristics.
    if (twitchEmotes && Object.keys(twitchEmotes).length > 0) {
      return parseTwitchEmotes(text, twitchEmotes);
    }
    const emoteMap = channel ? getCachedChannelEmotes(channel) : null;
    return parseEmotes(text, emoteMap);
  }, [text, channel, twitchEmotes]);

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return <React.Fragment key={i}>{seg.content}</React.Fragment>;
        }
        return (
          <ThemedTooltip content={seg.name}>
            <img
              key={i}
              src={seg.url}
              alt={seg.name}
              className="inline-block align-middle mx-0.5 object-contain"
              style={{ height: "20px", width: "auto", maxHeight: "24px" }}
              loading="lazy"
            />
          </ThemedTooltip>
        );
      })}
    </span>
  );
}
