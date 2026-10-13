import type { Metadata, Viewport } from "next";

import { ToastProvider } from "@/components/ui";
import { themeInitScript } from "@/lib/theme";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://raisebook.org"),
  title: {
    default: "Raisebook · Free, open-source fundraising CRM for founders",
    template: "%s · Raisebook",
  },
  description:
    "Track every investor through every round: stages, follow-ups, notes and commitments. Free forever, open source, private per workspace, with an MCP server for your coding agent.",
  applicationName: "Raisebook",
  openGraph: {
    type: "website",
    siteName: "Raisebook",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image" },
  ...(process.env.NEXT_PUBLIC_GIT_SHA
    ? { other: { "raisebook-commit": process.env.NEXT_PUBLIC_GIT_SHA } }
    : {}),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F5F8" },
    { media: "(prefers-color-scheme: dark)", color: "#0F141C" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint (SYSTEM 3.27). Inline, first-party. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only rounded-sm bg-fg px-12 py-8 text-canvas focus:not-sr-only focus:fixed focus:top-8 focus:left-8 focus:z-[80]"
        >
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
