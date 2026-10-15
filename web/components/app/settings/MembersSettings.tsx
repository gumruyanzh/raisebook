"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  CodeBlock,
  ConfirmDialog,
  Field,
  SectionLabel,
  Select,
  Table,
  TableScroll,
  TBody,
  Td,
  Th,
  THead,
  Textarea,
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

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** "a@x.com, b@x.com\nc@x.com" → unique addresses in order, plus the pieces that aren't emails. */
export function parseEmails(raw: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const p = part.trim().replace(/^<|>$/g, "");
    if (!p) continue;
    if (!EMAIL_RE.test(p)) {
      invalid.push(p);
      continue;
    }
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(p);
  }
  return { emails, invalid };
}
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
  const [devLinks, setDevLinks] = useState<string[]>([]);
  const [failures, setFailures] = useState<{ email: string; message: string; code?: string }[]>([]);
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

  // Several addresses at once (comma, space or newline), all with one role. Sent one by one so
  // each gets its own result; a workspace limit stops the rest.
  const invite = async () => {
    const { emails, invalid } = parseEmails(email);
    setError(null);
    setFailures([]);
    setDevLinks([]);
    if (invalid.length) {
      setError({ message: `${invalid.map((x) => `"${x}"`).join(", ")} ${invalid.length === 1 ? "isn't an email address" : "aren't email addresses"}.` });
      return;
    }
    if (!emails.length) {
      setError({ message: "Enter one or more email addresses." });
      return;
    }
    setBusy(true);
    const sent: string[] = [];
    const failed: { email: string; message: string; code?: string }[] = [];
    const links: string[] = [];
    for (let i = 0; i < emails.length; i++) {
      const addr = emails[i]!;
      try {
        const inv = await createInvite(client, addr, role);
        sent.push(inv.email);
        if (inv.dev_link) links.push(inv.dev_link);
      } catch (err) {
        const f = err instanceof ApiError ? { email: addr, message: err.message, code: err.code } : { email: addr, message: errorMessage(err) };
        failed.push(f);
        if (err instanceof ApiError && (err.code === "limit_reached" || err.status === 429)) {
          for (const rest of emails.slice(i + 1)) failed.push({ email: rest, message: "Not sent: the limit above was reached." });
          break;
        }
      }
    }
    setBusy(false);
    setEmail(failed.map((f) => f.email).join(", "));
    setFailures(failed);
    setDevLinks(links);
    if (sent.length) toast.show(sent.length === 1 ? `Invite sent to ${sent[0]}.` : `Invites sent to ${sent.length} people.`);
    await reload();
  };

  const parsed = parseEmails(email);
  const count = parsed.emails.length;

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
        {members.some((mb) => mb.is_you && isLastOwner(mb)) && members.length > 1 ? (
          <p className="t-body-s mb-8 text-muted">
            You&apos;re the only owner. Make someone else an owner before you can leave.
          </p>
        ) : null}
        <TableScroll>
          <Table minWidth={640} stack>
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
                <Table minWidth={560} stack>
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
              <div className="grid grid-cols-1 gap-12 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-start">
                <Field
                  label="Emails"
                  hint="Paste several, separated by commas or new lines."
                  error={error ? { message: error.message, code: error.code } : null}
                >
                  <Textarea
                    rows={1}
                    value={email}
                    maxLength={5000}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void invite();
                      }
                    }}
                    placeholder="cofounder@example.com, advisor@example.com"
                    className="min-h-32! resize-none! py-6! [field-sizing:content]"
                  />
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
                <Button type="submit" variant="primary" busy={busy ? "Sending…" : false} className="sm:mt-21">
                  {count > 1 ? `Send ${count} invites` : "Send invite"}
                </Button>
              </div>
              <p className="t-body-s mt-8 text-muted">{ROLE_HINT[role]} The link works for 7 days.</p>
              {failures.length ? (
                <ul className="t-body-s mt-10 flex list-none flex-col gap-4 p-0 text-bad" role="alert">
                  {failures.map((f) => (
                    <li key={f.email}>
                      <span className="font-mono">{f.email}</span>: {f.message}
                      {f.code ? <span className="ml-6 font-mono text-micro">{f.code}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {devLinks.length ? (
                <div className="mt-12 flex flex-col gap-6">
                  <p className="t-label">Development invite {devLinks.length === 1 ? "link" : "links"}</p>
                  <CodeBlock code={devLinks.join("\n")} title="dev_link (shown only when the API runs locally)" />
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
