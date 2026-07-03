import { useEffect, useRef } from "react";

/**
 * Keep --vv-top / --vv-height in sync with the visual viewport so the
 * fixed .layout container tracks the visible area (iOS keyboard, pinch
 * zoom, Safari's focused-input reveal scroll). Call once at the layout
 * level — the vars are global.
 */
export function useVisualViewportVars() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      document.documentElement.style.setProperty("--vv-top", `${vv!.offsetTop}px`);
      document.documentElement.style.setProperty("--vv-height", `${vv!.height}px`);
    }

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}

/**
 * Run a callback when the visual viewport resizes (keyboard show/hide,
 * pinch zoom) — deliberately not on vv scroll, so panning around with
 * the keyboard open doesn't retrigger it. Always invokes the latest
 * callback, so callers may pass an inline closure.
 */
export function useVisualViewportResize(onResize: () => void, enabled = true) {
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });

  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => onResizeRef.current();
    vv.addEventListener("resize", handler);
    return () => vv.removeEventListener("resize", handler);
  }, [enabled]);
}
