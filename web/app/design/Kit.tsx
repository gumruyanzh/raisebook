"use client";

import { useState, type ReactNode } from "react";

import {
  ActorName,
  AgentMarker,
  Board,
  BoardCard,
  BoardColumn,
  Button,
  ButtonLink,
  Checkbox,
  Chip,
  CodeBlock,
  ConfirmDialog,
  DefList,
  Dialog,
  EmptyState,
  Field,
  FileDrop,
  FitMeter,
  FollowUpChip,
  FunnelBar,
  Input,
  Kbd,
  Ledger,
  LinkButtons,
  Loading,
  Menu,
  Meter,
  MoneyChip,
  PageHeader,
  Pagination,
  PriorityChip,
  Radio,
  RoundPicker,
  SaveState,
  SearchInput,
  SecretReveal,
  SectionLabel,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  StageDot,
  StagePill,
  StageSelector,
  TabLinks,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tabs,
  Textarea,
  ThemeToggle,
  Timeline,
  Tooltip,
  TopBar,
  Tr,
  Wordmark,
  useToast,
} from "@/components/ui";
import { STAGE_COLORS } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, money, moneyCompact } from "@/lib/format";

import { ACTIVITIES, CARDS, MCP_SNIPPETS, NOW, STAGES, TODAY, TZ } from "./sample";

/* ---------- layout helpers ---------- */

const SECTIONS = [
  ["tokens", "Tokens"],
  ["type", "Type"],
  ["buttons", "Buttons"],
  ["fields", "Fields"],
  ["chips", "Chips and stages"],
  ["meters", "Meters"],
  ["ledger", "Ledger"],
  ["board", "Board"],
  ["table", "Table"],
  ["timeline", "Timeline"],
  ["nav", "Navigation"],
  ["overlays", "Overlays"],
  ["code", "Code and secrets"],
  ["misc", "Everything else"],
] as const;

/** Renders its children twice: on a light panel and on a dark panel. */
function Specimen({
  children,
  className,
  stack,
}: {
  children: () => ReactNode;
  className?: string;
  /** Always one column (wide components such as the TopBar). */
  stack?: boolean;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-12", !stack && "2xl:grid-cols-2")}>
      {(["light", "dark"] as const).map((t) => (
        <div
          key={t}
          data-theme={t}
          className={cn("min-w-0 rounded-md border border-line p-16", className)}
        >
          <p className="t-label mb-12">{t}</p>
          {children()}
        </div>
      ))}
    </div>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-72 border-t border-line pt-24">
      <h2 id={`${id}-h`} className="t-display-xs">
        {title}
      </h2>
      {note ? <p className="t-body-s mt-4 mb-12 max-w-[80ch] text-muted">{note}</p> : <div className="mb-12" />}
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="mb-14 last:mb-0">
      {label ? <p className="t-micro mb-6 text-muted">{label}</p> : null}
      <div className="flex flex-wrap items-center gap-8">{children}</div>
    </div>
  );
}

const SWATCHES = [
  "canvas",
  "surface",
  "sunk",
  "line",
  "fg",
  "muted",
  "faint",
  "accent",
  "accent-soft",
  "hot",
  "warm",
  "maybe",
  "good",
  "bad",
  "agent",
  "agent-soft",
] as const;

/* ---------- demos with state ---------- */

