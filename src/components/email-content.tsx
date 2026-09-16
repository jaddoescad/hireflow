import { Mail, Download } from "lucide-react";
import type { Activity } from "@/lib/types";
export function EmailContent({ activity: a }: { activity: Activity }) {
  return (
    <div className="email-body">
      <small className="email-label">
        <Mail size={13} /> Email
      </small>
      {a.metadata.subject && <strong>{a.metadata.subject}</strong>}
      <p>{a.body || "(No message text)"}</p>
      {!!a.metadata.attachments?.length && (
        <ul className="mail-files">
          {a.metadata.attachments.map((file, index) => (
            <li key={index}>
              {file.path ? (
                <a
                  href={`/api/gmail/attachments?company=${a.company_id}&activity=${a.id}&file=${index}`}
                >
                  <Download size={15} />
                  <span>
                    {file.name}
                    <small>
                      {Math.max(1, Math.round(file.size / 1024))} KB
                    </small>
                  </span>
                </a>
              ) : (
                <span>
                  {file.name} — {file.unavailable || "Unavailable"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
