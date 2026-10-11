"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ActorName,
  Button,
  ButtonLink,
  ConfirmDialog,
  SectionLabel,
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
import { deleteWorkspace } from "@/lib/api/core";
import { downloadExport, type ExportKind, type ImportRun } from "@/lib/api/data";
import { formatDateTime, num, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

/**
 * Settings → Data (SYSTEM §4.9): the last imports, every export, and the danger zone
 * (delete the workspace with the slug typed). Exports download in the browser with the
 * session; nothing goes through a third party.
 */
export function DataSettings({
  runs,
  investorCount,
  keyCount,
}: {
  runs: ImportRun[];
  investorCount: number | null;
  keyCount: number | null;
}) {
  const { workspace, rounds, client, canWrite, isOwner } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const download = async (id: string, kind: ExportKind) => {
    setBusy(id);
    setExportErr(null);
    try {
      const name = await downloadExport(client, kind);
      toast.show(`Downloaded ${name}.`);
    } catch (e) {
      setExportErr(e instanceof ApiError ? `${e.message} (${e.code})` : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteWorkspace(client, workspace.slug);
      router.push("/app");
      router.refresh();
    } catch (e) {
      setDeleteErr(e instanceof ApiError ? `${e.message} (${e.code})` : errorMessage(e));
      setDeleting(false);
    }
  };

  const contents = [
    plural(rounds.length, "round"),
    investorCount != null ? `${plural(investorCount, "investor")} with their timelines` : "every investor and timeline",
    keyCount != null ? plural(keyCount, "API key") : "every API key",
  ].join(", ");

  return (
    <div className="flex flex-col gap-32">
      <section aria-labelledby="data-import">
        <SectionLabel
          id="data-import"
          aside={
            canWrite ? (
              <ButtonLink href={`/w/${workspace.slug}/import`} size="sm">
                Import CSV
              </ButtonLink>
            ) : null
          }
        >
          Import
        </SectionLabel>
        <p className="mb-10 text-muted">
          Bring investors in from a spreadsheet (CSV) or a Raisebook prototype JSON file. Duplicates are matched by
          email, LinkedIn, then name and firm.
        </p>
        {runs.length ? (
          <TableScroll>
            <Table minWidth={640}>
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>File</Th>
                  <Th>Round</Th>
                  <Th>By</Th>
                  <Th align="right">Created</Th>
                  <Th align="right">Updated</Th>
                  <Th align="right">Errors</Th>
                </Tr>
              </THead>
              <TBody>
                {runs.map((r) => (
                  <Tr key={r.id} agent={r.actor_type === "agent"}>
                    <Td className="t-data whitespace-nowrap text-muted">
                      {formatDateTime(r.created_at, workspace.timezone)}
                    </Td>
                    <Td className="max-w-[220px] truncate" title={r.filename ?? undefined}>
                      {r.filename ?? <span className="text-muted">{r.format === "csv" ? "Pasted CSV" : "Prototype JSON"}</span>}
                    </Td>
                    <Td>{r.round_name ?? <span className="text-muted">Contacts only</span>}</Td>
                    <Td>
                      <ActorName actor={{ type: r.actor_type, label: r.actor_label }} />
                    </Td>
                    <Td variant="num">{num(r.counts.created ?? 0)}</Td>
                    <Td variant="num">{num(r.counts.updated ?? 0)}</Td>
                    <Td variant="num" className={(r.counts.errors ?? 0) > 0 ? "text-bad" : undefined}>
                      {num(r.counts.errors ?? 0)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        ) : (
          <p className="t-body-s text-muted">No imports yet.</p>
        )}
      </section>

      <section aria-labelledby="data-export">
        <SectionLabel id="data-export">Export</SectionLabel>
        <p className="mb-10 text-muted">
          Your data is yours. Download everything at any time; API keys, sessions and sign-in tokens are never
          included.
        </p>
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          <ExportRow
            title="Whole workspace"
            detail="JSON: rounds, stages, investors, participants, the full timeline, members and import history."
            label="Download JSON"
            busy={busy === "ws"}
            onClick={() => void download("ws", { kind: "workspace" })}
          />
          <ExportRow
            title="All investors"
            detail="CSV: every contact with a column listing their rounds and stages."
            label="Download CSV"
            busy={busy === "inv"}
            onClick={() => void download("inv", { kind: "investors" })}
          />
          {rounds.map((r) => (
            <ExportRow
              key={r.id}
              title={r.name}
              detail={`CSV of the pipeline (${plural(r.participant_count, "investor")}). It re-imports unchanged.`}
              label="Download CSV"
              secondary={{
                label: "Download JSON",
                busy: busy === `${r.id}:json`,
                onClick: () =>
                  void download(`${r.id}:json`, {
                    kind: "round",
                    round: r.slug,
                    format: "json",
                    includeActivities: true,
                  }),
              }}
              busy={busy === r.id}
              onClick={() => void download(r.id, { kind: "round", round: r.slug, format: "csv" })}
            />
          ))}
        </ul>
        {exportErr ? (
          <p role="alert" className="t-body-s mt-8 text-bad">
            {exportErr}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="data-danger" className="rounded-md border border-bad p-16">
        <h2 id="data-danger" className="t-label text-bad">
          Danger zone
        </h2>
        <div className="mt-8 flex flex-wrap items-start justify-between gap-12">
          <div className="max-w-[64ch]">
            <p className="font-medium">Delete workspace</p>
            <p className="mt-2 text-muted">
              Everything in {workspace.name} is deleted immediately and permanently: {contents}. Backups expire within
              14 days. Export first if you want a copy.
            </p>
          </div>
          {isOwner ? (
            <Button variant="danger-quiet" onClick={() => setConfirm(true)}>
              Delete workspace…
            </Button>
          ) : (
            <p className="t-body-s text-muted">Only an owner can delete the workspace.</p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={remove}
        title={`Delete ${workspace.name}?`}
        confirmLabel="Delete workspace permanently"
        typed={workspace.slug}
        busy={deleting}
        error={deleteErr}
      >
        Everything in {workspace.name} is deleted immediately: {contents}. This can&apos;t be undone.
      </ConfirmDialog>
    </div>
  );
}

function ExportRow({
  title,
  detail,
  label,
  busy,
  onClick,
  secondary,
}: {
  title: string;
  detail: string;
  label: string;
  busy: boolean;
  onClick: () => void;
  secondary?: { label: string; busy: boolean; onClick: () => void };
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-16 gap-y-8 px-14 py-12">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="t-body-s text-muted">{detail}</p>
      </div>
      <div className="flex gap-8">
        {secondary ? (
          <Button size="sm" onClick={secondary.onClick} busy={secondary.busy ? "Preparing…" : false}>
            {secondary.label}
          </Button>
        ) : null}
        <Button size="sm" onClick={onClick} busy={busy ? "Preparing…" : false}>
          {label}
        </Button>
      </div>
    </li>
  );
}
