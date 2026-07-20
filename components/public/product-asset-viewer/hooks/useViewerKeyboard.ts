"use client";

import { useEffect } from "react";

export interface KeyboardHandlers {
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToggle?: () => void;
  onRotate?: () => void;
  onClose: () => void;
  enabled: boolean;
}

/**
 * Wires viewer keyboard shortcuts. Listens on `document` so shortcuts work
 * regardless of focus position inside the viewer. Escape is also handled by
 * the focus-trap hook; we keep it here for a single source of truth.
 */
export function useViewerKeyboard(handlers: KeyboardHandlers) {
  const { onPrevPage, onNextPage, onZoomIn, onZoomOut, onFitToggle, onRotate, onClose, enabled } = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      // Don't hijack typing in inputs.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        // Allow Escape even from inputs.
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          onPrevPage();
          break;
        case "ArrowRight":
        case "ArrowDown":
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
          onPrevPage(); // callers clamp; for true "first page" callers can extend
          break;
        case "End":
          event.preventDefault();
          onNextPage();
          break;
        case "Escape":
          event.preventDefault();
          onClose();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onPrevPage, onNextPage, onZoomIn, onZoomOut, onFitToggle, onRotate, onClose, enabled]);
}
