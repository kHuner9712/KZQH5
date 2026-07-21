"use client";

import { useEffect } from "react";

export interface KeyboardHandlers {
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToggle?: () => void;
  onRotate?: () => void;
  /** onClose is handled by the focus-trap; kept for interface compatibility. */
  onClose?: () => void;
  enabled: boolean;
}

/**
 * Wires viewer keyboard shortcuts. Listens on `document` so shortcuts work
 * regardless of focus position inside the viewer.
 *
 * NOTE: Escape is intentionally NOT handled here — the dialog focus-trap
 * (`useDialogFocusTrap`) already handles Escape and calls `onClose`. Handling
 * it here too would trigger a double-close.
 */
export function useViewerKeyboard(handlers: KeyboardHandlers) {
  const { onPrevPage, onNextPage, onZoomIn, onZoomOut, onFitToggle, onRotate, enabled } = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      // Don't hijack typing in inputs.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          onPrevPage();
          break;
        case "ArrowRight":
          event.preventDefault();
          onNextPage();
          break;
        case "+":
        case "=":
          event.preventDefault();
          onZoomIn();
          break;
        case "-":
          event.preventDefault();
          onZoomOut();
          break;
        case "f":
        case "F":
          if (onFitToggle) { event.preventDefault(); onFitToggle(); }
          break;
        case "r":
        case "R":
          if (onRotate) { event.preventDefault(); onRotate(); }
          break;
        case "Home":
          event.preventDefault();
          onPrevPage();
          break;
        case "End":
          event.preventDefault();
          onNextPage();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onPrevPage, onNextPage, onZoomIn, onZoomOut, onFitToggle, onRotate, enabled]);
}
