"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X, ArrowRight } from "lucide-react";
export function Logo() {
  return (
    <span className="logo">
      Hire<span>Flow</span>
    </span>
  );
}
export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((s) => s[0])
        .join("")
        .toUpperCase()}
    </span>
  );
}
const roleColors = 8;
const knownRoleColors: Record<string, number> = {
  painter: 0,
  helper: 1,
  "project manager": 2,
  "crew leader": 3,
  "professional painter": 5,
  "google meet qa": 7,
};
export function RolePill({ role }: { role: string }) {
  const name = role.trim();
  const normalized = name.toLowerCase();
  let hash = 0;
  for (const ch of normalized) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = knownRoleColors[normalized] ?? hash % roleColors;
  return (
    <span className={`role-pill ${name ? `role-${color}` : "role-none"}`}>
      {name || "Role not specified"}
    </span>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current
      ?.querySelector<HTMLElement>("[autofocus], input, select, textarea")
      ?.focus();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${wide ? "modal wide" : "modal"} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation(); // Escape closes only the topmost nested dialog.
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">
        <ArrowRight size={23} />
      </span>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
