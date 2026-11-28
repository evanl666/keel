import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api, errorLine } from "../api/client";
import { qk, useMe } from "../api/hooks";
import { Button, ErrorLine, Field, Input } from "../components/ui";
import { AuthShell, OrDivider } from "../components/AuthShell";

export function Login() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.login({ email: email.trim(), password }),
    onSuccess: (m) => {
      qc.setQueryData(qk.me, m);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from && from !== "/login" ? from : "/", { replace: true });
    },
  });

  return (
    <AuthShell
      title="Sign in"
      sub={me?.org ? `Your stewards at ${me.org.name} are waiting.` : "Your team's stewards are waiting."}
      footer={me?.demo ? "Demo workspace: any email and password work." : undefined}
    >
      {me?.sso_enabled && (
        <>
          <a href={api.ssoUrl} className="block">
            <Button size="lg" variant="secondary" className="w-full" icon={<KeyRound className="size-4" />}>
              Sign in with SSO
            </Button>
          </a>
          <OrDivider />
        </>
      )}
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Field label="Email">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required />
        </Field>
        {login.error && <ErrorLine error={errorLine(login.error)} />}
        <Button type="submit" variant="primary" size="lg" className="w-full !mt-5" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
