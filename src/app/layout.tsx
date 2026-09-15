import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "HireFlow — Hiring workspace",
  description: "Manage candidates, conversations, and your hiring team.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
