import { useEffect } from "react";

export function useVisualViewport(onResize?: () => void) {
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
      onResize?.();
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
