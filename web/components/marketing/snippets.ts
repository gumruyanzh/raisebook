import type { CodeTab } from "@/components/ui";

import { MCP_URL } from "./site";

/**
 * MCP client setup snippets (SPEC §6.5). Syntax checked against each client's own docs on
 * SNIPPETS_CHECKED_ON (site.ts):
 * - Claude Code: `claude mcp add --transport http <name> <url> --header "K: V"`
 * - Codex: `[mcp_servers.<name>]` with url, bearer_token_env_var, http_headers
 * - Cursor: `mcpServers.<name>.url` + `headers`, with `${env:NAME}` interpolation
 * - stdio-only clients: mcp-remote with `--header` (no spaces in args; the value comes from env)
 */

export const KEY_PLACEHOLDER = "rb_live_XXXX";

export function claudeCodeSnippet(key = KEY_PLACEHOLDER): string {
  return [
    `claude mcp add --transport http raisebook \\`,
    `  ${MCP_URL} \\`,
    `  --header "Authorization: Bearer ${key}" \\`,
    `  --header "X-Agent-Name: claude-code"`,
  ].join("\n");
}

export function codexSnippet(): string {
  return [
    "# ~/.codex/config.toml",
    "[mcp_servers.raisebook]",
    `url = "${MCP_URL}"`,
    `bearer_token_env_var = "RAISEBOOK_API_KEY"`,
    `http_headers = { "X-Agent-Name" = "codex" }`,
  ].join("\n");
}

export function cursorSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        raisebook: {
          url: MCP_URL,
          headers: {
            Authorization: "Bearer ${env:RAISEBOOK_API_KEY}",
            "X-Agent-Name": "cursor",
          },
        },
      },
    },
    null,
    2,
  );
}

export function otherSnippet(key = KEY_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        raisebook: {
          command: "npx",
          args: ["-y", "mcp-remote", MCP_URL, "--header", "Authorization:${RAISEBOOK_AUTH}"],
          env: { RAISEBOOK_AUTH: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
}

export function clientTabs(): CodeTab[] {
  return [
    {
      label: "Claude Code",
      lang: "shell",
      code: claudeCodeSnippet(),
      caption: "Run in a terminal. Add --scope user to use Raisebook from every project.",
    },
    {
      label: "Codex",
      lang: "toml",
      code: codexSnippet(),
      caption: "Then export RAISEBOOK_API_KEY=rb_live_… in the shell that starts Codex.",
    },
    {
      label: "Cursor",
      lang: "json",
      code: cursorSnippet(),
      caption: "In .cursor/mcp.json (this project) or ~/.cursor/mcp.json (everywhere).",
    },
    {
      label: "Other",
      lang: "json",
      code: otherSnippet(),
      caption:
        "For clients that only start local (stdio) servers. Clients that speak streamable HTTP need just the URL and the Authorization header.",
    },
  ];
}
