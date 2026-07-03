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

    const root = document.documentElement;
    let settleTimers: ReturnType<typeof setTimeout>[] = [];

    function editableFocused(): boolean {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    }

    function update() {
      // Track the visual viewport only while the keyboard can possibly be
      // open (an editable element is focused). iOS standalone PWAs can skip
      // the final vv resize when the keyboard closes or when the app is
      // backgrounded mid-animation and resumed, leaving stale (short)
      // values — a permanent "chin" below the layout. With no editable
      // focused there is no keyboard, so fall back to the plain viewport.
      if (editableFocused()) {
        root.style.setProperty("--vv-top", `${vv!.offsetTop}px`);
        root.style.setProperty("--vv-height", `${vv!.height}px`);
      } else {
        root.style.removeProperty("--vv-top");
        root.style.removeProperty("--vv-height");
      }
    }

    function settle() {
      // Focus changes race the keyboard animation and iOS's last resize
      // event can lag or never come — re-check a few times as it settles.
      settleTimers.forEach(clearTimeout);
      settleTimers = [100, 300, 600].map((ms) => setTimeout(update, ms));
      update();
    }

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      settleTimers.forEach(clearTimeout);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("visibilitychange", settle);
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
