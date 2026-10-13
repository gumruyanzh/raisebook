"use client";

/**
 * Last resort: the root layout itself failed, so nothing from it (styles, fonts, theme) is
 * available. Plain inline styles in both color schemes.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          fontSize: 16,
          lineHeight: 1.5,
          background: "Canvas",
          color: "CanvasText",
          colorScheme: "light dark",
          padding: 16,
        }}
      >
        <main style={{ maxWidth: 480 }}>
          <p style={{ fontWeight: 700, margin: "0 0 8px" }}>Raisebook</p>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Something went wrong on our side</h1>
          <p style={{ margin: "0 0 16px", opacity: 0.75 }}>
            The page could not be shown. Your data is safe. Try again in a moment.
            {error.digest ? (
              <span style={{ display: "block", fontFamily: "monospace", fontSize: 12 }}>
                ref {error.digest}
              </span>
            ) : null}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ font: "inherit", padding: "6px 14px", marginRight: 12, cursor: "pointer" }}
          >
            Try again
          </button>
          {/* A full page load on purpose: the app shell itself failed. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Home</a>
        </main>
      </body>
    </html>
  );
}
