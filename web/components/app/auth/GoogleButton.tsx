import { buttonClasses } from "@/components/ui/Button";
import { googleSignInUrl, signinErrorMessage } from "@/lib/api/auth-providers";
import { cn } from "@/lib/cn";

/**
 * Google's four-colour "G". The colours are Google's brand mark (its sign-in branding rules
 * require them), so they are the one place raw hex is allowed here. Inline: no third-party
 * request.
 */
function GoogleMark() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 48 48" width="18" height="18" className="shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * "Continue with Google": a plain link (full-page navigation) to the API, which redirects to
 * Google and back. Secondary style, so the cobalt primary stays the emailed-link action.
 */
export function GoogleButton({ next, className }: { next?: string; className?: string }) {
  return (
    <a href={googleSignInUrl(next)} className={buttonClasses("secondary", "lg", cn("w-full", className))}>
      <GoogleMark />
      <span>Continue with Google</span>
    </a>
  );
}

/** Hairline "or" rule between sign-in methods. */
export function OrDivider() {
  return (
    <div role="separator" aria-label="or" className="my-18 flex items-center gap-12">
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <span aria-hidden="true" className="t-label">
        or
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Why the last Google sign-in did not complete (SYSTEM §6: message, then the code in mono). */
export function SignInNotice({ code, message }: { code: string; message: string }) {
  return (
    <div
      role="alert"
      className="mb-18 rounded-sm border border-line border-l-2 border-l-bad bg-surface px-12 py-10 t-body-s text-fg"
    >
      {message}
      <span className="ml-6 font-mono text-micro text-muted">{code}</span>
    </div>
  );
}

/**
 * The block above the email form on `/signin`: the error from a refused Google sign-in (from
 * `?error=`), then "Continue with Google" and an "or" rule. Renders nothing when Google is
 * off and there is no Google error to explain. `enabled` comes from `googleEnabled()` in
 * `lib/api/auth-providers.ts`.
 */
export function GoogleSignIn({
  enabled,
  next,
  error,
}: {
  enabled: boolean;
  next?: string;
  error?: string | string[];
}) {
  const code = Array.isArray(error) ? error[0] : error;
  const message = signinErrorMessage(code);
  if (!enabled && !message) return null;
  return (
    <div className="flex flex-col">
      {message && code ? <SignInNotice code={code} message={message} /> : null}
      {enabled ? (
        <>
          <GoogleButton next={next} />
          <OrDivider />
        </>
      ) : null}
    </div>
  );
}
