"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  CodeBlock,
  ConfirmDialog,
  Field,
  Input,
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
import { changeMemberRole, createInvite, listInvites, listMembers, removeMember, revokeInvite } from "@/lib/api/settings";
import type { Invite, Member, Role } from "@/lib/api/types";
import { ROLE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate, num } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

import { personName } from "../util";

const ROLES: Role[] = ["owner", "editor", "viewer"];
const ROLE_HINT: Record<Role, string> = {
  owner: "Everything, including members, API keys and deleting the workspace.",
  editor: "Works the pipeline: investors, stages, follow-ups, imports.",
  viewer: "Reads everything, changes nothing. Good for an advisor.",
};

/** Settings → Members (SYSTEM §4.9): members, pending invites, and the invite form. */
export function MembersSettings({ members: m0, invites: i0, today }: { members: Member[]; invites: Invite[] | null; today: string }) {
  const { workspace, client, isOwner } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState(m0);
  const [invites, setInvites] = useState(i0 ?? []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Member | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveErr, setLeaveErr] = useState<string | null>(null);
  const [demoting, setDemoting] = useState<{ member: Member; role: Role } | null>(null);
  const ownerCount = members.filter((x) => x.role === "owner").length;
  const isLastOwner = (mb: Member) => mb.role === "owner" && ownerCount <= 1;
  const keysLine = (mb: Member) => {
    const n = mb.active_api_keys ?? 0;
    if (!n) return null;
    return `${n} active API ${n === 1 ? "key" : "keys"} created by ${mb.is_you ? "you" : "this person"} will be revoked.`;
  };

  const reload = async () => {
    try {
      const [ms, is] = await Promise.all([listMembers(client), isOwner ? listInvites(client) : Promise.resolve({ data: [] })]);
      setMembers(ms.data);
      setInvites(is.data);
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };

  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setDevLink(null);
    try {
      const inv = await createInvite(client, email.trim(), role);
      setEmail("");
      toast.show(`Invite sent to ${inv.email}.`);
      setDevLink(inv.dev_link ?? null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const setMemberRole = async (mb: Member, r: Role, confirmed = false) => {
    if (!confirmed && mb.role === "owner" && r !== "owner" && (mb.active_api_keys ?? 0) > 0) {
      setDemoting({ member: mb, role: r });
      return;
    }
    try {
      const updated = await changeMemberRole(client, mb.user_id, r);
      setMembers((list) => list.map((x) => (x.user_id === mb.user_id ? updated : x)));
      toast.show(`${personName(mb)} is now ${ROLE_LABEL[r].toLowerCase()}.`);
      if (mb.is_you) router.refresh();
    } catch (err) {
      toast.show(errorMessage(err));
    }
  };

  const confirmRemove = async () => {
    if (!leaving) return;
    setLeaveBusy(true);
    setLeaveErr(null);
    try {
      await removeMember(client, leaving.user_id);
      if (leaving.is_you) {
        toast.show(`You left ${workspace.name}.`);
        router.replace("/app");
        router.refresh();
        return;
      }
      toast.show(`${personName(leaving)} was removed.`);
      setLeaving(null);
      await reload();
    } catch (err) {
      setLeaveErr(errorMessage(err));
    } finally {
      setLeaveBusy(false);
    }
  };

  const pending = invites.filter((i) => i.status === "pending");

  return (
    <div className="flex flex-col gap-32">
      <section aria-label="Members">
        <SectionLabel aside={<span className="t-micro text-muted">{num(members.length)} of 20</span>}>Members</SectionLabel>
        <TableScroll>
          <Table minWidth={640}>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Joined</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {members.map((mb) => (
                <Tr key={mb.user_id} className="[&>td]:align-middle!">
                  <Td className="font-medium">
                    {personName(mb)}
                    {mb.is_you ? <span className="t-body-s text-muted"> (you)</span> : null}
                  </Td>
                  <Td className="t-data">{mb.email}</Td>
                  <Td>
                    {isOwner ? (
                      <Select
                        size="sm"
                        aria-label={`Role for ${personName(mb)}`}
                        value={mb.role}
                        disabled={isLastOwner(mb)}
                        title={isLastOwner(mb) ? "Transfer ownership first: make another member an owner." : undefined}
                        onChange={(e) => void setMemberRole(mb, e.target.value as Role)}
                        className="w-auto!"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      ROLE_LABEL[mb.role]
                    )}
                  </Td>
                  <Td className="t-data whitespace-nowrap text-muted">{formatDate(isoDate(mb.joined_at, workspace.timezone), today)}</Td>
                  <Td className="text-right">
                    {mb.is_you ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isLastOwner(mb)}
                        title={isLastOwner(mb) ? "Transfer ownership first: make another member an owner." : undefined}
                        onClick={() => setLeaving(mb)}
                      >
                        Leave
                      </Button>
                    ) : isOwner ? (
                      <Button size="sm" variant="ghost" onClick={() => setLeaving(mb)}>
                        Remove
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      </section>

      {isOwner ? (
        <>
          <section aria-label="Pending invites">
            <SectionLabel>Pending invites</SectionLabel>
            {pending.length === 0 ? (
              <p className="t-body-s text-muted">No pending invites.</p>
            ) : (
              <TableScroll>
                <Table minWidth={560}>
                  <THead>
                    <Tr>
                      <Th>Email</Th>
                      <Th>Role</Th>
                      <Th>Expires</Th>
                      <Th>
                        <span className="sr-only">Revoke</span>
                      </Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {pending.map((i) => (
                      <Tr key={i.id}>
                        <Td className="t-data">{i.email}</Td>
                        <Td>{ROLE_LABEL[i.role]}</Td>
                        <Td className="t-data text-muted">{formatDate(isoDate(i.expires_at, workspace.timezone), today)}</Td>
                        <Td className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await revokeInvite(client, i.id);
                                toast.show(`Invite to ${i.email} revoked.`);
                                await reload();
                              } catch (err) {
                                toast.show(errorMessage(err));
                              }
                            }}
                          >
                            Revoke
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </section>

          <section aria-label="Invite">
            <SectionLabel>Invite a co-founder or advisor</SectionLabel>
            <form
              className="rounded-md border border-line bg-surface p-16"
              onSubmit={(e) => {
                e.preventDefault();
                void invite();
              }}
            >
              <div className="grid grid-cols-1 gap-12 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
                <Field label="Email" error={error ? { message: error.message, code: error.code } : null}>
                  <Input type="email" required value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} placeholder="cofounder@example.com" />
                </Field>
                <Field label="Role">
                  <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button type="submit" variant="primary" busy={busy ? "Sending…" : false} className="self-end">
                  Send invite
                </Button>
              </div>
              <p className="t-body-s mt-8 text-muted">{ROLE_HINT[role]} The link works for 7 days.</p>
              {devLink ? (
                <div className="mt-12 flex flex-col gap-6">
                  <p className="t-label">Development invite link</p>
                  <CodeBlock code={devLink} title="dev_link (shown only when the API runs locally)" />
                </div>
              ) : null}
            </form>
          </section>
        </>
      ) : (
        <p className="t-body-s text-muted">Only owners can invite or remove members.</p>
      )}

      <ConfirmDialog
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        onConfirm={confirmRemove}
        busy={leaveBusy}
        busyLabel={leaving?.is_you ? "Leaving…" : "Removing…"}
        error={leaveErr}
        title={leaving?.is_you ? `Leave ${workspace.name}?` : `Remove ${leaving ? personName(leaving) : ""}?`}
        confirmLabel={leaving?.is_you ? "Leave workspace" : "Remove member"}
      >
        <p>
          {leaving?.is_you
            ? "You lose access right away. An owner can invite you again."
            : "They lose access right away. Their past timeline entries stay, under their name."}
        </p>
        {leaving && keysLine(leaving) ? <p className="mt-8 font-medium">{keysLine(leaving)}</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={demoting !== null}
        onClose={() => setDemoting(null)}
        onConfirm={async () => {
          if (!demoting) return;
          const d = demoting;
          setDemoting(null);
          await setMemberRole(d.member, d.role, true);
        }}
        title={demoting ? `Make ${personName(demoting.member)} ${ROLE_LABEL[demoting.role].toLowerCase()}?` : ""}
        confirmLabel="Change role"
      >
        <p>Only owners can hold API keys. {demoting ? keysLine(demoting.member) : null}</p>
      </ConfirmDialog>
    </div>
  );
}
