"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
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
import { errorMessage } from "@/lib/api/client";
import { listApiKeys, revokeApiKey } from "@/lib/api/settings";
import type { ApiKey } from "@/lib/api/types";
import { SCOPE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate, num, relativeTime } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { CreateKeyDialog } from "./CreateKeyDialog";

/** Settings → API keys (SYSTEM §4.9). Owners create and revoke; secrets are shown once. */
export function ApiKeysSettings({ keys: k0, today }: { keys: ApiKey[] | null; today: string }) {
  const { workspace, client, isOwner } = useWorkspace();
  const toast = useToast();
  const [keys, setKeys] = useState(k0 ?? []);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/w/${encodeURIComponent(workspace.slug)}`;

  if (k0 === null) {
    return (
      <EmptyState title="Only owners manage API keys">
        Ask an owner of {workspace.name} for a key, or for the owner role.
      </EmptyState>
    );
  }

  const reload = async () => {
    try {
      setKeys((await listApiKeys(client)).data);
    } catch (e) {
      toast.show(errorMessage(e));
    }
  };

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);
  const now = new Date();

  const rows = (list: ApiKey[], dim?: boolean) =>
    list.map((k) => {
      const expired = k.expires_at ? new Date(k.expires_at) < now : false;
      return (
        <Tr key={k.id} className={dim ? "opacity-60 [&>td]:align-middle!" : "[&>td]:align-middle!"}>
          <Td className="font-medium">{k.name}</Td>
          <Td className="t-data text-agent">{k.agent_name ?? ""}</Td>
          <Td className="t-data whitespace-nowrap">{k.key_prefix}…</Td>
          <Td>
            <span className="flex flex-wrap gap-4">
              {k.scopes.map((s) => (
                <Chip key={s} tone="tag">
                  {SCOPE_LABEL[s]}
                </Chip>
              ))}
            </span>
          </Td>
          <Td>
            <Chip tone="mode">{k.mode}</Chip>
          </Td>
          <Td variant="muted">{k.created_by ?? ""}</Td>
          <Td className="t-data whitespace-nowrap text-muted" title={k.last_used_at ?? undefined}>
            {k.revoked_at
              ? `Revoked ${formatDate(isoDate(k.revoked_at, workspace.timezone), today)}`
              : expired
                ? "Expired"
                : k.last_used_at
                  ? relativeTime(k.last_used_at, now, workspace.timezone)
                  : "Never"}
          </Td>
          <Td className="text-right">
            {!k.revoked_at && isOwner ? (
              <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                Revoke
              </Button>
            ) : null}
          </Td>
        </Tr>
      );
    });

  return (
    <div className="flex max-w-[1040px] flex-col gap-24">
      <section aria-label="API keys">
        <SectionLabel
          aside={
            isOwner ? (
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Create key
              </Button>
            ) : null
          }
        >
          API keys · {num(active.length)} of 20
        </SectionLabel>
        <p className="t-body-s mb-10 max-w-[68ch] text-muted">
          A key lets an agent or script work in {workspace.name}, and nowhere else. Everything it does shows on the
          timeline under its agent name. To set one up in Claude Code, Codex or Cursor, use{" "}
          <Link href={`${base}/settings/mcp`} className="link">
            Connect an agent
          </Link>
          .
        </p>
        {keys.length === 0 ? (
          <EmptyState
            title="No keys yet"
            actions={
              isOwner ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Create key
                </Button>
              ) : null
            }
          >
            Create one for each agent or machine, so you can revoke them one at a time.
          </EmptyState>
        ) : (
          <TableScroll>
            <Table minWidth={900}>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Agent name</Th>
                  <Th>Prefix</Th>
                  <Th>Scopes</Th>
                  <Th>Mode</Th>
                  <Th>Created by</Th>
                  <Th>Last used</Th>
                  <Th>
                    <span className="sr-only">Revoke</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {rows(active)}
                {rows(revoked, true)}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </section>

      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        client={client}
        onCreated={(k) => setKeys((list) => [k, ...list])}
      />

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        busy={busy}
        busyLabel="Revoking…"
        error={err}
        title={`Revoke ${revoking?.name ?? "key"}?`}
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          setBusy(true);
          setErr(null);
          try {
            await revokeApiKey(client, revoking.id);
            toast.show(`${revoking.name} revoked. Agents using it stop working now.`);
            setRevoking(null);
            await reload();
          } catch (e) {
            setErr(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Any agent using <span className="font-mono text-sm">{revoking?.key_prefix}…</span> loses access immediately.
          Its past actions stay on the timeline.
        </p>
      </ConfirmDialog>
    </div>
  );
}
