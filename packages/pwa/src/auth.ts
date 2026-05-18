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

export function loginUrl(hubBaseUrl: string): string {
  const httpHub = hubBaseUrl.replace(/^ws(s?):\/\//, "http$1://");
  return `${httpHub}/auth/login`;
}
