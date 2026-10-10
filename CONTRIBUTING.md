# Contributing to Raisebook

Thanks for helping. Raisebook is a free, open-source fundraising CRM, and it stays that way
because people fix what bothers them. This page says how to get a change in.

## Before you start

- **Bugs**: open an issue with what you did, what you expected and what happened. Include the
  `request_id` from the error if there is one. Never paste real investor data, API keys or
  session cookies into an issue.
- **Features**: open an issue to discuss it before writing code. Raisebook has a short list of
  things it will never do (paid tiers, cross-workspace features, trackers, scraping), listed in
  `docs/SPEC.md` §1.6. A pull request that adds one of them will be closed.
- **Security problems**: do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Set up

Follow the development quick start in the [README](README.md#quick-start-development). You
need Python 3.12 with uv, Node 20.9+, and Postgres 17 running locally. Tests run against a
real Postgres database; each test session creates its own schema and drops it afterwards.

## Where things are decided

- `docs/SPEC.md` is the product and engineering contract: data model, API, MCP tools, rules.
- `design/SYSTEM.md` is the design system. The web app uses its tokens and components only.
- `CLAUDE.md` holds the working conventions, for people and coding agents alike.

If your change disagrees with the spec, change the spec in the same pull request and say why.

## Rules that matter most

1. **Workspace isolation.** Every query on workspace data filters by the caller's workspace.
   An id from another workspace returns 404. The tests in `backend/tests/isolation/` enumerate
   every `/v1` route and every MCP tool; a new route or tool without coverage fails the build.
2. **Agents are attributed.** Every write records its actor (a person, an agent or the system)
   in the same transaction. Do not add a write path that skips the timeline.
3. **No personal data in logs.** Logs never contain request bodies, investor fields, emails or
   tokens.
4. **No third-party requests from the web app.** No analytics, CDNs, external fonts or
   embeds.
5. **Fictional data only.** Tests, fixtures, docs and screenshots use made-up people and firms
   with `example.com` emails. Never commit a real person's data.

## Making a change

1. Fork the repository and create a branch.
2. Make the change, with tests. Backend changes need pytest coverage; MCP tools are tested
   through the real `/mcp` route.
3. Run the checks:

   ```bash
   cd backend && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy raisebook
   cd web && npm run lint && npm run typecheck && npm run build
   ```

4. For UI changes, check the screen at 360px wide and in dark mode, and attach screenshots to
   the pull request.
5. Open the pull request with a short description of what changed and why.

## Writing copy

Plain, specific and calm, founder to founder. Say what happened and what to do next. Use
numbers. Avoid "AI-powered", "seamless", "supercharge" and exclamation marks. `design/SYSTEM.md`
§6 has the full voice guide.

## License

Raisebook is licensed under AGPL-3.0. By contributing, you agree that your contribution is
licensed under the same terms.
