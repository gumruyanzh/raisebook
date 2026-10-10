import type { Metadata } from "next";

import { assertDesignEnabled } from "./guard";
import { Kit } from "./Kit";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

/** Component inventory (SYSTEM §3): every UI primitive in light and dark, with fictional data. */
export default function DesignPage() {
  assertDesignEnabled();
  return <Kit />;
}
