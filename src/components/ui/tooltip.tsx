import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"
import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  hideArrow = false,
  zIndex,
  collisionAvoidance,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "collisionAvoidance"
  > & { hideArrow?: boolean; zIndex?: number }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        className="isolate"
        style={{ zIndex: zIndex ?? 50 }}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-[var(--elev-3)] has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          {!hideArrow && (
            <TooltipPrimitive.Arrow className="z-50 size-2 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
          )}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Convenience wrapper: themed dark tooltip with a single line of content.
 * Wraps any element (button, input, div, img, etc.) without adding DOM nodes.
 *
 * Usage:
 *   <ThemedTooltip content="Copy log">
 *     <button onClick={...}><Copy /></button>
 *   </ThemedTooltip>
 */
function ThemedTooltip({
  children,
  content,
  side = "top",
  align = "center",
  sideOffset = 6,
  hideArrow = false,
  className,
  zIndex,
  collisionAvoidance,
  closeOnPopupHover = false,
}: {
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  hideArrow?: boolean;
  className?: string;
  zIndex?: number;
  collisionAvoidance?: TooltipPrimitive.Positioner.Props["collisionAvoidance"];
  /** Close the tooltip as soon as the pointer leaves the trigger — hovering the tooltip popup itself no longer keeps it open. */
  closeOnPopupHover?: boolean;
}) {
  return (
    <Tooltip disableHoverablePopup={closeOnPopupHover}>
      <TooltipTrigger render={children} />
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        hideArrow={hideArrow}
        zIndex={zIndex}
        collisionAvoidance={collisionAvoidance}
        className={cn(
          "bg-[#1a1a22] border border-white/10 text-gray-200 rounded-lg shadow-2xl px-3 py-1.5 text-xs font-medium",
          className
        )}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, ThemedTooltip }
