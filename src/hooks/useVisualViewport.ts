import { useEffect } from "react";

/**
 * Keeps the layout pinned to the visual viewport so it stays fully visible
 * when iOS Safari scrolls the page or the keyboard appears.
 *
 * Sets on <html>:
 *   --vv-top:    visual viewport top offset (where the layout should start)
 *   --vv-height: visual viewport height (how tall the layout should be)
 *   --viewport-offset-bottom: gap below visual viewport (for footer padding)
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      const top = vv!.offsetTop;
      const height = vv!.height;
      const bottomGap = window.innerHeight - top - height;
      document.documentElement.style.setProperty("--vv-top", `${top}px`);
      document.documentElement.style.setProperty("--vv-height", `${height}px`);
      document.documentElement.style.setProperty(
        "--viewport-offset-bottom",
        `${Math.max(0, bottomGap)}px`
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
