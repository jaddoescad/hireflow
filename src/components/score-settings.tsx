"use client";
import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import type { ScoreCategory, Workspace } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Field, Modal } from "./primitives";

export function ScoreSettings({
  data,
  mutate,
}: {
  data: Workspace;
  mutate: Mutate;
}) {
  const [editing, setEditing] = useState<ScoreCategory | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (!data.membership?.enabled || data.membership.role !== "admin")
    return null;

  async function remove(category: ScoreCategory) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate("score_category_remove", { id: category.id });
      setNotice(
        `${category.name} removed. Saved ratings remain in candidate history.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove category.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel score-settings">
      <div className="panel-heading">
        <h2>Interview scorecard</h2>
        <button
          disabled={busy || data.score_categories.length >= 50}
          onClick={() => {
            setError("");
            setEditing(null);
          }}
        >
          <Plus size={16} /> Add category
        </button>
      </div>
      <p className="panel-description">
        One scorecard for every position. Your team rates each category from 0–10
        after the voice interview. Removing a category keeps its saved ratings
        in candidate history.
      </p>
      <div className="score-category-list">
        {data.score_categories.map((category) => (
          <div className="score-category-setting" key={category.id}>
            <div>
              <strong>{category.name}</strong>
              {category.description && <p>{category.description}</p>}
            </div>
            <button
              className="icon-button"
              aria-label={`Edit ${category.name}`}
              disabled={busy}
              onClick={() => {
                setError("");
                setEditing(category);
              }}
            >
              <Pencil size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={`Remove ${category.name}`}
              disabled={busy}
              onClick={() => void remove(category)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {!data.score_categories.length && (
          <p className="panel-empty">
            No categories yet. Add a category to start scoring interviews.
          </p>
        )}
      </div>
      {error && editing === undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? "Edit score category" : "Add score category"}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setBusy(true);
              setError("");
              setNotice("");
              try {
                await mutate("score_category_save", {
                  ...(editing ? { id: editing.id } : {}),
                  name: form.get("name"),
                  description: form.get("description"),
                });
                setNotice(
                  editing
                    ? "Category updated."
                    : "Category added to every candidate’s scorecard.",
                );
                setEditing(undefined);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save category.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Category name">
              <input
                name="name"
                defaultValue={editing?.name}
                required
                maxLength={80}
                placeholder="e.g. Communication"
                autoFocus
                disabled={busy}
              />
            </Field>
            <Field label="What to assess (optional)">
              <textarea
                name="description"
                defaultValue={editing?.description}
                maxLength={500}
                placeholder="Help interviewers apply the same criteria."
                disabled={busy}
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <footer className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save category"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
