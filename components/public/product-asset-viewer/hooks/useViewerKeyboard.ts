"use client";

import { useEffect } from "react";

export interface KeyboardHandlers {
  onPrevPage: () => void;
  onNextPage: () => void;
  /** Jump to page 1. Defaults to repeated `onPrevPage` if omitted (legacy). */
  onFirstPage?: () => void;
  /** Jump to the last page. Defaults to repeated `onNextPage` if omitted. */
  onLastPage?: () => void;
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
 * Keys:
 *   ArrowLeft  → previous page
 *   ArrowRight → next page
 *   Home       → first page   (NOT a single prev — this is the bug fix)
 *   End        → last page    (NOT a single next)
 *   + / =      → zoom in
 *   -          → zoom out
 *   R          → rotate
 *   F          → toggle fit mode
 *   Escape     → handled by useDialogFocusTrap (NOT here, to avoid double-close)
 *
 * Typing inside an <input>, <textarea>, or contentEditable is NEVER hijacked
 * — the user can type a page number without Home/End/etc. firing on the
 * input's value.
 */
export function useViewerKeyboard(handlers: KeyboardHandlers) {
  const {
    onPrevPage, onNextPage, onFirstPage, onLastPage,
    onZoomIn, onZoomOut, onFitToggle, onRotate, enabled,
  } = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      // Don't hijack typing in inputs. Also check `readOnly` to be safe —
      // a readonly number input still shouldn't get shortcut keys.
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )) {
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
          if (onFirstPage) onFirstPage();
          else onPrevPage();
          break;
        case "End":
          event.preventDefault();
          if (onLastPage) onLastPage();
          else onNextPage();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    onPrevPage, onNextPage, onFirstPage, onLastPage,
    onZoomIn, onZoomOut, onFitToggle, onRotate, enabled,
  ]);
}
