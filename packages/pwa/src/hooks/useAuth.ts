import { useEffect, useState } from "react";

const BEARER_KEY = "cc_remote_bearer";

export function consumeFragment(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash) return;
  const params = new URLSearchParams(hash.slice(1));
  const bearer = params.get("bearer");
  if (bearer) {
    localStorage.setItem(BEARER_KEY, bearer);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

export function getBearer(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(BEARER_KEY);
}

export function clearBearer(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(BEARER_KEY);
}

export function loginUrl(_hubBaseUrl: string): string {
  return "/auth/login";
}

export interface UseAuthResult {
  bearer: string | null;
  setBearer: (b: string | null) => void;
  signInHref: string;
  signOut: () => void;
}

export function useAuth(hubUrl: string): UseAuthResult {
  const [bearer, setBearer] = useState<string | null>(null);

  useEffect(() => {
    consumeFragment();
    setBearer(getBearer());
  }, []);

  return {
    bearer,
    setBearer,
    signInHref: loginUrl(hubUrl),
    signOut: () => {
      clearBearer();
      setBearer(null);
    },
  };
}
