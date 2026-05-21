import { ClaudeCodeMark } from "./primitives/ClaudeCodeMark";

export interface SignInScreenProps {
  /** Absolute URL to the IAS login endpoint, produced by `loginUrl(HUB_URL)`. */
  loginHref: string;
  /** Optional banner shown above the CTA — e.g. "Session expired, please sign in again". */
  notice?: string;
}

export function SignInScreen({ loginHref, notice }: SignInScreenProps) {
  return (
    <main
      className="bg-background flex h-dvh items-center justify-center p-6"
      data-testid="sign-in-screen"
    >
      <div className="border-border bg-surface shadow-card flex w-full max-w-sm flex-col items-center rounded-2xl border p-6 text-center">
        <ClaudeCodeMark size="xl" />
        <h1 className="mt-4 text-2xl font-semibold">cc-remote</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Sign in with your hub account to control daemons remotely.
        </p>
        {notice && (
          <div
            className="bg-warning-subtle text-warning mt-4 w-full rounded-md px-3 py-2 text-xs"
            role="status"
          >
            {notice}
          </div>
        )}
        <a
          className="bg-primary text-primary-foreground mt-5 inline-flex h-11 w-full items-center justify-center rounded-md text-sm font-semibold"
          href={loginHref}
        >
          Sign in
        </a>
      </div>
    </main>
  );
}
