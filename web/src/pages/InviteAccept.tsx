import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { ApiError, api, errorLine } from "../api/client";
import { useInviteInfo, useMe } from "../api/hooks";
import { Button, ErrorLine, Field, Input, Skeleton } from "../components/ui";
import { AuthShell, OrDivider } from "../components/AuthShell";

const CLOSED: Record<string, { title: string; line: string }> = {
  expired: { title: "This invite has expired", line: "Invites work for 7 days. Ask whoever sent it for a new one." },
  revoked: { title: "This invite was withdrawn", line: "An admin revoked it. Ask them for a new one if you still need access." },
  accepted: { title: "This invite was already used", line: "Each link works once. Sign in with the account you made." },
};

export function InviteAccept() {
  const { token = "" } = useParams();
  const { data: me } = useMe();
  const { data: info, isLoading, error } = useInviteInfo(token);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token, { name: name.trim(), password }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      nav("/", { replace: true });
    },
  });

  if (isLoading)
    return (
      <AuthShell title="Opening your invite…">
        <div className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </AuthShell>
    );

  if (error || !info) {
    const gone = error instanceof ApiError && (error.status === 404 || error.status === 410);
    return (
      <AuthShell title="This invite link doesn't work" sub={gone ? "It may be mistyped, or it was already used. Ask whoever sent it for a new one." : errorLine(error)}>
        <Link to="/login">
          <Button variant="secondary" className="w-full" size="lg">
            Go to sign in
          </Button>
        </Link>
      </AuthShell>
    );
  }

  const closed = CLOSED[info.status];
  if (closed)
    return (
      <AuthShell title={closed.title} sub={closed.line}>
        <Link to="/login">
          <Button variant="secondary" className="w-full" size="lg">
            Go to sign in
          </Button>
        </Link>
      </AuthShell>
    );

  return (
    <AuthShell
      title={`Join ${info.org} on Keel`}
      sub={
        <>
          {info.invited_by} invited <span className="text-fg">{info.email}</span>
          {info.teams.length > 0 && <> to {joinNames(info.teams)}</>}.
        </>
      }
      footer={me?.user ? `You're signed in as ${me.user.email}. Accepting signs you in as ${info.email}.` : undefined}
    >
      {info.sso_enabled && (
        <>
          <a href={api.ssoUrl} className="block">
            <Button size="lg" variant="secondary" className="w-full" icon={<KeyRound className="size-4" />}>
              Use SSO
            </Button>
          </a>
          <OrDivider />
        </>
      )}
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <Field label="Email">
          <Input value={info.email} disabled readOnly />
        </Field>
        <Field label="Your name">
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Rosa Alvarez" required autoFocus />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required minLength={10} />
        </Field>
        {accept.error && <ErrorLine error={errorLine(accept.error)} />}
        <Button type="submit" variant="primary" size="lg" className="w-full !mt-5" loading={accept.isPending}>
          Join {info.org}
        </Button>
      </form>
    </AuthShell>
  );
}

function joinNames(xs: string[]) {
  if (xs.length <= 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
