"use client";
import { useState } from "react";
import { Plus, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import type { Workspace, Stage } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Field, Modal } from "./primitives";
import { ScoreSettings } from "./score-settings";
// Saves one admin change and reports progress for the settings and integrations pages.
export function useSave(mutate: Mutate) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function run(action: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const r = await mutate(action, payload);
      setSaved(true);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, setBusy, error, setError, saved, run };
}
export function Settings({ data, mutate }: { data: Workspace; mutate: Mutate }) {
  const [stage, setStage] = useState<Stage | null | undefined>();
  const { busy, error, saved, run } = useSave(mutate);
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / SETTINGS</div>
          <h1>Make it your process</h1>
          <p>Stages and interview scores for {data.company?.name}.</p>
        </div>
      </header>
      <div className="content-body settings-grid">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="notice" role="status">
            Saved.
          </div>
        )}
        <ScoreSettings data={data} mutate={mutate} />
        <section className="panel">
          <div className="panel-heading">
            <h2>Company</h2>
          </div>
          <form
            className="panel-form inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run("rename_company", {
                name: new FormData(e.currentTarget).get("name"),
              });
            }}
          >
            <Field label="Company name">
              <input
                name="name"
                defaultValue={data.company?.name}
                required
                maxLength={100}
              />
            </Field>
            <button className="primary" disabled={busy}>
              Save
            </button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Hiring stages</h2>
            <button onClick={() => setStage(null)}>
              <Plus size={16} /> Add stage
            </button>
          </div>
          <p className="panel-description">
            The first stage receives new applications. Move candidates out of a
            stage before deleting it.
          </p>
          <div className="stage-settings">
            {data.stages.map((s, index) => (
              <div className="stage-setting" key={s.id}>
                <span className={`stage-dot tone-${s.color}`} />
                <button className="text-button" onClick={() => setStage(s)}>
                  {s.name}
                </button>
                <span>
                  {data.candidates.filter((c) => c.stage_id === s.id).length}{" "}
                  candidates
                </span>
                <button
                  className="icon-button"
                  aria-label={`Move ${s.name} up`}
                  disabled={busy || index === 0}
                  onClick={() =>
                    void run("stage_reorder", { id: s.id, direction: "up" })
                  }
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move ${s.name} down`}
                  disabled={busy || index === data.stages.length - 1}
                  onClick={() =>
                    void run("stage_reorder", { id: s.id, direction: "down" })
                  }
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${s.name}`}
                  disabled={
                    busy ||
                    data.candidates.some((c) => c.stage_id === s.id) ||
                    data.stages.length === 1
                  }
                  onClick={() => void run("stage_delete", { id: s.id })}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
      {stage !== undefined && (
        <Modal
          title={stage ? "Edit stage" : "Add stage"}
          onClose={() => setStage(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const r = await run("stage_save", {
                ...(stage ? { id: stage.id } : {}),
                name: f.get("name"),
                color: f.get("color"),
                position:
                  stage?.position ??
                  Math.max(-1, ...data.stages.map((s) => s.position)) + 1,
              });
              if (r) setStage(undefined);
            }}
          >
            <Field label="Stage name">
              <input
                name="name"
                defaultValue={stage?.name}
                required
                maxLength={60}
                autoFocus
              />
            </Field>
            <Field label="Color">
              <select name="color" defaultValue={stage?.color || "blue"}>
                {["blue", "slate", "violet", "amber", "green", "red"].map(
                  (c) => (
                    <option key={c}>{c}</option>
                  ),
                )}
              </select>
            </Field>
            {error && <p className="error">{error}</p>}
            <footer className="form-actions">
              <button className="primary" disabled={busy}>
                Save stage
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
