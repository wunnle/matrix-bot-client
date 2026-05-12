import { useEffect } from "react";

/**
 * Tracks the visual viewport so the layout stays anchored when iOS Safari
 * scrolls the page up to keep a focused input above the keyboard bar.
 *
 * Sets two CSS vars on <html>:
 *   --vv-offset-top:    how far Safari scrolled the page up (we translate down to cancel it)
 *   --viewport-offset-bottom: gap between visual viewport bottom and layout viewport bottom
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      const offsetTop = vv!.offsetTop;
      const offsetBottom = window.innerHeight - (vv!.offsetTop + vv!.height);
      document.documentElement.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      document.documentElement.style.setProperty(
        "--viewport-offset-bottom",
        `${Math.max(0, offsetBottom)}px`
      );
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
