# Investor Research — agreed spec (owner-approved 2026-10-13)

> **Not shipped.** Investor research is an unreleased design in progress. It is off by default
> (`RAISEBOOK_RESEARCH_ENABLED`), raisebook.org does not run it, and nothing here describes how
> the live service handles your data today; the [privacy page](https://raisebook.org/privacy)
> does. If research ships, the privacy page changes first.

Owner decisions from the grilling session. Binding; deviations need the owner.

1. **Output = full dossier** per investor.
2. **Grounding:** two-step pipeline via the workspace's OpenRouter key. A cheap search model (OpenRouter web search / Perplexity Sonar) gathers sources; a writer model reads them and writes the dossier. **Every factual claim cites a source fetched in that run.** Uncited claims are dropped, or shown in a collapsed "Unverified — from model memory" section, clearly marked.
3. **Identity first.** A cheap identity step resolves who the investor probably is (LinkedIn URL, firm site, title) with a confidence score. Above threshold → proceeds automatically. Below → investor shows "Is this them?" with 2–3 candidates; nothing deeper runs until the user picks. The confirmed identity (linkedin_url, firm website, title) is stored on the investor and anchors all later research; sources that don't match the anchor are discarded.
4. **Triggers & cost:** manual only. "Research" on one investor; "Research selected" for a selection with an upfront cost estimate and confirm; identity matching offered cheaply in bulk on its own ("Match all 411 ≈ $X"). Workspace monthly spend cap, **default $25**, editable by owner/admin; runs stop when hit. Each run records its real cost (from OpenRouter usage) on the investor/run. Never auto-runs on import.
5. **Dossier layout (fixed):**
   1. **Brief** (always visible, ≤5 lines): verdict Strong/Possible/Poor fit + one-line why; best way in; one opener line; one risk; last researched date.
   2. Fit — stage/sector/check vs this round; actively deploying (deals in last 12 mo); portfolio conflicts.
   3. Recent activity — last 5–10 deals, fund raises, partner moves.
   4. Thesis & public views — linked posts/talks/podcasts.
   5. Ways in — only publicly evidenced paths (co-investors, portfolio founders, shared events from our own data). Never guesses who knows whom.
   6. Talking points — which part of *our* story to lead with.
   7. Red flags — publicly documented slow/ghosting reputation, conflicts, fund near end of life.
   Sections 2–7 collapsed under the Brief; every claim has a small source link. The Brief also shows in Triage's decision panel.
6. **Company profile per workspace** (rounds inherit): one-line pitch, sectors, stage, location, 3 traction points, what you want from investors (lead/follow, check range, strategic help). Pre-fill from **website URL** and/or **deck PDF upload** (model drafts, user edits). Identity matching works without it; Fit/Talking points require it. Settings states plainly that profile + deck are sent to the AI provider via the user's OpenRouter key.
7. **Write-back:** fill **empty** investor fields automatically with a "from research" source mark. Never silently change existing values — show suggestions ("Research says check $250k–1M (you have $50k–250k) — accept / ignore"), including fit ("Research: Strong fit (you had Maybe)"), one-key accept in Triage, and "Accept all suggestions" for a batch.
8. **Privacy scope:** research is private per workspace. Store public facts (identity + cited public facts) separately from private analysis (verdicts, notes, talking points, who researched whom) so an opt-in shared/public layer and future **public investor profiles with portfolios** can be added later. Do not build sharing now.
9. **Models:** presets in Settings — **Best (default)**: Sonar Pro search + Claude Opus writer; **Balanced**: Sonar + Claude Sonnet; **Budget**: Sonar + a cheap capable writer. "Advanced": any OpenRouter model id per step. Identity step always uses the cheap search model. Show est. cost per dossier per preset. Verify preset model ids exist on OpenRouter when saving the key (use OpenRouter's public models list; pick current ids at build time).
10. **Freshness:** dossier dated; "may be stale" after 90 days; when an investor moves to **Meeting** and dossier > 30 days old, offer "Refresh before your meeting? ≈ $X" (never automatic). Refresh shows **"New since <date>"** diff at top.
11. **MCP/agents:** read dossiers; start research (write scope, respects cap); **`save_dossier`** — an agent researches with its own tools and submits a dossier in the same schema; validated by the same rules (citations required, identity anchor match, schema, privacy filter); marked "by <agent-name>". Lets Claude Code users research without an OpenRouter key.
12. **Key:** one OpenRouter key per **workspace**, set by owner/admin. Members with edit rights run research within cap; viewers read only. Key encrypted at rest (envelope encryption with a server KEK from env), never readable back (show last 4), validated against OpenRouter on save, redacted from logs, "Remove key" deletes immediately. Raisebook never pays for model calls.
13. **Ethics:** professional info only — firm, role, investments, funds, public posts/talks/interviews in professional capacity, publicly listed work email. **Never:** personal phone, home address, family, health, politics, religion, personal social accounts. Enforced in prompts AND by an output filter (phones/addresses stripped) applied to both model and agent-submitted dossiers. Public **Research Policy** page + a removal-request process (investors can request deletion of what Raisebook stores about them).

Engineering defaults (Claude's call): background jobs with progress UI; partial/failed runs keep gathered sources and are resumable; idempotent job claims; per-run cost accounting; all tests use fictional investors and a mocked OpenRouter (no real spend in tests/CI).
