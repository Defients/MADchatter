import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { DirectionProvider } from "@base-ui/react/direction-provider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  trackClassName,
  indicatorClassName,
  ...props
}: SliderPrimitive.Root.Props & { trackClassName?: string; indicatorClassName?: string }) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <DirectionProvider direction="ltr">
    <SliderPrimitive.Root
      dir="ltr"
      className={cn("data-horizontal:w-full data-vertical:h-full overflow-visible px-1.5 [direction:ltr]", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none overflow-visible [direction:ltr] data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn("relative grow overflow-hidden rounded-full bg-muted select-none [direction:ltr] data-horizontal:h-2.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-2.5", trackClassName)}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn("bg-primary select-none data-horizontal:h-full data-vertical:w-full transition-all duration-150 ease-out", indicatorClassName)}
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className="size-4 rounded-full border border-ring bg-white shadow-[var(--elev-2)] ring-ring/50 select-none after:absolute after:-inset-2 hover:ring-3 hover:scale-105 focus-visible:ring-3 focus-visible:outline-hidden focus-visible:shadow-[var(--focus-ring)] active:ring-3 active:scale-95 disabled:pointer-events-none disabled:opacity-50 transition-transform duration-150 ease-out"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
    </DirectionProvider>
  )
}

export { Slider }
