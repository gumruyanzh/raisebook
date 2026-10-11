# Security policy

Raisebook holds founders' fundraising data: investor contacts, notes and commitments. We
take reports seriously and answer every one.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Use GitHub's private reporting: **Security → Report a vulnerability** on
  [github.com/gumruyanzh/raisebook](https://github.com/gumruyanzh/raisebook/security/advisories/new).
- Or email **security@raisebook.org** with the details.

Include what you found, how to reproduce it, and the impact you expect. Test only against
your own self-hosted instance or your own account and workspace on raisebook.org. Never
access, change or delete data that isn't yours, and don't run load tests against the hosted
service.

What happens next:
- We confirm receipt within **3 working days**.
- We tell you our assessment and a fix timeline within **10 working days**.
- We credit you in the release notes when the fix ships, unless you prefer not to be named.

Raisebook is a free, volunteer-run project, so there is no paid bug bounty. We are grateful
for every report anyway.

## What is in scope

Everything in this repository and the hosted service at `raisebook.org` /
`api.raisebook.org`. We especially want to hear about:

- **Workspace isolation:** any way to read or change another workspace's rounds, investors,
  timeline, members or keys, through the web app, the REST API, the MCP server, imports or
  exports. This is the most important property of Raisebook.
- Authentication: magic links, session cookies, CSRF, invite tokens.
- API keys: scope escalation, a key minting or widening keys, `rb_test_` keys reaching real
  workspaces.
- Injection: SQL, CSV/formula injection in exports, stored XSS in notes or names.
- Data that outlives a delete (workspace, account, investor), or personal data in logs.

Out of scope: missing best-practice headers without a concrete impact, self-XSS, reports from
automated scanners without a working proof, denial of service through volume, and social
engineering.

## Supported versions

Only the latest commit on `main` (and the hosted service, which runs it) gets security fixes.
Self-hosters should update regularly (`deploy/README.md`).

## How Raisebook protects data

- Every workspace-scoped query filters by the caller's workspace, and child tables use
  composite `(workspace_id, id)` foreign keys, so the database refuses cross-workspace links.
  A test suite enumerates every REST route and MCP tool and checks isolation.
- Ids from another workspace answer 404, never 403, so existence does not leak.
- API keys and sign-in tokens are stored only as SHA-256 hashes. Keys are shown once.
- Only an owner signed in through the web can create keys, manage members or delete the
  workspace; an agent's key can never widen its own access.
- Logs never contain request bodies, query strings, investor fields, emails or tokens.
- No third-party scripts, trackers or analytics; fonts are self-hosted.
- Removing a member, demoting an owner or deleting an account revokes every API key that
  person created, in the same transaction.
- Sign-in links are spent only when the person presses Continue (link scanners that run
  JavaScript cannot burn them), and a link never silently replaces a different signed-in
  account (409 `session_conflict` unless the person chooses to switch).
- Sessions slide for 30 days of use and end 90 days after sign-in at the latest; the Account
  page lists signed-in browsers and can sign out the others.
- Failed API-key lookups, invites per person and new workspaces per person are rate limited,
  and invite emails carry a fixed subject, so Raisebook can't be used as a spam relay.

## Known issues

- None open. (Next 15.5.27 bundles a postcss with build-time-only advisories,
  GHSA-qx2v-qp2m-jg93 and GHSA-6g55-p6wh-862q; `web/package.json` overrides it to postcss
  8.5.29, and `npm audit --omit=dev` is clean.)
- Deletes are hard deletes in one transaction; backups expire within 14 days.
