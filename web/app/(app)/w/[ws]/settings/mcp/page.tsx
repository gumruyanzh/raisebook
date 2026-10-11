import type { Metadata } from "next";

import { ConnectAgent } from "@/components/app/settings/ConnectAgent";

export const metadata: Metadata = { title: "Connect an agent" };

/** Settings → Connect an agent (SYSTEM §4.9). */
export default function ConnectAgentPage() {
  return <ConnectAgent />;
}
