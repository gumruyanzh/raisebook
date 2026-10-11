"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  SaveState,
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
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { deleteMe, signOut, updateMe } from "@/lib/api/core";
import { removeMember } from "@/lib/api/settings";
import type { Me, Workspace } from "@/lib/api/types";
import { ROLE_LABEL } from "@/lib/api/types";
import { formatDate, isoDate } from "@/lib/format";
import { useSession } from "@/lib/session";

export interface WorkspaceMembership extends Workspace {
  member_count: number | null;
  owner_count: number | null;
}

/** Account (SYSTEM §4.13): name, email, workspaces, sign out, delete account. */
export function Account({ me, workspaces, today }: { me: Me; workspaces: WorkspaceMembership[]; today: string }) {
  const session = useSession();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(me.name ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [leaving, setLeaving] = useState<WorkspaceMembership | null>(null);
  // The sign-up day in the viewer's own calendar (the server render uses the UTC date).
  const [since, setSince] = useState(me.created_at.slice(0, 10));
  useEffect(() => setSince(isoDate(me.created_at)), [me.created_at]);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveErr, setLeaveErr] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const saveName = async () => {
    const v = name.trim();
    if (v === (me.name ?? "")) return;
    setState("saving");
    try {
      await updateMe(api, { name: v || null });
      setState("saved");
      router.refresh();
    } catch (err) {
      setState("error");
      toast.show(errorMessage(err));
    }
  };

  // Which workspaces go with the account, and which block it (SPEC §5.4 DELETE /v1/me).
  const solo = workspaces.filter((w) => w.member_count === 1);
  const blocked = workspaces.filter((w) => w.role === "owner" && (w.member_count ?? 0) > 1 && (w.owner_count ?? 0) <= 1);

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-32">
      <PageHeader title="Account" subline={`Signed in as ${me.email}`} className="mb-0" />

      <section aria-label="Profile">
        <SectionLabel aside={<SaveState state={state} />}>Profile</SectionLabel>
        <div className="grid grid-cols-1 gap-12 rounded-md border border-line bg-surface p-16 sm:grid-cols-2">
          <Field label="Name" hint="Shown to your co-founders on the timeline.">
            <Input
              value={name}
              maxLength={120}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </Field>
          <Field label="Email" hint="You sign in with a link sent here.">
            <Input value={me.email} readOnly mono className="text-muted" />
          </Field>
          <p className="t-body-s text-muted sm:col-span-2">Member since {formatDate(since, today)}.</p>
        </div>
      </section>

      <section aria-label="Workspaces">
        <SectionLabel aside={<Link href="/onboarding" className="link t-body-s">New workspace</Link>}>Workspaces</SectionLabel>
        <TableScroll>
          <Table minWidth={520}>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th align="right">Members</Th>
                <Th>
                  <span className="sr-only">Leave</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {workspaces.map((w) => (
                <Tr key={w.id} className="[&>td]:align-middle!" onActivate={() => router.push(`/w/${encodeURIComponent(w.slug)}`)}>
                  <Td className="font-medium">
                    {w.name}
                    {w.is_sandbox ? <span className="t-micro ml-6 text-muted">SANDBOX</span> : null}
                  </Td>
                  <Td>{w.role ? ROLE_LABEL[w.role] : ""}</Td>
                  <Td variant="num">{w.member_count ?? ""}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setLeaving(w)}>
                      Leave
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      </section>

      <section aria-label="Session">
        <SectionLabel>Session</SectionLabel>
        <div className="flex flex-wrap items-center gap-12 rounded-md border border-line bg-surface p-16">
          <p className="min-w-0 flex-1">Sign out on this device. Other devices stay signed in until their sessions expire.</p>
          <Button
            busy={signingOut ? "Signing out…" : false}
            onClick={async () => {
              setSigningOut(true);
              try {
                await signOut(api);
                router.replace("/signin");
                router.refresh();
              } catch (err) {
                toast.show(errorMessage(err));
                setSigningOut(false);
              }
            }}
          >
            Sign out
          </Button>
        </div>
      </section>

      <section aria-label="Danger zone">
        <SectionLabel>Danger zone</SectionLabel>
        <div className="flex flex-wrap items-center gap-12 rounded-md border border-bad bg-surface p-16">
          <p className="min-w-0 flex-1">
            Delete your account and everything only you can reach. It is permanent and takes effect immediately.
          </p>
          <Button variant="danger-quiet" onClick={() => setDel(true)}>
            Delete account…
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        busy={leaveBusy}
        busyLabel="Leaving…"
        error={leaveErr}
        title={`Leave ${leaving?.name ?? ""}?`}
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          if (!leaving) return;
          setLeaveBusy(true);
          setLeaveErr(null);
          try {
            await removeMember(api.ws(leaving.slug), session.user.id);
            toast.show(`You left ${leaving.name}.`);
            setLeaving(null);
            router.refresh();
          } catch (err) {
            setLeaveErr(err instanceof ApiError && err.code === "last_owner" ? "You are its last owner. Make someone else an owner first, or delete the workspace." : errorMessage(err));
          } finally {
            setLeaveBusy(false);
          }
        }}
      >
        <p>You lose access right away. An owner can invite you again.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        busy={delBusy}
        error={delErr}
        typed={me.email}
        typedLabel={
          <>
            Type your email, <span className="font-mono text-fg">{me.email}</span>, to confirm
          </>
        }
        title="Delete your account?"
        confirmLabel="Delete account permanently"
        onConfirm={async () => {
          setDelBusy(true);
          setDelErr(null);
          try {
            await deleteMe(api, me.email);
            router.replace("/");
            router.refresh();
          } catch (err) {
            if (err instanceof ApiError && err.code === "transfer_ownership_first") {
              setDelErr(`${err.message} Make another member an owner first.`);
            } else setDelErr(errorMessage(err));
            setDelBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-8">
          {solo.length ? (
            <p>
              These workspaces have no other members and are deleted with your account:{" "}
              <b>{solo.map((w) => w.name).join(", ")}</b>. Export first if you want a copy.
            </p>
          ) : (
            <p>No workspace is deleted with your account; other members keep theirs.</p>
          )}
          {blocked.length ? (
            <p className="text-bad">
              You are the only owner of {blocked.map((w) => w.name).join(", ")}, which {blocked.length === 1 ? "has" : "have"} other
              members. Transfer ownership before deleting your account.
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
