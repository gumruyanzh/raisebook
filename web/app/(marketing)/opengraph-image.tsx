import { OG_SIZE, renderOg } from "@/components/marketing/og/render";

export const alt =
  "Raisebook: run your raise from one ledger. Free forever, open source, with an MCP server for your agent.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOg({
    eyebrow: "Free forever · Open source · MCP",
    title: "Run your raise from one ledger.",
    subtitle: "The fundraising CRM founders don't have to pay for, built for the agent era.",
  });
}
