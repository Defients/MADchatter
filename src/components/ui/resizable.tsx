"use client"

import * as ResizablePrimitive from "react-resizable-panels"
import type { RefObject } from "react"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: ResizablePrimitive.GroupProps & {
  /** Alias for `orientation` — older versions used `direction`. */
  direction?: "horizontal" | "vertical"
}) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({
  ref,
  order,
  ...props
}: ResizablePrimitive.PanelProps & {
  /** Legacy ref alias — the library uses `panelRef`. */
  ref?: RefObject<ResizablePrimitive.PanelImperativeHandle | null>
  /** Layout order hint (passed through rest). */
  order?: number
}) {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      panelRef={ref}
      {...props}
    />
  )
}

function ResizableHandle({
  withHandle,
  className,
  onDragging,
  onPointerDown,
  onPointerUp,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
  /**
   * Drag state callback. The underlying library Separator doesn't support
   * this prop natively, so we synthesize it from pointer events.
   */
  onDragging?: (isDragging: boolean) => void
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      onPointerDown={(e) => {
        onDragging?.(true);
        onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        onDragging?.(false);
        onPointerUp?.(e);
      }}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-10 w-1 shrink-0 rounded-lg bg-pink-400/80 shadow-[0_0_6px_rgba(244,114,182,0.5)]" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
