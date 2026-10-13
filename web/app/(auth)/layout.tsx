import Link from "next/link";

import { ThemeToggle } from "@/components/ui";

/**
 * Frame for sign-in, verify, invite and onboarding: canvas, the page's own column, and a quiet
 * footer with the theme control. Pages set their own width (400px auth, 560px onboarding).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main id="main" className="gutter flex flex-1 flex-col">
        {children}
      </main>
      <footer className="gutter flex flex-wrap items-center gap-x-16 gap-y-6 py-16 text-muted">
        <ThemeToggle />
        <span className="t-micro ml-auto flex gap-12">
          <Link href="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-fg">
            Terms
          </Link>
          <Link href="/docs" className="hover:text-fg">
            Docs
          </Link>
          <span>raisebook.org</span>
        </span>
      </footer>
    </div>
  );
}
