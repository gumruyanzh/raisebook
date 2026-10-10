import { OG_SIZE, renderOg } from "@/components/marketing/og/render";

export const alt = "Raisebook docs: getting started, MCP setup, REST API, CSV format and self-hosting.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOg({
    eyebrow: "Raisebook docs",
    title: "Connect your agent. Import your sheet.",
    subtitle: "MCP setup for Claude Code, Codex and Cursor. REST API. CSV format.",
  });
}
