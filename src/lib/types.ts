export type Company = { id: string; name: string; created_by: string };
export type Member = {
  company_id: string;
  user_id: string;
  email: string;
  role: "admin" | "member";
  enabled: boolean;
};
export type Stage = {
  id: string;
  company_id: string;
  name: string;
  position: number;
  color: string;
};
export type Candidate = {
  id: string;
  company_id: string;
  stage_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  job_title: string;
  experience: string;
  tags: string[];
  source: string;
  source_id?: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  score_average?: number | null;
  score_count?: number;
};
export type Activity = {
  id: string;
  company_id: string;
  candidate_id: string | null;
  kind: "sms" | "call" | "note" | "stage" | "email";
  direction: "incoming" | "outgoing" | null;
  body: string;
  phone: string | null;
  email: string | null;
  occurred_at: string;
  read_at: string | null;
  metadata: {
    subject?: string;
    attachments?: {
      path?: string;
      name: string;
      size: number;
      unavailable?: string;
    }[];
    [key: string]: unknown;
  };
};
export type Invitation = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};
export type ScoreCategory = {
  id: string;
  company_id: string;
  name: string;
  description: string;
  position: number;
  archived_at: string | null;
};
export type CandidateScore = {
  company_id: string;
  candidate_id: string;
  category_id: string;
  rating: number | null;
  note: string;
  updated_by: string | null;
  updated_at: string;
  version: number;
};
export type ScorecardData = {
  categories: ScoreCategory[];
  scores: CandidateScore[];
};
export type Workspace = {
  companies: Company[];
  company: Company | null;
  membership: Member | null;
  members: Member[];
  stages: Stage[];
  score_categories: ScoreCategory[];
  candidates: Candidate[];
  activities: Activity[];
  invitations: Invitation[];
  integration: {
    google_available: boolean;
    google_connected: boolean;
    google_account: string | null;
    gmail_synced_at: string | null;
    gmail_error: string | null;
    recording_storage: boolean;
    intake_configured: boolean;
    quo_configured: boolean;
    quo_phone: string | null;
    quo_phone_id: string | null;
    last_intake_at: string | null;
    last_quo_at: string | null;
  } | null;
  user: { id: string; email: string };
};
