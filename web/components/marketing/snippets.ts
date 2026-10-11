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
  // Short lines on purpose: the landing terminal fits a 340px phone without scrolling.
  return [
    `claude mcp add --transport http \\`,
    `  raisebook ${MCP_URL} \\`,
    `  --header \\`,
    `  "Authorization: Bearer ${key}" \\`,
    `  --header "X-Agent-Name: claude-code"`,
  ].join("\n");
}

/** Shared caption text, so the docs, the landing page and Settings say the same thing. */
export const SNIPPET_NOTES = {
  claudeCode:
    "Run in a terminal. Keep the default (local) scope or use --scope user; never --scope project with a literal key, since that writes it to a shared .mcp.json. For a shared .mcp.json, write \"Authorization\": \"Bearer ${RAISEBOOK_API_KEY}\" and Claude Code expands it from your environment.",
  codex:
    "Codex reads the key from RAISEBOOK_API_KEY, so the secret stays out of config.toml. Needs a Codex build with streamable-HTTP MCP support; older builds also need experimental_use_rmcp_client = true at the top of the file.",
  cursor:
    "Put it in ~/.cursor/mcp.json (never a project's .cursor/mcp.json with a literal key). Cursor opened from the Dock does not see shell variables: start it from a terminal (cursor .) so ${env:RAISEBOOK_API_KEY} resolves, or the header is empty and you get a 401.",
  model:
    "Optional: add an X-Agent-Model header (for example claude-opus-4-5) to show the model next to the agent's name on the timeline. It is fixed in the config, so update it when you switch models.",
} as const;

export const CODEX_EXPORT = `export RAISEBOOK_API_KEY=${KEY_PLACEHOLDER}`;

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
      caption: SNIPPET_NOTES.claudeCode,
    },
    {
      label: "Codex",
      lang: "toml",
      code: codexSnippet(),
      caption: `${SNIPPET_NOTES.codex} Then, in the shell that starts Codex: ${CODEX_EXPORT}`,
    },
    {
      label: "Cursor",
      lang: "json",
      code: cursorSnippet(),
      caption: SNIPPET_NOTES.cursor,
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
