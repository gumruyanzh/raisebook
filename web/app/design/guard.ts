import { notFound } from "next/navigation";

/** /design is a dev review page; set NEXT_PUBLIC_ENABLE_DESIGN=1 to keep it in a production build. */
export function assertDesignEnabled(): void {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_ENABLE_DESIGN !== "1") {
    notFound();
  }
}
