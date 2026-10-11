import { ButtonLink, EmptyState, Wordmark } from "@/components/ui";

export default function NotFound() {
  return (
    <main id="main" className="gutter mx-auto w-full max-w-read py-48">
      <Wordmark size={22} href="/" />
      <EmptyState
        className="mt-32"
        title="There is no page at this address"
        actions={
          <>
            <ButtonLink href="/app">Go to your workspace</ButtonLink>
            <ButtonLink href="/" variant="ghost">
              Marketing site
            </ButtonLink>
          </>
        }
      >
        The link may be old, or the item may have been deleted or belong to another workspace.
      </EmptyState>
    </main>
  );
}
