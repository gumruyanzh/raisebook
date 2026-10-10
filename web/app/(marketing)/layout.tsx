// STUB by Foundation-web. Owner: Landing+Docs (docs/OWNERSHIP.md) — replace freely.
import Link from "next/link";

import { ButtonLink, ThemeToggle, Wordmark } from "@/components/ui";

const REPO = process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/gumruyanzh/raisebook";

/** Marketing shell: 64px nav and footer (SYSTEM §4.14). */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="gutter mx-auto flex h-64 max-w-site items-center gap-18">
          <Wordmark size={22} href="/" />
          <nav aria-label="Site" className="hidden items-center gap-18 text-muted sm:flex">
            <Link href="/docs" className="hover:text-fg">Docs</Link>
            <Link href="/docs" className="hover:text-fg">MCP</Link>
            <Link href="/privacy" className="hover:text-fg">Privacy</Link>
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="hover:text-fg">
              GitHub <span aria-hidden>↗</span>
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-8">
            <ButtonLink href="/signin" variant="ghost">Sign in</ButtonLink>
            <ButtonLink href="/signin" variant="primary">Start free</ButtonLink>
          </div>
        </div>
      </header>
      <main id="main" className="gutter mx-auto w-full max-w-site flex-1 py-48">
        {children}
      </main>
      <footer className="border-t border-line">
        <div className="gutter mx-auto flex max-w-site flex-wrap items-center gap-x-18 gap-y-8 py-24 text-muted">
          <Wordmark size={20} />
          <p>Free, private, open source fundraising CRM.</p>
          <ThemeToggle className="sm:ml-auto" />
          <p className="t-micro w-full">raisebook.org · AGPL-3.0</p>
        </div>
      </footer>
    </div>
  );
}
