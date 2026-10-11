"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  Button,
  Chip,
  Field,
  Input,
  SaveState,
  SectionLabel,
  Select,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { updateWorkspace } from "@/lib/api/core";
import type { Round, WorkspaceDetail } from "@/lib/api/types";
import { INSTRUMENT_LABEL, ROUND_STATUS_LABEL } from "@/lib/api/types";
import { money, num } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { CURRENCIES } from "../RoundForm";
import { NewRoundDialog } from "./NewRoundDialog";

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

/** Settings → General (SYSTEM §4.9): workspace name, timezone, currency, and the rounds list. */
export function GeneralSettings({ detail, rounds: initialRounds }: { detail: WorkspaceDetail; rounds: Round[] }) {
  const { workspace, client, role } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const isAdmin = role === "owner";
  const canWrite = role !== "viewer";
  const [name, setName] = useState(detail.name);
  const [tz, setTz] = useState(detail.timezone);
  const [currency, setCurrency] = useState(detail.default_currency);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const rounds = initialRounds;
  const zones = useMemo(() => timeZones(detail.timezone), [detail.timezone]);
  const newRound = params.get("new_round") === "1";

  useEffect(() => {
    try {
      setBrowserTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setBrowserTz(null);
    }
  }, []);

  const dirty = name.trim() !== detail.name || tz !== detail.timezone || currency !== detail.default_currency;

  const save = async () => {
    if (!name.trim()) {
      setError("The workspace needs a name.");
      return;
    }
    setState("saving");
    setError(null);
    try {
      await updateWorkspace(client, { name: name.trim(), timezone: tz, default_currency: currency });
      setState("saved");
      toast.show("Workspace settings saved.");
      router.refresh();
    } catch (err) {
      setState("error");
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    }
  };

  const closeNew = () => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("new_round");
    const s = sp.toString();
    router.replace(s ? `${pathname}?${s}` : (pathname ?? ""), { scroll: false });
  };

  const base = `/w/${encodeURIComponent(workspace.slug)}`;

  return (
    <div className="flex flex-col gap-32">
      <section aria-label="Workspace">
        <SectionLabel aside={<SaveState state={state} />}>Workspace</SectionLabel>
        <form
          className="rounded-md border border-line bg-surface p-16"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
            <Field label="Company name" className="sm:col-span-2" hint={isAdmin ? "Shown to members and on exports." : "Only owners can change workspace settings."}>
              <Input value={name} maxLength={80} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field
              label="Timezone"
              hint={
                browserTz && browserTz !== tz && isAdmin ? (
                  <>
                    Your browser is on <span className="font-mono">{browserTz}</span>.{" "}
                    <button type="button" className="link border-0 bg-transparent p-0" onClick={() => setTz(browserTz)}>
                      Use it
                    </button>
                  </>
                ) : (
                  "Follow-ups are due by this calendar."
                )
              }
            >
              <Select value={tz} disabled={!isAdmin} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default currency" hint="New rounds and check sizes use it.">
              <Select value={currency} disabled={!isAdmin} onChange={(e) => setCurrency(e.target.value)}>
                {(CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex min-w-0 flex-col gap-4">
              <span className="text-[12px] text-muted">Workspace URL</span>
              <span className="flex min-h-32 items-center gap-8">
                <span className="t-data truncate text-muted">/w/{workspace.slug}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(`${window.location.origin}/w/${workspace.slug}`);
                    toast.show("Link copied.");
                  }}
                >
                  Copy link
                </Button>
              </span>
            </div>
            <div className="flex flex-col gap-4">
              <span className="text-[12px] text-muted">Mode</span>
              <span className="flex h-32 items-center gap-8">
                {workspace.is_sandbox ? <Chip tone="mode">Sandbox</Chip> : <Chip tone="mode">Live</Chip>}
                <span className="t-body-s text-muted">{workspace.is_sandbox ? "Fictional sample data. Use rb_test_ keys." : "Your real raise. Use rb_live_ keys."}</span>
              </span>
            </div>
          </div>
          {isAdmin ? (
            <div className="mt-14 flex flex-wrap items-center gap-8">
              <Button type="submit" variant={dirty ? "primary" : "secondary"} disabled={!dirty} busy={state === "saving" ? "Saving…" : false}>
                Save changes
              </Button>
              {error ? <span className="t-body-s text-bad">{error}</span> : null}
            </div>
          ) : null}
        </form>
      </section>

      <section aria-label="Rounds">
        <SectionLabel
          aside={
            canWrite ? (
              <Button size="sm" onClick={() => router.replace(`${pathname}?new_round=1`, { scroll: false })}>
                New round
              </Button>
            ) : null
          }
        >
          Rounds
        </SectionLabel>
        {rounds.length === 0 ? (
          <p className="t-body-s text-muted">No rounds yet. Create one to start a pipeline.</p>
        ) : (
          <TableScroll>
            <Table minWidth={620}>
              <THead>
                <Tr>
                  <Th>Round</Th>
                  <Th>Status</Th>
                  <Th>Instrument</Th>
                  <Th align="right">Target</Th>
                  <Th align="right">Investors</Th>
                  <Th>
                    <span className="sr-only">Settings</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {rounds.map((r) => (
                  <Tr key={r.id} onActivate={() => router.push(`${base}/r/${encodeURIComponent(r.slug)}`)}>
                    <Td className="font-semibold">{r.name}</Td>
                    <Td variant="muted">{ROUND_STATUS_LABEL[r.status]}</Td>
                    <Td variant="muted">{INSTRUMENT_LABEL[r.instrument]}</Td>
                    <Td variant="num">{money(r.target_amount, r.currency)}</Td>
                    <Td variant="num">{num(r.participant_count)}</Td>
                    <Td className="text-right">
                      <Link href={`${base}/r/${encodeURIComponent(r.slug)}/settings`} className="link t-body-s">
                        Round settings
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </section>

      <NewRoundDialog
        open={newRound && canWrite}
        onClose={closeNew}
        client={client}
        defaultCurrency={detail.default_currency}
        existingNames={rounds.map((r) => r.name)}
        onCreated={(r) => {
          router.push(`${base}/r/${encodeURIComponent(r.slug)}`);
          router.refresh();
        }}
      />
    </div>
  );
}
