"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";

import {
  Button,
  Dialog,
  Field,
  Input,
  SaveState,
  SectionLabel,
  Select,
  StageDot,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from "@/components/ui";
import { ApiError, errorMessage, type ApiClient } from "@/lib/api/client";
import { replaceStages, sortedStages } from "@/lib/api/rounds";
import type { Round, StageColor, StageInput, StageKind } from "@/lib/api/types";
import { STAGE_COLORS } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";

interface Row {
  /** Existing stage key; new rows have none (the API derives it from the label). */
  key?: string;
  uid: string;
  label: string;
  color: StageColor;
  kind: StageKind;
  count: number;
}

const KIND_LABEL: Record<StageKind, string> = {
  open: "Not contacted yet",
  active: "In conversation",
  won: "Committed (won)",
  lost: "Passed (lost)",
};

const COLOR_LABEL: Record<StageColor, string> = {
  slate: "Slate",
  violet: "Violet",
  cobalt: "Cobalt",
  teal: "Teal",
  amber: "Amber",
  orange: "Orange",
  green: "Green",
  gray: "Gray",
  olive: "Olive",
  sky: "Sky",
};

function rowsFrom(round: Round): Row[] {
  return sortedStages(round.stages).map((s) => ({
    key: s.key,
    uid: s.key,
    label: s.label,
    color: s.color,
    kind: s.kind,
    count: s.count ?? 0,
  }));
}

function validate(rows: Row[]): string | null {
  if (rows.length < 3 || rows.length > 16) return "A round needs between 3 and 16 stages.";
  if (rows.some((r) => !r.label.trim())) return "Every stage needs a label.";
  const labels = rows.map((r) => r.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) return "Two stages have the same label.";
  if (rows.filter((r) => r.kind === "won").length !== 1) return "Exactly one stage must be the committed (won) stage.";
  if (rows.filter((r) => r.kind === "lost").length !== 1) return "Exactly one stage must be the passed (lost) stage.";
  if (!rows.some((r) => r.kind === "open" || r.kind === "active")) return "Keep at least one stage before Committed.";
  return null;
}

/**
 * The stages editor (SYSTEM §4.6): reorder (drag or ↑/↓), rename, recolor, change kind, add
 * and remove. Removing a stage that has investors asks where to move them. Save replaces the
 * list in one call (`PUT /stages`).
 */
export function StagesEditor({
  client,
  round,
  canWrite,
  onSaved,
}: {
  client: ApiClient;
  round: Round;
  canWrite: boolean;
  onSaved: (r: Round) => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(round));
  const [reassign, setReassign] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<Row | null>(null);
  const [target, setTarget] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [seq, setSeq] = useState(1);

  useEffect(() => {
    setRows(rowsFrom(round));
    setReassign({});
  }, [round]);

  const original = useMemo(() => JSON.stringify(rowsFrom(round).map(({ key, label, color, kind }) => ({ key, label, color, kind }))), [round]);
  const current = JSON.stringify(rows.map(({ key, label, color, kind }) => ({ key, label, color, kind })));
  const dirty = original !== current || Object.keys(reassign).length > 0;
  const problem = validate(rows);
  const ro = !canWrite;

  const update = (uid: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const moveBy = (uid: string, d: number) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.uid === uid);
      const j = i + d;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const n = [...rs];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const moveTo = (uid: string, overUid: string) =>
    setRows((rs) => {
      const from = rs.findIndex((r) => r.uid === uid);
      const to = rs.findIndex((r) => r.uid === overUid);
      if (from < 0 || to < 0 || from === to) return rs;
      const n = [...rs];
      const [item] = n.splice(from, 1);
      n.splice(to, 0, item!);
      return n;
    });

  const remove = (r: Row) => {
    if (r.key && r.count > 0) {
      setRemoving(r);
      setTarget(rows.find((x) => x.uid !== r.uid && x.key)?.key ?? "");
      return;
    }
    setRows((rs) => rs.filter((x) => x.uid !== r.uid));
  };

  const add = () => {
    setRows((rs) => {
      const lostAt = rs.findIndex((r) => r.kind === "won");
      const row: Row = { uid: `new-${seq}`, label: "", color: "sky", kind: "active", count: 0 };
      const n = [...rs];
      n.splice(lostAt < 0 ? n.length : lostAt, 0, row);
      return n;
    });
    setSeq((s) => s + 1);
  };

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setState("saving");
    setError(null);
    const body: StageInput[] = rows.map((r) => ({ ...(r.key ? { key: r.key } : {}), label: r.label.trim(), color: r.color, kind: r.kind }));
    const kept = new Set(rows.map((r) => r.key).filter(Boolean));
    const re = Object.fromEntries(Object.entries(reassign).filter(([k, v]) => !kept.has(k) && kept.has(v)));
    try {
      const r = await replaceStages(client, round.id, body, Object.keys(re).length ? re : undefined);
      setState("saved");
      toast.show(`Stages for ${round.name} saved.`);
      onSaved(r);
    } catch (err) {
      setState("error");
      if (err instanceof ApiError && err.code === "stage_in_use") {
        setError(`${err.message} Remove the stage again and pick where its investors go.`);
      } else setError(errorMessage(err));
    }
  };

  const onDragOver = (e: DragEvent, uid: string) => {
    if (!dragUid || ro) return;
    e.preventDefault();
    if (dragUid !== uid) moveTo(dragUid, uid);
  };

  return (
    <section aria-label="Stages">
      <SectionLabel aside={<SaveState state={state} />}>Stages</SectionLabel>
      <p className="t-body-s mb-10 max-w-[68ch] text-muted">
        The board shows one column per stage, in this order. The committed stage counts money toward the target; the
        passed stage is left out of the pipeline totals.
      </p>
      <TableScroll>
        <Table minWidth={720} stack>
          <THead>
            <Tr>
              <Th className="w-[72px]">Order</Th>
              <Th>Label</Th>
              <Th>Color</Th>
              <Th>Kind</Th>
              <Th align="right">Investors</Th>
              <Th>
                <span className="sr-only">Remove</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r, i) => (
              <Tr
                key={r.uid}
                draggable={!ro}
                onDragStart={(e) => {
                  setDragUid(r.uid);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", r.uid);
                }}
                onDragOver={(e) => onDragOver(e, r.uid)}
                onDragEnd={() => setDragUid(null)}
                className={cn("[&>td]:align-middle!", dragUid === r.uid && "opacity-50")}
              >
                <Td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className={cn("t-micro w-14 select-none text-muted", !ro && "cursor-grab")} title="Drag to reorder">
                      ⠿
                    </span>
                    <button
                      type="button"
                      aria-label={`Move ${r.label || "stage"} up`}
                      disabled={ro || i === 0}
                      onClick={() => moveBy(r.uid, -1)}
                      className="inline-flex size-24 items-center justify-center rounded-sm border-0 bg-transparent text-muted hover:bg-sunk hover:text-fg disabled:opacity-30 touch:size-44 touch:border touch:border-line"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${r.label || "stage"} down`}
                      disabled={ro || i === rows.length - 1}
                      onClick={() => moveBy(r.uid, 1)}
                      className="inline-flex size-24 items-center justify-center rounded-sm border-0 bg-transparent text-muted hover:bg-sunk hover:text-fg disabled:opacity-30 touch:size-44 touch:border touch:border-line"
                    >
                      ↓
                    </button>
                  </span>
                </Td>
                <Td>
                  <Input
                    size="sm"
                    aria-label="Stage label"
                    title={r.key ? `Key: ${r.key} (used by agents and imports; it never changes)` : "New stage"}
                    value={r.label}
                    maxLength={40}
                    disabled={ro}
                    placeholder="Partner meeting"
                    onChange={(e) => update(r.uid, { label: e.target.value })}
                  />
                </Td>
                <Td>
                  <span className="flex items-center gap-8">
                    <StageDot color={r.color} />
                    <Select size="sm" aria-label="Stage color" value={r.color} disabled={ro} onChange={(e) => update(r.uid, { color: e.target.value as StageColor })}>
                      {STAGE_COLORS.map((c) => (
                        <option key={c} value={c}>
                          {COLOR_LABEL[c]}
                        </option>
                      ))}
                    </Select>
                  </span>
                </Td>
                <Td>
                  <Select size="sm" aria-label="Stage kind" value={r.kind} disabled={ro} onChange={(e) => update(r.uid, { kind: e.target.value as StageKind })}>
                    {(Object.keys(KIND_LABEL) as StageKind[]).map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td variant="num">{num(r.count)}</Td>
                <Td className="text-right">
                  {(() => {
                    // The only committed or passed stage can't go: every round needs one of each.
                    const sole =
                      (r.kind === "won" || r.kind === "lost") && rows.filter((x) => x.kind === r.kind).length <= 1;
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ro || sole}
                        title={sole ? "Every round needs one committed and one passed stage" : undefined}
                        onClick={() => remove(r)}
                      >
                        Remove
                      </Button>
                    );
                  })()}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </TableScroll>
      <div className="mt-10 flex flex-wrap items-center gap-8">
        <Button size="sm" disabled={ro || rows.length >= 16} onClick={add}>
          Add stage
        </Button>
        <Button
          variant={dirty ? "primary" : "secondary"}
          size="sm"
          disabled={ro || !dirty}
          busy={state === "saving" ? "Saving…" : false}
          onClick={() => void save()}
        >
          Save stages
        </Button>
        {dirty ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRows(rowsFrom(round));
              setReassign({});
              setError(null);
            }}
          >
            Discard changes
          </Button>
        ) : null}
        {problem && dirty ? <span className="t-body-s text-warm-ink">{problem}</span> : null}
      </div>
      {error ? <p className="t-body-s mt-8 text-bad">{error}</p> : null}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Move its ${num(removing?.count ?? 0)} investors to…`}
        description={`${removing?.label ?? "This stage"} still has investors. Pick the stage they move to when you save.`}
        onSubmit={() => {
          if (!removing?.key || !target) return;
          setReassign((m) => ({ ...m, [removing.key!]: target }));
          setRows((rs) => rs.filter((x) => x.uid !== removing.uid));
          setRemoving(null);
        }}
        actions={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!target}>
              Remove stage
            </Button>
          </>
        }
      >
        <Field label="Move them to">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {rows
              .filter((x) => x.uid !== removing?.uid && x.key)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
          </Select>
        </Field>
      </Dialog>
    </section>
  );
}
