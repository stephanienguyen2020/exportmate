// Account page, signed-in companies: who is in the company and with which role. Everyone sees
// the team and can leave it; owners invite people by email, change roles and remove members.
import { useEffect, useState } from "react";
import { Loader2, Mail, UserMinus } from "lucide-react";
import { api, cacheAccount, type Invite, type Member, type Role } from "./api";
import { navigate } from "./account-store";
import { errorMessage } from "./auth";
import "./analysis.css";
import "./team.css";

type Notify = (text: string, error?: boolean) => void;

const ROLES: { value: Role; label: string; does: string }[] = [
  { value: "viewer", label: "Viewer", does: "Reads everything and prepares reports." },
  {
    value: "editor",
    label: "Editor",
    does: "Also imports orders, edits the playbook, suppliers and sites, uploads documents and runs analysis.",
  },
  {
    value: "owner",
    label: "Owner",
    does: "Also edits the company and cost settings, approves supplier messages and manages the team.",
  },
];
const roleLabel = (role: Role) => ROLES.find((r) => r.value === role)?.label ?? role;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function Team({ role, notify }: { role: Role | null; notify: Notify }) {
  const owner = role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const reload = async (signal?: AbortSignal) => {
    try {
      const [people, open] = await Promise.all([
        api.members(signal),
        owner ? api.invites(signal) : Promise.resolve([]),
      ]);
      if (signal?.aborted) return;
      setMembers(people);
      setInvites(open);
      setError("");
    } catch (e) {
      if (!signal?.aborted) setError(errorMessage(e));
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [owner]);
  const act = async (key: string, action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(key);
    try {
      const done = await action();
      if (done) notify(done);
      await reload();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy("");
      setConfirming("");
    }
  };
  const sendInvite = (address: string, as: Role) =>
    act(`invite:${address}`, async () => {
      const sent = await api.inviteMember(address, as);
      setEmail("");
      return sent.sandbox
        ? `Invitation saved for ${sent.email}, but email isn't set up, so nothing was sent. Ask them to sign in with that address.`
        : `Invitation sent to ${sent.email}.`;
    });
  const leave = async (me: Member) => {
    if (busy) return;
    setBusy(`remove:${me.userId}`);
    try {
      await api.removeMember(me.userId);
      cacheAccount(await api.me());
      navigate("onboarding");
    } catch (e) {
      notify(errorMessage(e), true);
      setBusy("");
      setConfirming("");
    }
  };
  const owners = members?.filter((m) => m.role === "owner").length ?? 0;
  return (
    <section className="panel co-panel" aria-label="Team">
      <span className="eyebrow">TEAM</span>
      <h2>Who works in this company.</h2>
      <p>
        {owner
          ? "Invite people by email and choose what they may do. A company always keeps at least one owner."
          : "Only an owner can invite people or change roles."}
      </p>
      <dl className="team-roles">
        {ROLES.map((r) => (
          <div key={r.value}>
            <dt>{r.label}</dt>
            <dd>{r.does}</dd>
          </div>
        ))}
      </dl>
      {error ? (
        <p role="alert">{error}</p>
      ) : !members ? (
        <p role="status">
          <Loader2 size={15} className="spin" /> Loading…
        </p>
      ) : (
        <ul className="team-list" aria-label="Members">
          {members.map((m) => {
            const lastOwner = m.role === "owner" && owners <= 1;
            const removing = busy === `remove:${m.userId}`;
            return (
              <li key={m.userId}>
                <span>
                  <b>
                    {m.name || m.email}
                    {m.you && <small> (you)</small>}
                  </b>
                  <small>
                    {m.email} · joined {day(m.joinedAt)}
                  </small>
                </span>
                {owner ? (
                  <select
                    aria-label={`Role of ${m.name || m.email}`}
                    value={m.role}
                    disabled={Boolean(busy) || lastOwner}
                    title={lastOwner ? "Make someone else an owner first." : undefined}
                    onChange={(e) =>
                      void act(`role:${m.userId}`, async () => {
                        const changed = await api.changeMemberRole(m.userId, e.target.value as Role);
                        return `${changed.name || changed.email} is now ${roleLabel(changed.role).toLowerCase()}.`;
                      })
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="team-role">{roleLabel(m.role)}</span>
                )}
                {(owner || m.you) && !lastOwner && (
                  <button
                    className="btn secondary"
                    disabled={Boolean(busy) && !removing}
                    onClick={() => {
                      if (confirming !== m.userId) {
                        setConfirming(m.userId);
                        return;
                      }
                      if (m.you) void leave(m);
                      else
                        void act(`remove:${m.userId}`, async () => {
                          await api.removeMember(m.userId);
                          return `${m.name || m.email} was removed.`;
                        });
                    }}
                  >
                    {removing ? <Loader2 size={15} className="spin" /> : <UserMinus size={15} />}
                    {confirming === m.userId
                      ? m.you
                        ? "Confirm: leave"
                        : "Confirm: remove"
                      : m.you
                        ? "Leave company"
                        : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {owner && members && (
        <>
          <form
            className="co-form team-invite"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) void sendInvite(email.trim(), inviteRole);
            }}
          >
            <label>
              Email address
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label>
              Role
              <select
                aria-label="Invite as"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit" disabled={Boolean(busy)}>
              {busy.startsWith("invite:") ? <Loader2 size={15} className="spin" /> : <Mail size={15} />}
              Send invitation
            </button>
          </form>
          {invites.length > 0 && (
            <ul className="team-list" aria-label="Invitations">
              {invites.map((i) => (
                <li key={i.id}>
                  <span>
                    <b>{i.email}</b>
                    <small>
                      {roleLabel(i.role)} ·{" "}
                      {i.expired ? <em>expired {day(i.expiresAt)}</em> : `valid until ${day(i.expiresAt)}`}
                      {i.invitedBy && ` · invited by ${i.invitedBy.name}`}
                    </small>
                  </span>
                  <button
                    className="btn secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void sendInvite(i.email, i.role)}
                  >
                    Send again
                  </button>
                  <button
                    className="btn secondary"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void act(`revoke:${i.id}`, async () => {
                        await api.revokeInvite(i.id);
                        return `Invitation for ${i.email} withdrawn.`;
                      })
                    }
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
