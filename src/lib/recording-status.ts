import type { Recording } from "./interviews";

export function recordingStatus(r: Pick<Recording, "state" | "join_at" | "storage_key" | "storage_error" | "fireflies_id" | "has_video">) {
  if (r.fireflies_id) return r.has_video ? "Ready to watch" : "Transcript ready";
  if (r.storage_key) return "Saved for your team";
  switch (r.state) {
    case "scheduled": return r.join_at ? "Recorder booked" : "Recorder on the way";
    case "joining": return "Recorder joining";
    case "waiting": return "Recorder requested";
    case "recording": return "Recording now";
    case "processing": return "Processing";
    case "done": return "Recording unavailable";
    case "failed": return "No recording";
    default: return "Cancelled";
  }
}
