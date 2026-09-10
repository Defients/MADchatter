import React, { useMemo } from "react";
import { parseEmotes, getCachedChannelEmotes, type TextSegment } from "../lib/emotes";
import { ThemedTooltip } from "./ui/tooltip";

interface EmoteTextProps {
  text: string;
  channel?: string;
  className?: string;
}

export function EmoteText({ text, channel, className }: EmoteTextProps) {
  const segments = useMemo<TextSegment[]>(() => {
    const emoteMap = channel ? getCachedChannelEmotes(channel) : null;
    return parseEmotes(text, emoteMap);
  }, [text, channel]);

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
