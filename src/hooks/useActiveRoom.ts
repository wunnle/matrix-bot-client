import { useEffect, useRef } from "react";
import { loadAuth } from "../lib/auth";

function reportActiveRoom(roomId: string | null, deviceId: string) {
  fetch("/api/active-room", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, deviceId }),
  }).catch(() => {});
}

export function useActiveRoom(roomId: string | null) {
  const deviceId = useRef<string | null>(null);

  useEffect(() => {
    const auth = loadAuth();
    if (auth?.deviceId) deviceId.current = auth.deviceId;
  }, []);

  useEffect(() => {
    const id = deviceId.current;
    if (!id) return;

    const report = (active: boolean) => reportActiveRoom(active ? roomId : null, id);

    if (document.visibilityState === "visible") report(true);

    const onVisible = () => report(true);
    const onHidden = () => report(false);

    document.addEventListener("visibilitychange", () => {
      document.visibilityState === "visible" ? onVisible() : onHidden();
    });

    return () => {
      report(false);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [roomId]);
}
