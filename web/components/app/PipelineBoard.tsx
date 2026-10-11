"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { Board, BoardCard, BoardColumn, Menu, StageDot } from "@/components/ui";
import type { Investor, Participant, Round, Stage } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";

import { byFit } from "./util";

export interface AgentMark {
  label: string;
  tip: string;
}

const PAGE = 60;

/**
 * The pipeline board (SYSTEM §4.2, §4.3): one column per stage, cards ordered by fit. Pointer
 * users drag cards between columns; keyboard users press Alt+→ / Alt+← (skips the lost stage)
 * or M for the "Move to…" menu. Moves are optimistic; the parent owns the write and the Undo.
 */
export function PipelineBoard({
  round,
  stages,
  participants,
  investors,
  agentMarks,
  today,
  canWrite,
  onOpen,
  onMove,
}: {
  round: Round;
  stages: Stage[];
  participants: Participant[];
  investors: Record<string, Investor>;
  agentMarks: Record<string, AgentMark>;
  today: string;
  canWrite: boolean;
  onOpen: (investorId: string) => void;
  /** Returns false when the move failed (the card snaps back). */
  onMove: (investorId: string, stageKey: string) => Promise<boolean>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});
  const boardRef = useRef<HTMLDivElement>(null);
  // The lost stage (Passed) starts as a 44px rail from 640px up, so the stages that matter fit.
  const [lostOpen, setLostOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [fade, setFade] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const updateFade = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    setFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);
  useEffect(() => {
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [updateFade, lostOpen, wide, stages.length]);
  const collapsedKey = wide && !lostOpen ? (stages.find((s) => s.kind === "lost")?.key ?? null) : null;
  const columns = collapsedKey
    ? stages.map((s) => (s.key === collapsedKey ? "44px" : "minmax(var(--col-min), 1fr)")).join(" ")
    : undefined;

  const byStage = useMemo(() => {
    const m: Record<string, Participant[]> = {};
    for (const s of stages) m[s.key] = [];
    for (const p of participants) (m[p.stage.key] ??= []).push(p);
    for (const k of Object.keys(m)) m[k]!.sort(byFit);
    return m;
  }, [stages, participants]);

  // Keyboard path skips the lost stage (reachable only through the menu).
  const keyPath = useMemo(() => stages.filter((s) => s.kind !== "lost"), [stages]);

  const focusCard = useCallback((investorId: string) => {
    requestAnimationFrame(() => {
      boardRef.current
        ?.querySelector<HTMLButtonElement>(`[data-investor="${CSS.escape(investorId)}"]`)
        ?.focus();
    });
  }, []);

  const move = useCallback(
    async (investorId: string, key: string) => {
      const p = participants.find((x) => x.investor.id === investorId);
      if (!p || p.stage.key === key) return;
      // Make sure the card is visible in its new column.
      const target = byStage[key]?.length ?? 0;
      setShown((s) => ({ ...s, [key]: Math.max(s[key] ?? PAGE, target + 1) }));
      await onMove(investorId, key);
      focusCard(investorId);
    },
    [participants, byStage, onMove, focusCard],
  );

  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, p: Participant) => {
    if (!canWrite) return;
    if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const i = keyPath.findIndex((s) => s.key === p.stage.key);
      // From the lost stage, Alt+← goes back to the last open/active stage.
      const from = i < 0 ? keyPath.length : i;
      const next = keyPath[from + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) void move(p.investor.id, next.key);
      return;
    }
    if ((e.key === "m" || e.key === "M") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setMenuFor(p.investor.id);
    }
  };

  const drop = (e: DragEvent, key: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setOverKey(null);
    setDragId(null);
    if (id) void move(id, key);
  };

  return (
    <div className="relative">
    <Board ref={boardRef} aria-label={`${round.name} board`} columns={columns} onScroll={updateFade}>
      {stages.map((s) => {
        const cards = byStage[s.key] ?? [];
        const limit = shown[s.key] ?? PAGE;
        const total =
          s.kind === "won"
            ? cards.reduce((sum, p) => sum + (p.amount_committed ?? 0), 0)
            : 0;
        return (
          <BoardColumn
            key={s.key}
            collapsed={s.key === collapsedKey}
            onExpand={() => setLostOpen(true)}
            onCollapse={wide && s.kind === "lost" && lostOpen ? () => setLostOpen(false) : undefined}
            label={s.label}
            color={s.color}
            count={cards.length}
            total={s.kind === "won" ? { amount: total, currency: round.currency } : null}
            readOnly={!canWrite}
            isDropTarget={overKey === s.key && dragId !== null}
            hiddenCount={Math.max(0, cards.length - limit)}
            onShowMore={() => setShown((x) => ({ ...x, [s.key]: limit + PAGE }))}
            onDragOver={
              canWrite
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overKey !== s.key) setOverKey(s.key);
                  }
                : undefined
            }
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverKey((k) => (k === s.key ? null : k));
            }}
            onDrop={canWrite ? (e) => drop(e, s.key) : undefined}
          >
            {cards.slice(0, limit).map((p) => {
              const inv = investors[p.investor.id];
              const industry = inv?.industries[0] ?? null;
              const tagCount = (inv?.industries.length ?? 0) + p.investor.tags.length - (industry ? 1 : 0);
              const amount =
                s.kind === "won" && p.amount_committed
                  ? { value: p.amount_committed, currency: round.currency }
                  : p.amount_soft
                    ? { value: p.amount_soft, currency: round.currency, soft: true }
                    : null;
              const id = p.investor.id;
              return (
                <div key={id} className="relative">
                  <BoardCard
                    data-investor={id}
                    name={p.investor.name}
                    title={p.investor.title}
                    firm={p.investor.firm}
                    fit={p.fit}
                    typeLabel={INVESTOR_TYPE_LABEL[p.investor.type]}
                    industry={industry}
                    extraTagCount={Math.max(0, tagCount)}
                    followUpOn={p.follow_up_on}
                    followUpState={p.follow_up_state}
                    today={today}
                    amount={amount}
                    nextStep={p.next_step}
                    agentMark={agentMarks[id] ? { tip: agentMarks[id].tip } : null}
                    dragging={dragId === id}
                    draggable={canWrite}
                    hint={canWrite ? undefined : "View only"}
                    aria-keyshortcuts={canWrite ? "Alt+ArrowRight Alt+ArrowLeft M" : undefined}
                    aria-label={`${p.investor.name}${p.investor.firm ? `, ${p.investor.firm}` : ""}. ${s.label}.`}
                    onClick={() => onOpen(id)}
                    onKeyDown={(e) => onCardKey(e, p)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverKey(null);
                    }}
                  />
                  {menuFor === id ? (
                    <Menu
                      label={`Move ${p.investor.name} to`}
                      open
                      onOpenChange={(o) => {
                        if (!o) {
                          setMenuFor(null);
                          focusCard(id);
                        }
                      }}
                      className="absolute! inset-x-0 top-full h-0"
                      items={[
                        { type: "label", label: "Move to" },
                        ...stages.map((st) => ({
                          label: st.label,
                          icon: <StageDot color={st.color} />,
                          selected: st.key === p.stage.key,
                          onSelect: () => {
                            setMenuFor(null);
                            void move(id, st.key);
                          },
                        })),
                      ]}
                    />
                  ) : null}
                </div>
              );
            })}
          </BoardColumn>
        );
      })}
    </Board>
      {fade ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 bottom-8 w-48 bg-linear-to-l from-canvas to-transparent"
        />
      ) : null}
    </div>
  );
}