function OverlayDemos() {
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stage, setStage] = useState("dd");
  const [fit, setFit] = useState(5);
  return (
    <>
      <Row>
        <Button onClick={() => setSheet(true)}>Open sheet</Button>
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button variant="danger-quiet" onClick={() => setConfirm(true)}>
          Delete workspace…
        </Button>
        <Button onClick={() => toast.show("Dana Whitfield moved to Meeting.", { label: "Undo", onClick: () => toast.show("Moved back to Replied.") })}>
          Show toast
        </Button>
        <Menu
          label="Move to"
          trigger="Move to… ▾"
          triggerClassName="inline-flex h-32 items-center rounded-sm border border-line bg-surface px-12 font-medium"
          items={STAGES.map((s) => ({
            label: s.label,
            icon: <StageDot color={s.color} />,
            selected: s.key === "dd",
            onSelect: () => toast.show(`Dana Whitfield moved to ${s.label}.`),
          }))}
        />
      </Row>
      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Dana Whitfield"
        subline="Partner · Harbor Light Ventures"
        chips={
          <>
            <PriorityChip fit={fit} showFit />
            <Chip tone="type">VC</Chip>
            <Chip tone="industry">Robotics</Chip>
          </>
        }
        headerAside={
          <a href="#overlays" className="link t-body-s">
            Open full page ↗
          </a>
        }
      >
        <div>
          <SectionLabel>Stage for Seed</SectionLabel>
          <StageSelector stages={STAGES} value={stage} onSelect={setStage} />
        </div>
        <div>
          <SectionLabel aside={<SaveState state="saved" />}>Round fields</SectionLabel>
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
            <Field label="Follow up on">
              <Input type="date" defaultValue="2026-10-16" />
            </Field>
            <Field label="Soft amount">
              <Input mono inputMode="numeric" defaultValue="250000" />
            </Field>
            <Field label="Fit">
              <FitMeter value={fit} editable onChange={setFit} />
            </Field>
            <Field label="Owner">
              <Select defaultValue="sam">
                <option value="sam">Sam Rivera</option>
                <option value="">No owner</option>
              </Select>
            </Field>
          </div>
        </div>
        <div>
          <SectionLabel>Timeline</SectionLabel>
          <Timeline items={ACTIVITIES.slice(0, 3)} timeZone={TZ} now={NOW} />
        </div>
        <div>
          <SectionLabel>Contact</SectionLabel>
          <LinkButtons linkedin="https://www.linkedin.com/in/example-dana-whitfield" website="https://example.com" email="dana@example.com" />
        </div>
      </Sheet>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Add investor"
        description="They are added to Seed in the first stage."
        onSubmit={() => setDialog(false)}
        actions={
          <>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Add investor
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-10">
          <Field label="Name">
            <Input autoFocus placeholder="Dana Whitfield" />
          </Field>
          <Field label="Firm" optional>
            <Input placeholder="Harbor Light Ventures" />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          toast.show("Nothing was deleted. This is the design page.");
        }}
        title="Delete Kestrel Robotics?"
        confirmLabel="Delete workspace permanently"
        typed="kestrel-robotics-k7p2"
      >
        Everything in Kestrel Robotics is deleted immediately: 2 rounds, 212 investors, 1,904
        timeline entries, 3 API keys. Export first if you want a copy.
      </ConfirmDialog>
    </>
  );
}

function InteractiveBits() {
  const [view, setView] = useState<"board" | "table">("board");
  const [kind, setKind] = useState<"note" | "email" | "call" | "meeting">("note");
  const [tab, setTab] = useState<"claude" | "codex" | "cursor">("claude");
  const [fit, setFit] = useState(3);
  const [stage, setStage] = useState("meeting");
  return (
    <>
      <Row label="Segmented">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board" },
            { value: "table", label: "Table" },
          ]}
        />
        <Segmented
          label="Activity kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: "note", label: "Note" },
            { value: "email", label: "Email" },
            { value: "call", label: "Call" },
            { value: "meeting", label: "Meeting" },
          ]}
        />
      </Row>
      <Row label="Tabs">
        <div className="w-full">
          <Tabs
            label="Client"
            value={tab}
            onChange={setTab}
            items={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
              { value: "cursor", label: "Cursor" },
            ]}
          />
        </div>
      </Row>
      <Row label="TabLinks (route tabs)">
        <div className="w-full">
          <TabLinks
            label="Round"
            active="pipeline"
            items={[
              { key: "pipeline", label: "Pipeline", href: "#nav" },
              { key: "overview", label: "Overview", href: "#nav" },
              { key: "settings", label: "Settings", href: "#nav" },
            ]}
          />
        </div>
      </Row>
      <Row label="FitMeter (editable: arrows, Home/End, 0–5)">
        <FitMeter value={fit} editable onChange={setFit} />
      </Row>
      <Row label="StageSelector">
        <StageSelector stages={STAGES} value={stage} onSelect={setStage} />
      </Row>
    </>
  );
}

/* ---------- the page ---------- */

