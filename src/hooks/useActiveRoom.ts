import { useEffect } from "react";
import { loadAuth } from "../lib/auth";

function reportActiveRoom(roomId: string | null, deviceId: string) {
  fetch("/api/active-room", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, deviceId }),
  }).catch(() => {});
}

export function useActiveRoom(roomId: string | null) {
  useEffect(() => {
    const auth = loadAuth();
    const deviceId = auth?.deviceId;
    if (!deviceId || !roomId) return;

    const report = (active: boolean) => reportActiveRoom(active ? roomId : null, deviceId);

    if (document.visibilityState === "visible") report(true);

    const onChange = () => report(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);

    return () => {
      report(false);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [roomId]);
}
