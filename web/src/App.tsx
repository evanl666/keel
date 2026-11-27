import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ApiError } from "./api/client";
import { useMe } from "./api/hooks";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/toast";
import { StreamProvider } from "./components/stream";
import { KeelMark } from "./components/keel";
import { Overview } from "./pages/Overview";
import { TeamHome } from "./pages/team/TeamHome";
import { Ledger } from "./pages/Ledger";
import { CommitmentPage } from "./pages/CommitmentPage";
import { Approvals } from "./pages/Approvals";
import { Operations } from "./pages/Operations";
import { Services } from "./pages/Services";
import { Checkup } from "./pages/Checkup";
import { Audit } from "./pages/Audit";
import { Setup } from "./pages/Setup";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function Splash() {
  return (
    <div className="app-bg h-full grid place-items-center">
      <div className="animate-pulse">
        <KeelMark size={40} />
      </div>
    </div>
  );
}

function Gate() {
  const { data: me, isLoading, error } = useMe();
  const loc = useLocation();
  if (isLoading) return <Splash />;
  if (error && !me) {
    return (
      <div className="app-bg h-full grid place-items-center text-center px-6">
        <div>
          <KeelMark size={40} />
          <div className="mt-4 text-[15px] font-semibold">Keel's server didn't answer</div>
          <div className="mt-1 text-[13px] text-muted">{error.message}</div>
        </div>
      </div>
    );
  }
  const setupOpen = me && !me.setup_complete && !me.demo;
  const signedIn = !!me?.user;

  if (setupOpen) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup standalone />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }
  if (!signedIn) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname }} />} />
      </Routes>
    );
  }
  return (
    <StreamProvider enabled>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="teams/:slug" element={<TeamHome />} />
          <Route path="teams/:slug/:tab" element={<TeamHome />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="commitments/:key" element={<CommitmentPage />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="operations" element={<Operations />} />
          <Route path="services" element={<Services />} />
          <Route path="checkup" element={<Checkup />} />
          <Route path="audit" element={<Audit />} />
          <Route path="setup" element={<Setup />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </StreamProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
