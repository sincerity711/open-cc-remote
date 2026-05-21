import { useEffect, useState } from "react";

export type Device = "mobile" | "tablet" | "desktop";

const MOBILE_MAX = 767;
const TABLET_MAX = 1023;

function pickDevice(width: number): Device {
  if (width <= MOBILE_MAX) return "mobile";
  if (width <= TABLET_MAX) return "tablet";
  return "desktop";
}

/**
 * Tracks the current viewport bucket. SSR-safe — defaults to "desktop"
 * before window is available so static-markup tests have a deterministic value.
 */
export function useDevice(): Device {
  const [device, setDevice] = useState<Device>(() =>
    typeof window === "undefined" ? "desktop" : pickDevice(window.innerWidth),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setDevice(pickDevice(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return device;
}
