import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, KeyRound } from "lucide-react";
import { api, errorLine } from "../api/client";
import { qk, useMe } from "../api/hooks";
import { Button, ErrorLine, Field, Input } from "../components/ui";
import { KeelMark, StewardAvatar } from "../components/keel";

const CREW = [
  { emoji: "🦉", color: "#7C5CFF", x: -210, y: -150, d: 0 },
  { emoji: "🦫", color: "#10B981", x: 230, y: -90, d: 0.6 },
  { emoji: "🐙", color: "#F59E0B", x: -190, y: 170, d: 1.2 },
  { emoji: "🦊", color: "#f472b6", x: 215, y: 185, d: 1.8 },
];

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
    <div className="app-bg min-h-full grid place-items-center px-6 py-16 relative overflow-hidden">
      <div className="relative">
        {CREW.map((c) => (
          <motion.div
            key={c.emoji}
            className="absolute left-1/2 top-1/2 hidden md:block"
            initial={{ opacity: 0, scale: 0.6, x: c.x, y: c.y }}
            animate={{ opacity: 0.85, scale: 1, x: c.x, y: [c.y, c.y - 8, c.y] }}
            transition={{ opacity: { delay: 0.2 + c.d * 0.2 }, scale: { delay: 0.2 + c.d * 0.2 }, y: { repeat: Infinity, duration: 4.5, delay: c.d, ease: "easeInOut" } }}
            style={{ marginLeft: -18, marginTop: -18 }}
          >
            <StewardAvatar emoji={c.emoji} color={c.color} size="md" />
          </motion.div>
        ))}

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative w-[360px] rounded-2xl border border-line bg-panel/90 backdrop-blur-xl shadow-pop p-7"
        >
          <div className="flex flex-col items-center text-center">
            <KeelMark size={40} />
            <h1 className="mt-4 text-[20px] font-semibold tracking-[-0.02em]">Sign in to Keel</h1>
            <p className="text-[13px] text-muted mt-1">{me?.org ? `Your stewards at ${me.org.name} are waiting.` : "Your team's stewards are waiting."}</p>
          </div>

          {me?.sso_enabled && (
            <>
              <a href="/api/auth/sso" className="mt-6 block">
                <Button size="lg" variant="secondary" className="w-full" icon={<KeyRound className="size-4" />}>
                  Sign in with SSO
                </Button>
              </a>
              <div className="my-5 flex items-center gap-3 text-[11.5px] uppercase tracking-[0.08em] text-faint">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
            </>
          )}

          <form
            className={me?.sso_enabled ? "space-y-3.5" : "mt-6 space-y-3.5"}
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
            <Button type="submit" variant="primary" size="lg" className="w-full !mt-5" loading={login.isPending} icon={!login.isPending ? <ArrowRight className="size-4" /> : undefined}>
              Sign in
            </Button>
          </form>
          {me?.demo && <p className="mt-4 text-center text-[12px] text-faint">Demo workspace: any email and password work.</p>}
        </motion.div>
      </div>
      <div className="absolute bottom-5 left-0 right-0 text-center text-[11.5px] text-faint">Keel {me?.version ?? ""} · self-hosted · your data stays on your servers</div>
    </div>
  );
}
