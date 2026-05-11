import { useEffect } from "react";

/**
 * Tracks the visual viewport (shrinks when the software keyboard appears on iOS).
 * Sets --viewport-offset-bottom on <html> so the chat footer can compensate
 * without relying on env(safe-area-inset-bottom) which misbehaves on iPadOS.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      // Offset = gap between bottom of visual viewport and bottom of layout viewport
      const offset = window.innerHeight - (vv!.offsetTop + vv!.height);
      document.documentElement.style.setProperty(
        "--viewport-offset-bottom",
        `${Math.max(0, offset)}px`
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
