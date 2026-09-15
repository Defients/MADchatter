/**
 * UserAvatar — shared primitive for the logged-in platform user's identity icon.
 *
 * Shows the user's platform profile image when one is available, then falls
 * back to a platform-branded letter avatar (first letter of the display name)
 * when it isn't. `fallbackSrc` lets a caller substitute a platform logo image
 * instead of the letter avatar (the Studio header uses the Twitch glitch logo).
 *
 * Consumed by every header login display so the user's icon renders
 * consistently across Core (desktop/mobile) and Studio (desktop/mobile).
 */

import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

/** Minimal user shape satisfied by every auth hook's `user` object. */
export type HeaderUser = {
  display_name?: string;
  login?: string;
  username?: string;
  profile_image_url?: string;
};

/** Platform accent colors — match the platform tab / login pill accents. */
const PLATFORM_ACCENT: Record<string, string> = {
  twitch: "#9146FF",
  kick: "#53fc18",
  joystick: "#FF6B35",
};

/** Resolve the user's display name exactly the way every header login does. */
export function userDisplayName(user: HeaderUser | null | undefined): string {
  return user?.display_name || user?.login || user?.username || "";
}

export function UserAvatar({
  user,
  platform,
  sizeClass,
  textClass = "text-[10px]",
  fallbackSrc,
  className,
}: {
  user: HeaderUser | null | undefined;
  platform: string;
  /** Tailwind sizing classes, e.g. "h-5 w-5" or "h-[28px] w-[28px]". */
  sizeClass: string;
  /** Font size for the letter fallback (letter fallback only). */
  textClass?: string;
  /** Image used when the user has no profile image (e.g. the Twitch glitch logo). */
  fallbackSrc?: string;
  className?: string;
}) {
  const name = userDisplayName(user);
  const accent = PLATFORM_ACCENT[platform] ?? PLATFORM_ACCENT.twitch;
  const url = user?.profile_image_url?.trim() || "";
  const [imgFailed, setImgFailed] = useState(false);

  // Reset the broken-image fallback when the source changes (account switch).
  useEffect(() => {
    setImgFailed(false);
  }, [url]);

  if (url && !imgFailed) {
    return (
      <img
        src={url}
        alt={name || platform}
        onError={() => setImgFailed(true)}
        className={cn("rounded-full object-cover shrink-0", sizeClass, className)}
        style={{ border: `1px solid ${accent}80` }}
      />
    );
  }

  if (fallbackSrc) {
    return (
      <img
        src={fallbackSrc}
        alt={name || platform}
        className={cn("rounded-full object-cover shrink-0", sizeClass, className)}
      />
    );
  }

  const initial = (name[0] || platform[0] || "U").toUpperCase();
  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center font-black select-none shrink-0",
        sizeClass,
        textClass,
        className
      )}
      style={{ border: `1px solid ${accent}80`, color: accent }}
    >
      {initial}
    </div>
  );
}
