"use client";
import { useState } from "react";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { browserDb, configured } from "@/lib/supabase/client";
import { Logo, Field } from "./primitives";
export function Auth({
  onSignedIn,
  invited,
}: {
  onSignedIn: () => void;
  invited: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup" | "otp">("login");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const db = browserDb();
      if (mode === "otp" && !sent) {
        const { error } = await db.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}/auth/callback` },
        });
        if (error) throw error;
        setSent(true);
        setMessage("Check your email for a sign-in link or code.");
      } else if (mode === "otp") {
        const { error } = await db.auth.verifyOtp({
          email,
          token: code,
          type: "email",
        });
        if (error) throw error;
        onSignedIn();
      } else if (mode === "signup") {
        const { data, error } = await db.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${location.origin}/auth/callback` },
        });
        if (error) throw error;
        if (data.session) onSignedIn();
        else
          setMessage("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onSignedIn();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <aside className="auth-brand">
        <Logo />
        <div>
          <span className="eyebrow">YOUR NEXT GREAT HIRE</span>
          <h1>
            A clear path
            <br />
            from hello
            <br />
            to hired.
          </h1>
          <p>Keep your candidates, conversations, and team in one place.</p>
        </div>
        <span className="auth-foot">Your people. Your process.</span>
      </aside>
      <main className="auth-main">
        <div className="auth-box">
          <span className="badge">
            <ShieldCheck size={15} /> Team workspace
          </span>
          <h2>
            {invited
              ? "Join your team"
              : mode === "signup"
                ? "Create your account"
                : "Welcome to HireFlow"}
          </h2>
          <p>
            {invited
              ? "Sign in with the email your invitation was sent to."
              : "One account for every company you work with."}
          </p>
          {!configured ? (
            <div className="notice">
              Connect Supabase to start. Follow the setup steps in the project
              README.
            </div>
          ) : (
            <form onSubmit={submit}>
              <Field label="Email address">
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                />
              </Field>
              {mode !== "otp" && (
                <Field label="Password">
                  <input
                    type="password"
                    autoComplete={
                      mode === "signup" ? "new-password" : "current-password"
                    }
                    minLength={mode === "signup" ? 12 : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </Field>
              )}
              {mode === "otp" && sent && (
                <Field label="Email code">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </Field>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              {message && (
                <div className="notice" role="status">
                  {message}
                </div>
              )}
              <button className="primary full" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : mode === "signup"
                    ? "Create account"
                    : mode === "otp" && !sent
                      ? "Email me a sign-in link"
                      : "Sign in"}
                <ArrowRight size={17} />
              </button>
            </form>
          )}
          <div className="auth-options">
            <button
              onClick={() => {
                setMode(mode === "signup" ? "login" : "signup");
                setMessage("");
                setError("");
              }}
            >
              {mode === "signup"
                ? "Already have an account? Sign in"
                : "New to HireFlow? Create an account"}
            </button>
            <button
              onClick={() => {
                setMode(mode === "otp" ? "login" : "otp");
                setSent(false);
                setError("");
                setMessage("");
              }}
            >
              <Mail size={15} />
              {mode === "otp" ? "Use a password" : "Sign in with email instead"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
