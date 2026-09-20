import React, { useRef } from "react";
import { beginRangeGesture, updateRangeGestureIntent, type RangeGestureState } from "../lib/mobileControls";
import { cn } from "../lib/utils";

export interface MobileIntentRangeProps {
  min: number;
  max: number;
  step: number;
  value: number;
  onValueChange: (value: number) => void;
  ariaLabel: string;
  className?: string;
}

function stepPrecision(step: number): number {
  const decimal = String(step).split(".")[1];
  return decimal?.length ?? 0;
}

/**
 * Mobile range input that leaves vertical gestures to page scrolling and only
 * commits touch/pen changes after horizontal intent is established. Mouse and
 * keyboard behavior stays native.
 */
export function MobileIntentRange({
  min,
  max,
  step,
  value,
  onValueChange,
  ariaLabel,
  className,
}: MobileIntentRangeProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const gestureRef = useRef<RangeGestureState | null>(null);

  const restoreControlledValue = () => {
    if (inputRef.current) inputRef.current.value = String(value);
  };

  const valueFromPointer = (clientX: number): number => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const stepped = min + Math.round(((max - min) * ratio) / step) * step;
    return Number(Math.max(min, Math.min(max, stepped)).toFixed(stepPrecision(step)));
  };

  const finishGesture = (pointerId: number, cancelled = false) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    if (cancelled || gesture.intent !== "horizontal") restoreControlledValue();
    if (inputRef.current?.hasPointerCapture(pointerId)) {
      inputRef.current.releasePointerCapture(pointerId);
    }
    gestureRef.current = null;
  };

  return (
    <input
      ref={inputRef}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => {
        const gesture = gestureRef.current;
        if (!gesture) {
          onValueChange(Number(event.currentTarget.value));
          return;
        }
        if (gesture.intent === "horizontal") {
          onValueChange(Number(event.currentTarget.value));
        } else {
          event.currentTarget.value = String(value);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        gestureRef.current = beginRangeGesture(event.pointerId, event.clientX, event.clientY);
        // Native range inputs may jump on pointer-down; keep the controlled
        // value until direction intent clears the threshold.
        restoreControlledValue();
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const next = updateRangeGestureIntent(gesture, event.clientX, event.clientY);
        gestureRef.current = next;
        if (next.intent === "vertical") {
          restoreControlledValue();
          return;
        }
        if (next.intent === "horizontal") {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          onValueChange(valueFromPointer(event.clientX));
        }
      }}
      onPointerUp={(event) => finishGesture(event.pointerId)}
      onPointerCancel={(event) => finishGesture(event.pointerId, true)}
      onLostPointerCapture={(event) => {
        if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
      }}
      aria-label={ariaLabel}
      className={cn("mobile-slider", className)}
    />
  );
}
