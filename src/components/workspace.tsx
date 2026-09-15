"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  ChevronDown,
  LayoutDashboard,
  Users,
  Settings as SettingsIcon,
  LogOut,
  Plus,
  ArrowRight,
  RefreshCw,
  Check,
  X,
} from "lucide-react";
import { browserDb, configured } from "@/lib/supabase/client";
import type {
  Workspace as WorkspaceData,
  Candidate,
  Activity,
} from "@/lib/types";
import { Auth } from "./auth";
import { Logo, Avatar, Modal, Field, Empty } from "./primitives";
import { HiringBoard } from "./hiring-board";
import { CandidateDetail, CandidateEditor } from "./candidate-detail";
import { Team } from "./team";
import { Settings } from "./settings";
export function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState("hiring");
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<Candidate | null | undefined>();
  const [newCompany, setNewCompany] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [signal, setSignal] = useState<Activity | null>(null);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const companyRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const load = useCallback(async (cid: string | null = companyRef.current) => {
    const generation = ++requestRef.current;
    try {
      const response = await fetch(
        `/api/workspace${cid ? `?company=${cid}` : ""}`,
        { cache: "no-store" },
      );
      const next = await response.json();
      if (generation !== requestRef.current) return;
      if (response.status === 401) {
        setSignedIn(false);
        setData(null);
        return;
      }
      if (!response.ok) {
        if (response.status === 403) {
          companyRef.current = null;
          setData(null);
        }
        throw new Error(next.error || "Could not load workspace");
      }
      setSignedIn(true);
      setData(next);
      setError("");
    } catch (e) {
      if (generation === requestRef.current)
        setError(e instanceof Error ? e.message : "Could not load workspace");
    } finally {
      if (generation === requestRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const token =
      new URLSearchParams(location.search).get("invite") ||
      sessionStorage.getItem("hf_invitation") ||
      "";
    if (token) {
      setInvite(token);
      sessionStorage.setItem("hf_invitation", token);
      history.replaceState(null, "", "/");
    }
    if (!configured) {
      setLoading(false);
      return;
    }
    companyRef.current = new URLSearchParams(location.search).get("company");
    void load(companyRef.current);
    const db = browserDb();
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setData(null);
        setSignedIn(false);
        companyRef.current = null;
        history.replaceState(null, "", "/");
      }
      if (event === "SIGNED_IN") void load(companyRef.current);
    });
    return () => subscription.unsubscribe();
  }, [load]);
  useEffect(() => {
    if (!signedIn || !data?.company) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [signedIn, data?.company?.id, load]);
  async function mutate(action: string, payload: Record<string, unknown>) {
    try {
      const response = await fetch("/api/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          company_id: companyRef.current,
          payload,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not save change");
      await load();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save change");
      throw e;
    }
  }
  async function choose(id: string | null) {
    companyRef.current = id;
    history.replaceState(null, "", id ? `/?company=${id}` : "/");
    setSelected(null);
    setSignal(null);
    setSwitcher(false);
    setEdit(undefined);
    setView("hiring");
    setData(null);
    setLoading(true);
    await load(id);
  }
  const c = data?.candidates.find((c) => c.id === selected);
  const admin = data?.membership?.role === "admin";
  if (loading && !signedIn)
    return (
      <div className="loading">
        <Logo />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!signedIn)
    return <Auth onSignedIn={() => void load(null)} invited={!!invite} />;
  const companyModal = newCompany && (
    <Modal title="Create a company" onClose={() => setNewCompany(false)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const name = new FormData(e.currentTarget).get("name");
          setBusy(true);
          try {
            const result = await mutate("create_company", { name });
            setNewCompany(false);
            await choose(String(result.id));
          } catch {
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          You’ll be the first admin. Invite your team once your company is
          ready.
        </p>
        <Field label="Company name">
          <input
            name="name"
            placeholder="Your company"
            required
            maxLength={100}
            autoFocus
          />
        </Field>
        {error && <p className="error">{error}</p>}
        <footer className="form-actions">
          <button className="primary" disabled={busy}>
            {busy ? "Creating…" : "Create company"}
          </button>
        </footer>
      </form>
    </Modal>
  );
  const invitation = invite && (
    <section className="invitation-banner">
      <div>
        <strong>You have a company invitation</strong>
        <p>Accept it using the email it was sent to: {data?.user.email}</p>
      </div>
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await mutate("accept_invitation", { token: invite });
            setInvite("");
            sessionStorage.removeItem("hf_invitation");
            await choose(String(result.id));
          } catch {
          } finally {
            setBusy(false);
          }
        }}
      >
        <Check size={16} /> Accept invitation
      </button>
      <button
        className="icon-button"
        aria-label="Dismiss invitation"
        onClick={() => {
          setInvite("");
          sessionStorage.removeItem("hf_invitation");
        }}
      >
        <X size={18} />
      </button>
    </section>
  );
  if (!data?.company)
    return (
      <div className="chooser">
        <header>
          <Logo />
          <button onClick={() => void browserDb().auth.signOut()}>
            <LogOut size={16} /> Sign out
          </button>
        </header>
        <main>
          {invitation}
          <span className="eyebrow">YOUR WORKSPACES</span>
          <h1>Where are we hiring today?</h1>
          <p>Choose a company to open its hiring workspace.</p>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => void choose(null)}>Retry</button>
            </div>
          )}
          {loading ? (
            <p>Loading companies…</p>
          ) : (
            <div className="company-list">
              {data?.companies.map((c) => (
                <button key={c.id} onClick={() => void choose(c.id)}>
                  <span className="company-icon">
                    <Building2 size={25} />
                  </span>
                  <strong>{c.name}</strong>
                  <ArrowRight size={20} />
                </button>
              ))}
              <button
                className="create-company"
                onClick={() => setNewCompany(true)}
              >
                <Plus size={22} />
                <strong>Create a company</strong>
              </button>
            </div>
          )}
          <p className="muted">Signed in as {data?.user.email}</p>
        </main>
        {companyModal}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="company-control">
          <button
            className="company-button"
            aria-expanded={switcher}
            onClick={() => setSwitcher(!switcher)}
          >
            <span className="company-icon">
              <Building2 size={18} />
            </span>
            <span>{data.company.name}</span>
            <ChevronDown size={16} />
          </button>
          {switcher && (
            <div className="company-menu">
              {data.companies.map((c) => (
                <button key={c.id} onClick={() => void choose(c.id)}>
                  {c.name}
                  {c.id === data.company?.id && <Check size={15} />}
                </button>
              ))}
              <button onClick={() => void choose(null)}>All companies</button>
              <button onClick={() => void browserDb().auth.signOut()}>
                <LogOut size={15} /> Sign out
              </button>
              <button
                onClick={() => {
                  setNewCompany(true);
                  setSwitcher(false);
                }}
              >
                <Plus size={15} /> Create company
              </button>
            </div>
          )}
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          <button
            className={view === "hiring" ? "active" : ""}
            onClick={() => setView("hiring")}
          >
            <LayoutDashboard size={19} /> Hiring{" "}
            <span>{data.candidates.length}</span>
          </button>
          <button
            className={view === "team" ? "active" : ""}
            onClick={() => setView("team")}
          >
            <Users size={19} /> Team
          </button>
          {admin && (
            <button
              className={view === "settings" ? "active" : ""}
              onClick={() => setView("settings")}
            >
              <SettingsIcon size={19} /> Settings
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <Avatar name={data.user.email} />
            <div>
              <strong>{data.user.email}</strong>
              <span>{admin ? "Admin" : "Member"}</span>
            </div>
          </div>
          <button onClick={() => void browserDb().auth.signOut()}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <main className="main-workspace">
        {invitation}
        {error && (
          <div className="error global-error" role="alert">
            {error}
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {view === "hiring" ? (
          <HiringBoard
            data={data}
            mutate={mutate}
            onCandidate={(c) => setSelected(c.id)}
            onNew={() => setEdit(null)}
            onSignal={(a) => {
              void mutate("signal_read", { id: a.id }).catch(() => {});
              if (a.candidate_id) setSelected(a.candidate_id);
              else setSignal(a);
            }}
          />
        ) : view === "team" ? (
          <Team data={data} mutate={mutate} />
        ) : admin ? (
          <Settings data={data} mutate={mutate} />
        ) : (
          <Empty title="Admin access required" />
        )}
        <button
          className="refresh"
          aria-label="Refresh workspace"
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
        </button>
      </main>
      {c && edit === undefined && (
        <CandidateDetail
          candidate={c}
          data={data}
          mutate={mutate}
          onClose={() => setSelected(null)}
          onEdit={() => setEdit(c)}
        />
      )}
      {edit !== undefined && (
        <CandidateEditor
          candidate={edit}
          data={data}
          mutate={mutate}
          onClose={() => setEdit(undefined)}
        />
      )}
      {companyModal}
      {signal && (
        <Modal title="Match this signal" onClose={() => setSignal(null)}>
          <p>{signal.body}</p>
          <p className="muted">
            More than one candidate uses this contact information. Choose the
            right person.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const id = new FormData(e.currentTarget).get("candidate_id");
              try {
                await mutate("signal_link", {
                  id: signal.id,
                  candidate_id: id,
                });
                setSignal(null);
                setSelected(String(id));
              } catch {}
            }}
          >
            <Field label="Candidate">
              <select name="candidate_id" required>
                {data.candidates.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name} — {c.phone || c.email}
                  </option>
                ))}
              </select>
            </Field>
            <button className="primary">Link candidate</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