export function Kit() {
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: "name" | "fit" | "soft"; dir: "asc" | "desc" }>({ col: "fit", dir: "desc" });
  const sorted = [...CARDS].sort((a, b) => {
    const d = sort.dir === "asc" ? 1 : -1;
    if (sort.col === "name") return a.name.localeCompare(b.name) * d;
    if (sort.col === "soft") return ((a.amount ?? 0) - (b.amount ?? 0)) * d;
    return (a.fit - b.fit) * d;
  });
  const toggle = (col: typeof sort.col) =>
    setSort((s) => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  const sortOf = (col: typeof sort.col) => (sort.col === col ? sort.dir : null);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas">
        <div className="gutter mx-auto flex h-56 max-w-app items-center gap-14">
          <Wordmark href="/" />
          <span className="t-label">Design system</span>
          <ThemeToggle className="ml-auto" />
        </div>
      </header>
      <main id="main" className="gutter mx-auto flex max-w-app flex-col gap-32 pt-24 pb-96">
        <PageHeader
          title="The Desk"
          subline={
            <>
              Every component in <code className="text-sm">components/ui</code>, rendered on a light and
              a dark panel. Binding spec: <code className="text-sm">design/SYSTEM.md</code>. All data
              is fictional.
            </>
          }
        />
        <nav aria-label="Sections" className="t-body-s flex flex-wrap gap-x-14 gap-y-4">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="link">
              {label}
            </a>
          ))}
        </nav>

        <Section id="tokens" title="Tokens" note="Cobalt is 'you can act'. Orchid is 'an agent did this', and nothing else. Green is real money. Red means act now or failed.">
          <Specimen>
            {() => (
              <>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-8">
                  {SWATCHES.map((s) => (
                    <div key={s} className="flex flex-col gap-4">
                      <span className="h-32 rounded-sm border border-line" style={{ background: `var(--${s})` }} />
                      <span className="t-micro text-muted">{s}</span>
                    </div>
                  ))}
                </div>
                <p className="t-label mt-16 mb-8">Stage palette</p>
                <div className="flex flex-wrap gap-x-14 gap-y-6">
                  {STAGE_COLORS.map((c) => (
                    <StagePill key={c} color={c} label={c} />
                  ))}
                </div>
              </>
            )}
          </Specimen>
        </Section>

        <Section id="type" title="Type" note="Bricolage Grotesque for display and amounts, IBM Plex Sans for UI, IBM Plex Mono for data and labels.">
          <Specimen>
            {() => (
              <div className="flex flex-col gap-10">
                <p className="t-display-xl">Run your raise from one ledger.</p>
                <p className="t-display-l">Your agent can work the round.</p>
                <p className="t-display-m">Investors</p>
                <p className="t-amount">
                  $750,000 <span className="text-[18px] font-medium text-muted">of $2,000,000</span>
                </p>
                <p className="t-display-s">Dana Whitfield</p>
                <p className="t-display-xs">No investors in Seed yet</p>
                <p className="t-body-l measure">Raisebook tracks every investor through every round: stages, follow-ups, notes and commitments.</p>
                <p>Body 14: Dana asked for the data room after the demo.</p>
                <p className="t-body-s text-muted">Body-s 12.5: Partner · Harbor Light Ventures</p>
                <p className="t-label">Label · Stage for Seed</p>
                <p className="t-data">Data 12.5 · 2026-10-14 · rb_live_Ab3x · $1,250,000</p>
                <p className="t-micro text-muted">Micro 11.5 · 48 of 212 investors</p>
              </div>
            )}
          </Specimen>
        </Section>

        <Section id="buttons" title="Buttons" note="One primary per view. Danger only inside confirm dialogs. Loading changes the label and keeps the width.">
          <Specimen>
            {() => (
              <>
                <Row label="Variants">
                  <Button variant="primary">Add investor</Button>
                  <Button>Import CSV</Button>
                  <Button variant="ghost">Cancel</Button>
                  <Button variant="danger">Delete workspace permanently</Button>
                  <Button variant="danger-quiet">Delete workspace…</Button>
                </Row>
                <Row label="Sizes, kbd hint, busy, disabled, link">
                  <Button size="sm">Small</Button>
                  <Button size="md" kbd="⌘↵">
                    Log note
                  </Button>
                  <Button size="lg" variant="primary">
                    Start your raise
                  </Button>
                  <Button busy="Saving…">Save changes</Button>
                  <Button disabled>Disabled</Button>
                  <ButtonLink href="#buttons">Connect an agent →</ButtonLink>
                </Row>
              </>
            )}
          </Specimen>
        </Section>

        <Section
          id="focus"
          title="Focus"
          note="Every interactive control shows a 2px cobalt ring on keyboard focus (:focus-visible). These specimens draw the ring statically so a regression is visible at a glance; bordered square buttons use a 1px offset so the ring doesn't read as a doubled box."
        >
          <Specimen>
            {() => (
              <Row label="Focused">
                <Button variant="primary" className="outline-2 outline-offset-2 outline-accent outline-solid">
                  Add investor
                </Button>
                <Button className="outline-2 outline-offset-2 outline-accent outline-solid">Import CSV</Button>
                <Button variant="ghost" className="outline-2 outline-offset-2 outline-accent outline-solid">
                  Cancel
                </Button>
                <button
                  type="button"
                  aria-label="Close (specimen)"
                  className="inline-flex size-28 items-center justify-center rounded-sm border border-line bg-transparent text-muted outline-2 outline-offset-1 outline-accent outline-solid"
                >
                  ✕
                </button>
                <span className="w-[200px]">
                  <Input defaultValue="Dana Whitfield" className="outline-2 outline-offset-2 outline-accent outline-solid" />
                </span>
                <Chip as="button" tone="due" className="outline-2 outline-offset-2 outline-accent outline-solid">
                  Mara Quist
                </Chip>
                <a href="#focus" className="link outline-2 outline-offset-2 outline-accent outline-solid">
                  Edit round
                </a>
              </Row>
            )}
          </Specimen>
        </Section>

        <Section id="fields" title="Fields" note="Canvas background inside forms and sheets; surface in toolbars. Errors carry the API code in mono.">
          <Specimen>
            {() => (
              <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
                <Field label="Email" hint="We send a one-time link. No password.">
                  <Input type="email" placeholder="you@company.com" />
                </Field>
                <Field label="Name" error={{ message: "Name is required.", code: "validation_error" }}>
                  <Input defaultValue="" />
                </Field>
                <Field label="Type">
                  <Select defaultValue="vc">
                    <option value="vc">VC</option>
                    <option value="angel">Angel</option>
                    <option value="family_office">Family Office</option>
                  </Select>
                </Field>
                <Field label="Target amount" optional>
                  <Input mono inputMode="numeric" defaultValue="2000000" />
                </Field>
                <Field label="Notes" className="sm:col-span-2">
                  <Textarea placeholder="Where you met, what they asked, what to send next…" />
                </Field>
                <div className="flex flex-col gap-8">
                  <Checkbox label="Read" hint="Always on." checked disabled readOnly />
                  <Checkbox label="Write" hint="Add and change investors, stages and notes." defaultChecked />
                  <Checkbox label="Admin" hint="Workspace settings and round deletion." />
                </div>
                <div className="flex flex-col gap-8">
                  <Radio name="dup" label="Skip existing" hint="Matched investors stay as they are." defaultChecked />
                  <Radio name="dup" label="Fill empty fields" hint="Only blanks are filled; tags are merged." />
                </div>
                <div className="flex flex-wrap gap-8 sm:col-span-2">
                  <SearchInput placeholder="Search name, firm, focus, notes…" aria-label="Search" />
                  <Select tone="toolbar" aria-label="Priority" className="w-auto">
                    <option>Any priority</option>
                    <option>Hot (fit 5)</option>
                  </Select>
                </div>
              </div>
            )}
          </Specimen>
        </Section>

        <Section id="chips" title="Chips and stages" note="Stage colors appear only as dots, funnel segments and column rules, never as fills behind text.">
          <Specimen>
            {() => (
              <>
                <Row label="Priority (from fit) + FitMeter">
                  {[5, 4, 3, 1].map((f) => (
                    <span key={f} className="inline-flex items-center gap-6">
                      <PriorityChip fit={f} />
                      <FitMeter value={f} />
                    </span>
                  ))}
                  <PriorityChip fit={4} showFit />
                </Row>
                <Row label="Type, tag, follow-up, money, agent, mode">
                  <Chip tone="type">VC</Chip>
                  <Chip tone="tag">robotics</Chip>
                  <Chip tone="industry">Logistics</Chip>
                  <FollowUpChip on="2026-10-08" state="overdue" today={TODAY} />
                  <FollowUpChip on={TODAY} state="today" today={TODAY} />
                  <FollowUpChip on="2026-10-14" state="soon" today={TODAY} />
                  <MoneyChip amount={250000} />
                  <MoneyChip amount={1500000} currency="EUR" />
                  <Chip tone="agent">by claude-code</Chip>
                  <Chip tone="mode">Sandbox</Chip>
                  <Chip tone="mode">Test</Chip>
                  <Chip as="button" tone="due">
                    Dana Whitfield
                  </Chip>
                </Row>
                <Row label="Stage dot + label">
                  {STAGES.map((s) => (
                    <StagePill key={s.key} color={s.color} label={s.label} />
                  ))}
                </Row>
              </>
            )}
          </Specimen>
          <div className="mt-12">
            <Specimen>{() => <InteractiveBits />}</Specimen>
          </div>
        </Section>

        <Section id="meters" title="Meters and funnel">
          <Specimen>
            {() => (
              <div className="flex flex-col gap-14">
                <Meter value={750_000} max={2_000_000} label="Committed toward Seed" />
                <Meter value={2_240_000} max={2_000_000} label="Committed toward Pre-seed" />
                <FunnelBar segments={STAGES} onSelect={setActiveStage} active={activeStage} />
              </div>
            )}
          </Specimen>
        </Section>

        <Section id="ledger" title="Ledger" note="Compact on the pipeline page, full on the overview. Stacks under 860px.">
          <Specimen>
            {() => (
              <Ledger
                roundName="Seed"
                currency="USD"
                committed={750_000}
                target={2_000_000}
                inConversation={18}
                committedCount={4}
                softCircled={400_000}
                weightedPipeline={160_000}
                daysToClose={41}
                funnel={STAGES}
                due={[
                  { id: "i1", name: "Dana Whitfield", state: "overdue" },
                  { id: "i3", name: "Priya Castellano", state: "today" },
                ]}
                dueTotal={5}
                onStageSelect={setActiveStage}
                activeStage={activeStage}
                onDueSelect={() => {}}
                variant="full"
              />
            )}
          </Specimen>
        </Section>

        <Section id="board" title="Board" note="Cards are buttons. The orchid diamond marks a card an agent changed in the last 24 hours (hover it).">
          <Specimen>
            {() => (
              <Board className="min-h-0">
                {STAGES.filter((s) => ["contacted", "meeting", "dd", "committed"].includes(s.key)).map((s) => {
                  const cards = CARDS.filter((c) => c.stage === s.key);
                  return (
                    <BoardColumn
                      key={s.key}
                      label={s.label}
                      color={s.color}
                      count={cards.length}
                      isDropTarget={s.key === "meeting"}
                      total={s.key === "committed" ? { amount: 250_000, currency: "USD" } : null}
                    >
                      {cards.map((c) => (
                        <BoardCard
                          key={c.id}
                          name={c.name}
                          title={c.title}
                          firm={c.firm}
                          fit={c.fit}
                          typeLabel={c.type}
                          industry={c.industry}
                          extraTagCount={c.extraTags}
                          followUpOn={c.followUpOn}
                          followUpState={c.followUpState}
                          today={TODAY}
                          amount={c.amount ? { value: c.amount, currency: "USD", soft: c.soft } : null}
                          nextStep={c.nextStep}
                          agentMark={c.agent ? { tip: c.agent } : null}
                          draggable
                        />
                      ))}
                    </BoardColumn>
                  );
                })}
                <BoardColumn label="Passed" color="gray" count={0} readOnly />
              </Board>
            )}
          </Specimen>
        </Section>

        <Section id="table" title="Table" note="Sticky mono heads, sortable columns with aria-sort, row hover in accent-soft, Enter opens a row. Agent-made rows get a 2px orchid rule.">
          <Specimen>
            {() => (
              <TableScroll>
                <Table minWidth={760}>
                  <THead>
                    <Tr>
                      <Th sort={sortOf("name")} onSort={() => toggle("name")}>
                        Investor
                      </Th>
                      <Th>Stage</Th>
                      <Th sort={sortOf("fit")} onSort={() => toggle("fit")}>
                        Fit
                      </Th>
                      <Th>Follow-up</Th>
                      <Th align="right" sort={sortOf("soft")} onSort={() => toggle("soft")}>
                        Soft
                      </Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {sorted.map((c) => {
                      const st = STAGES.find((s) => s.key === c.stage)!;
                      return (
                        <Tr key={c.id} onActivate={() => {}} agent={Boolean(c.agent)}>
                          <Td>
                            <b className="font-semibold">{c.name}</b>
                            <div className="t-micro text-muted">{c.title}</div>
                          </Td>
                          <Td>
                            <StagePill color={st.color} label={st.label} />
                          </Td>
                          <Td>
                            <span className="inline-flex items-center gap-6">
                              <PriorityChip fit={c.fit} />
                              <FitMeter value={c.fit} />
                            </span>
                          </Td>
                          <Td>
                            {c.followUpOn ? (
                              c.followUpState === "later" ? (
                                <span className="t-data text-muted">{formatDate(c.followUpOn, TODAY)}</span>
                              ) : (
                                <Chip tone={c.followUpState === "soon" ? "soon" : "due"}>{formatDate(c.followUpOn, TODAY)}</Chip>
                              )
                            ) : null}
                          </Td>
                          <Td variant="num" title={c.amount ? money(c.amount) : undefined}>
                            {c.amount ? moneyCompact(c.amount) : ""}
                          </Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </Specimen>
          <div className="mt-12">
            <Specimen>{() => <Pagination shown={200} total={1240} hasMore onLoadMore={() => {}} noun="investors" />}</Specimen>
          </div>
        </Section>

        <Section id="timeline" title="Timeline and actors" note="Agent entries get the orchid rule and tint, with the agent name and model. Users show their name; Raisebook system actions are muted.">
          <Specimen>
            {() => (
              <>
                <Row label="ActorName">
                  <ActorName actor={{ type: "agent", label: "claude-code", agent_model: "claude-opus-4-5" }} />
                  <ActorName actor={{ type: "user", label: "Sam Rivera" }} />
                  <ActorName actor={{ type: "system", label: "Raisebook" }} />
                  <AgentMarker label="Agent action" />
                </Row>
                <Timeline items={ACTIVITIES} timeZone={TZ} now={NOW} filterable />
              </>
            )}
          </Specimen>
        </Section>

        <Section id="nav" title="Navigation" note="The app uses a top bar so the board gets the full width. Under 900px the nav collapses into Menu and the round picker moves to a second row.">
          <Specimen stack>
            {() => (
              <div className="overflow-hidden rounded-md">
                <TopBar
                  workspace={{ slug: "kestrel", name: "Kestrel Robotics", is_sandbox: true, role: "owner" }}
                  workspaces={[
                    { slug: "kestrel", name: "Kestrel Robotics", is_sandbox: true, role: "owner" },
                    { slug: "tidewater", name: "Tidewater Labs", is_sandbox: false, role: "editor" },
                  ]}
                  rounds={[
                    { slug: "seed", name: "Seed", status: "open" },
                    { slug: "pre-seed-2025", name: "Pre-seed 2025", status: "closed" },
                  ]}
                  activeRound="seed"
                  roundHref={() => "#nav"}
                  newRoundHref="#nav"
                  nav={[
                    { key: "pipeline", label: "Pipeline", href: "#nav" },
                    { key: "overview", label: "Overview", href: "#nav" },
                    { key: "investors", label: "Investors", href: "#nav" },
                    { key: "settings", label: "Settings", href: "#nav" },
                  ]}
                  activeNav="pipeline"
                  user={{ name: "Sam Rivera", email: "sam@example.com" }}
                  homeHref="#nav"
                  workspaceHref={() => "#nav"}
                  newWorkspaceHref="#nav"
                  accountHref="#nav"
                  onSignOut={() => {}}
                />
              </div>
            )}
          </Specimen>
          <div className="mt-12">
            <Specimen>
              {() => (
                <>
                  <Row label="RoundPicker (overflow after 4)">
                    <RoundPicker
                      rounds={[
                        { slug: "seed", name: "Seed", status: "open" },
                        { slug: "bridge", name: "Bridge", status: "open" },
                        { slug: "angels", name: "Angels", status: "open" },
                        { slug: "strategic", name: "Strategic", status: "open" },
                        { slug: "pre-seed-2025", name: "Pre-seed 2025", status: "closed" },
                      ]}
                      active="seed"
                      hrefFor={() => "#nav"}
                      newRoundHref="#nav"
                    />
                  </Row>
                  <Row label="PageHeader">
                    <div className="w-full">
                      <PageHeader
                        className="mb-0"
                        title="Investors"
                        subline="212 contacts across 2 rounds"
                        actions={
                          <>
                            <Button>Import CSV</Button>
                            <Button variant="primary">Add investor</Button>
                          </>
                        }
                      />
                    </div>
                  </Row>
                </>
              )}
            </Specimen>
          </div>
        </Section>

        <Section id="overlays" title="Overlays" note="Sheet, dialog, confirm and toast open over the whole page, so they follow the page theme (use the theme control in the header).">
          <Specimen>{() => <OverlayDemos />}</Specimen>
        </Section>

        <Section id="code" title="Code and secrets" note="Code blocks are dark in both themes.">
          <Specimen>
            {() => (
              <div className="flex flex-col gap-12">
                <CodeBlock tabs={MCP_SNIPPETS} />
                <CodeBlock title="Terminal" lang="shell" code={`git clone https://github.com/gumruyanzh/raisebook && cd raisebook\ndocker compose -f deploy/docker-compose.yml up`} />
                <SecretReveal secret="rb_live_EXAMPLE_not_a_real_key_000000" />
              </div>
            )}
          </Specimen>
        </Section>

        <Section id="misc" title="Everything else">
          <Specimen>
            {() => (
              <div className="flex flex-col gap-16">
                <EmptyState
                  title="No investors in Seed yet"
                  actions={
                    <>
                      <Button>Import CSV</Button>
                      <Button variant="primary">Add investor</Button>
                      <ButtonLink href="#misc" variant="ghost">
                        Connect an agent →
                      </ButtonLink>
                    </>
                  }
                >
                  Import a spreadsheet, add them one at a time, or ask your agent.
                </EmptyState>
                <DefList
                  items={[
                    { term: "Invests at", value: "Pre-seed, Seed" },
                    { term: "Check size", value: "$250k–$1M, leads" },
                    { term: "Industries", value: "Robotics, Logistics" },
                    { term: "Location", value: "Oakland, CA" },
                    { term: "Source", value: "Bay Robotics Meetup 2026" },
                    { term: "Other rounds", value: "Pre-seed 2025 · Passed" },
                  ]}
                />
                <LinkButtons linkedin="https://www.linkedin.com/in/example-dana-whitfield" website="https://example.com" x="https://x.com/example" email="dana@example.com" />
                <FileDrop onText={() => {}} />
                <Row label="Kbd, Tooltip, Loading, Skeleton">
                  <Kbd>⌘</Kbd>
                  <Kbd>↵</Kbd>
                  <Kbd>Alt</Kbd>
                  <Kbd>M</Kbd>
                  <Tooltip tip="Moved by claude-code 2h ago">
                    <Button size="sm">Hover or focus me</Button>
                  </Tooltip>
                  <Loading>Loading pipeline…</Loading>
                </Row>
                <Skeleton lines={3} className="max-w-[320px]" />
                <Row label="Wordmark 20 · 22 · 28">
                  <Wordmark size={20} />
                  <Wordmark size={22} />
                  <Wordmark size={28} />
                </Row>
              </div>
            )}
          </Specimen>
        </Section>
      </main>
    </div>
  );
}
