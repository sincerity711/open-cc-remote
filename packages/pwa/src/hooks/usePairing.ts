import { useCallback, useEffect, useRef, useState } from "react";

export type PairingState =
  | { status: "idle" }
  | { status: "issuing" }
  | { status: "active"; code: string; expiresAt: number; remainingSec: number };

export function pairIssueUrl(_hubUrl: string): string {
  return "/pair/issue";
}

export interface PairingTickResult {
  state: PairingState;
  expired: boolean;
}

export function pairingTick(state: PairingState, now: number): PairingTickResult {
  if (state.status !== "active") return { state, expired: false };
  if (now >= state.expiresAt) return { state: { status: "idle" }, expired: true };
  const remainingSec = Math.max(1, Math.ceil((state.expiresAt - now) / 1000));
  return {
    state: { ...state, remainingSec },
    expired: false,
  };
}

export interface UsePairingResult {
  state: PairingState;
  generate: () => Promise<void>;
  cancel: () => void;
  lastError: string | null;
}

export function usePairing(
  hubUrl: string,
  bearer: string | null,
  onPaired?: () => void,
): UsePairingResult {
  const [state, setState] = useState<PairingState>({ status: "idle" });
  const [lastError, setLastError] = useState<string | null>(null);
  const issuingRef = useRef(false);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const generate = useCallback(async () => {
    if (!bearer) return;
    if (issuingRef.current) return;
    if (state.status !== "idle") return;
    issuingRef.current = true;
    setState({ status: "issuing" });
    setLastError(null);
    try {
      const res = await fetch(pairIssueUrl(hubUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) throw new Error(`POST /pair/issue: ${res.status}`);
      const body = await res.json() as { code: string; expires_in_sec: number };
      const expiresAt = Date.now() + body.expires_in_sec * 1000;
      setState({
        status: "active",
        code: body.code,
        expiresAt,
        remainingSec: body.expires_in_sec,
      });
    } catch (e) {
      setLastError((e as Error).message);
      setState({ status: "idle" });
    } finally {
      issuingRef.current = false;
    }
  }, [hubUrl, bearer, state.status]);

  const cancel = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  const isActive = state.status === "active";
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      setState((prev) => {
        const result = pairingTick(prev, Date.now());
        if (result.expired) onPairedRef.current?.();
        return result.state;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  return { state, generate, cancel, lastError };
}
