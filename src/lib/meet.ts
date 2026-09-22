import "server-only";
import { OAuth2Client } from "google-auth-library";
import { adminDb, sessionDb } from "./supabase/server";
import { openGmail } from "./gmail-crypto";
import { googleMeetUrl, meetingWindowOpen, recordingUrl, type Interview } from "./interviews";

export const meetScopes = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
];
const eventsApi = "https://workspaceevents.googleapis.com/v1";
export const meetEventTypes = [
  "google.workspace.meet.conference.v2.started",
  "google.workspace.meet.conference.v2.ended",
  "google.workspace.meet.recording.v2.started",
  "google.workspace.meet.recording.v2.fileGenerated",
];
export function meetAvailable() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GMAIL_TOKEN_KEY);
}
export function meetOAuth() {
  if (!meetAvailable()) throw new Error("Google Meet is not configured on this server.");
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    `${new URL(process.env.APP_URL!).origin}/api/meet/callback`);
}
export async function meetMember(company: string, adminOnly = false) {
  const db = await sessionDb();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error("Sign in to continue.");
  const { data, error } = await db.from("hf_members").select("enabled,role")
    .eq("company_id", company).eq("user_id", user.id).maybeSingle();
  if (error || !data?.enabled || (adminOnly && data.role !== "admin"))
    throw new Error("Company access denied.");
  return { db, user };
}
type Method = "GET" | "POST" | "PATCH" | "DELETE";
export function googleApi(credentials: string) {
  const client = meetOAuth();
  client.setCredentials(openGmail<{ refresh_token: string }>(credentials));
  return async <T = unknown>(url: string, method: Method = "GET", data?: unknown) =>
    (await client.request<T>({ url, method, data, timeout: 15000, retry: false })).data;
}
type Google = ReturnType<typeof googleApi>;
type Connection = {
  company_id: string; organizer: string; google_user: string | null; credentials: string;
  generation: string; lease_id: string; events_subscription: string | null; events_expire_at: string | null;
};
type GoogleEvent = {
  id: string; status?: string; summary?: string; hangoutLink?: string;
  start?: { dateTime?: string }; end?: { dateTime?: string };
  attendees?: { email?: string; responseStatus?: string; resource?: boolean }[];
  extendedProperties?: { private?: Record<string,string> };
  conferenceData?: { createRequest?: { status?: { statusCode?: string } } };
};
type GoogleRecording = {
  name: string; state: string; startTime?: string; endTime?: string;
  driveDestination?: { file?: string; exportUri?: string };
};
type Page<K extends string, T> = { [key in K]?: T[] } & { nextPageToken?: string };
function httpStatus(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status;
}
function authFailure(error: unknown) {
  return httpStatus(error) === 401 || String((error as Error)?.message).includes("invalid_grant");
}
export function meetError(error: unknown) {
  const code = httpStatus(error);
  if (authFailure(error)) return "Google authorization expired. An admin needs to reconnect Google Meet.";
  if (code === 403) return "Google denied access. Check Calendar and Meet API permissions, organizer access, and Workspace settings.";
  if (code === 429) return "Google is busy. HireFlow will retry automatically.";
  return "Google sync failed. HireFlow will retry; existing sessions and recordings are preserved.";
}
async function pages<K extends string, T>(google: Google, url: string, key: K, deadline: number) {
  const items: T[] = [];
  let token: string | undefined;
  do {
    if (Date.now() > deadline) throw new Error("Sync deadline");
    const page: Page<K, T> = await google(url + (url.includes("?") ? "&" : "?") +
      new URLSearchParams({ pageSize: "100", ...(token ? { pageToken: token } : {}) }));
    items.push(...(page[key] || []));
    token = page.nextPageToken;
  } while (token);
  return items;
}

type Options = { budget?: number; renewEvents?: boolean };
export async function syncMeet(company: string, actor: string | null = null, sessionId?: string, options: Options = {}) {
  const db = adminDb();
  const claim = await db.rpc("hf_meet_claim", { cid: company, actor });
  if (claim.error) throw new Error("Could not start Google sync.");
  const state = claim.data.state as "ready" | "busy" | "disconnected" | "reauthorize";
  if (state !== "ready") return { synced: 0, state, error: null };
  const connection = claim.data as Connection;
  const commit = async (session: Interview | null, payload: Record<string,unknown>) => {
    const result = await db.rpc("hf_meet_commit", {
      cid: company, generation_id: connection.generation, worker: connection.lease_id,
      sid: session?.id || null, revision: session?.version || 0, payload,
    });
    if (result.error) throw new Error("Google connection changed during sync.");
    return result.data as boolean;
  };
  let synced = 0;
  let failure: string | null = null;
  const deadline = Date.now() + Math.min(options.budget ?? 180000, 180000);
  try {
    const google = googleApi(connection.credentials);
    await renewEvents(connection, google, commit, !!options.renewEvents);
    const done: string[] = [];
    while (Date.now() < deadline) {
      if (sessionId && done.length) break;
      const result = sessionId
        ? await db.from("hf_interviews").select("*").eq("company_id", company)
          .eq("organizer", connection.organizer).eq("id", sessionId)
        : await db.rpc("hf_meet_due", { cid: company, address: connection.organizer, skip: done, max_rows: 10 });
      if (result.error) throw result.error;
      const sessions = result.data as Interview[];
      if (!sessions.length) break;
      for (const session of sessions) {
        if (Date.now() > deadline) break;
        done.push(session.id);
        try { await syncSession(company, session, google, commit, deadline); synced++; }
        catch (e) {
          if (authFailure(e)) throw e;
          failure = meetError(e);
          await commit(session, { error: failure });
        }
      }
    }
  } catch (e) { failure = meetError(e); }
  finally {
    try { await commit(null, { release: failure }); } catch { /* A newer connection owns the lease. */ }
  }
  return { synced, state, error: failure };
}

async function syncSession(company: string, session: Interview, google: Google,
  commit: (session: Interview | null, payload: Record<string,unknown>) => Promise<boolean>, deadline: number) {
  const db = adminDb();
  const pending = session.version !== session.synced_version;
  // A queued change is not authority to act after its author or interviewers lose access.
  if (pending) {
    const author = session.updated_by ? await db.from("hf_members").select("enabled")
      .eq("company_id", company).eq("user_id", session.updated_by).maybeSingle() : null;
    if (!author || author.error || !author.data?.enabled) {
      await commit(session, { error: "The user who scheduled this change no longer has access. An enabled member must edit the session." });
      return;
    }
    if (!session.cancel_requested) {
      const members = await db.from("hf_members").select("user_id").eq("company_id", company)
        .in("user_id", session.interviewer_ids).eq("enabled", true);
      if (members.error || members.data.length !== session.interviewer_ids.length) {
        await commit(session, { error: "An interviewer is no longer enabled. Edit the session to select current team members." });
        return;
      }
    }
  }
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(session.organizer)}/events`;
  const eventUrl = `${base}/${session.google_event_id}`;
  let event: GoogleEvent | null = null;
  try { event = await google<GoogleEvent>(eventUrl); }
  catch (e) { if (![404, 410].includes(httpStatus(e) || 0)) throw e; }

  if (session.cancel_requested || event?.status === "cancelled") {
    if (session.cancel_requested && event && event.status !== "cancelled") {
      try { await google(eventUrl + "?sendUpdates=all", "DELETE"); }
      catch (e) { if (![404, 410].includes(httpStatus(e) || 0)) throw e; }
    }
    await commit(session, { sync: { status: "cancelled" }, observed: await observe(session, session.meet_space, google, deadline) });
    return;
  }
  if (!event && session.synced_version > 0) {
    await commit(session, { error: "The Google Calendar event is missing from the organizer's calendar. Check the connected account, or cancel and reschedule." });
    return;
  }
  const known = new Map((event?.attendees || []).map(a => [a.email?.toLowerCase(), a.responseStatus]));
  const body = {
    summary: session.title,
    start: { dateTime: session.starts_at, timeZone: session.timezone },
    end: { dateTime: session.ends_at, timeZone: session.timezone },
    attendees: session.attendees.map(a => ({ email: a.email, responseStatus: known.get(a.email) || a.responseStatus || "needsAction" })),
    guestsCanModify: false, guestsCanInviteOthers: false,
    extendedProperties: { private: { hireflow_session: session.id, hireflow_company: company, hireflow_revision: String(session.version) } },
  };
  if (!event) {
    try {
      event = await google<GoogleEvent>(base + "?conferenceDataVersion=1&sendUpdates=all", "POST", {
        ...body, id: session.google_event_id,
        conferenceData: { createRequest: { requestId: session.id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      });
    } catch (e) {
      if (httpStatus(e) !== 409) throw e;
      event = await google<GoogleEvent>(eventUrl);
    }
  } else if (pending && event.extendedProperties?.private?.hireflow_revision !== String(session.version)) {
    event = await google<GoogleEvent>(eventUrl + "?sendUpdates=all", "PATCH", body);
  }
  const meetUrl = googleMeetUrl(event.hangoutLink);
  if (!meetUrl) {
    const failed = event.conferenceData?.createRequest?.status?.statusCode === "failure";
    await commit(session, { error: failed
      ? "Google could not create the Meet link. Check the organizer's Meet access and reconnect."
      : "Google is preparing the Meet link. It will appear after the next sync." });
    return;
  }
  let space = session.meet_space;
  let setup = session.recording_setup;
  let setupError = session.recording_error;
  if (!space || pending || setup === "pending" || setup === "failed") {
    try {
      space ||= (await google<{ name: string }>(`https://meet.googleapis.com/v2/spaces/${meetUrl.split("/").pop()}`)).name;
      // Only the organizer can pre-configure artifacts. Keep transcripts and Gemini notes off.
      await google(`https://meet.googleapis.com/v2/${space}?updateMask=config.artifactConfig.recordingConfig.autoRecordingGeneration,config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration,config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration`, "PATCH", {
        config: { artifactConfig: {
          recordingConfig: { autoRecordingGeneration: session.auto_record ? "ON" : "OFF" },
          transcriptionConfig: { autoTranscriptionGeneration: "OFF" },
          smartNotesConfig: { autoSmartNotesGeneration: "OFF" },
        } },
      });
      setup = session.auto_record ? "on" : "off";
      setupError = null;
    } catch (e) {
      if (authFailure(e)) throw e;
      setup = "failed";
      setupError = "Automatic recording could not be configured. " + meetError(e);
    }
  }
  const attendees = (event.attendees || []).filter(a => a.email && !a.resource)
    .map(a => ({ email: a.email!.toLowerCase(), responseStatus: a.responseStatus || "needsAction" }));
  await commit(session, {
    sync: { status: "scheduled", meet_url: meetUrl, meet_space: space, title: event.summary,
      attendees: attendees.length ? attendees : undefined, recording_setup: setup, recording_error: setupError,
      starts_at: event.start?.dateTime, ends_at: event.end?.dateTime },
    observed: await observe(session, space, google, deadline),
  });
}

// Conference records expire after 30 days, so the facts are saved as soon as they are seen.
// A failed check is omitted and retried on the next sync instead of blocking scheduling updates.
async function observe(session: Interview, space: string | null, google: Google, deadline: number) {
  if (!space || !meetingWindowOpen(session)) return undefined;
  try { return await meetingFacts(space, google, deadline); }
  catch (e) { if (authFailure(e)) throw e; return undefined; }
}
async function meetingFacts(space: string, google: Google, deadline: number) {
  const conferences = await pages<"conferenceRecords", { name: string; startTime?: string; endTime?: string }>(
    google, `https://meet.googleapis.com/v2/conferenceRecords?${new URLSearchParams({ filter: `space.name = "${space}"` })}`,
    "conferenceRecords", deadline);
  if (!conferences.length) return undefined;
  const recordings = [];
  for (const conference of conferences) {
    const found = await pages<"recordings", GoogleRecording>(google,
      `https://meet.googleapis.com/v2/${conference.name}/recordings`, "recordings", deadline);
    recordings.push(...found.map(r => ({
      name: r.name, conference: conference.name, state: r.state, starts_at: r.startTime || null, ends_at: r.endTime || null,
      drive_file_id: r.driveDestination?.file || null,
      playback_url: recordingUrl(r.driveDestination?.exportUri, r.driveDestination?.file),
    })));
  }
  const starts = conferences.map(c => c.startTime).filter(Boolean).sort();
  const ended = conferences.every(c => c.endTime);
  return {
    started_at: starts[0] || null,
    ended_at: ended ? conferences.map(c => c.endTime!).sort().at(-1) : null,
    recordings,
  };
}

// Workspace Events push conference and recording changes; the scheduled sync remains the recovery path.
async function renewEvents(connection: Connection, google: Google,
  commit: (session: Interview | null, payload: Record<string,unknown>) => Promise<boolean>, force: boolean) {
  const topic = process.env.MEET_EVENTS_TOPIC;
  if (!topic || !connection.google_user) return;
  const expires = connection.events_expire_at ? Date.parse(connection.events_expire_at) : 0;
  if (!force && connection.events_subscription && expires - Date.now() > 2 * 86400000) return;
  const target = `//cloudidentity.googleapis.com/users/${connection.google_user}`;
  type Subscription = { name: string; state?: string; expireTime?: string; notificationEndpoint?: { pubsubTopic?: string } };
  try {
    let current: Subscription | null = null;
    if (connection.events_subscription) {
      try { current = await google<Subscription>(`${eventsApi}/${connection.events_subscription}`); }
      catch (e) { if (httpStatus(e) !== 404) throw e; }
    }
    if (current?.state === "SUSPENDED") await google(`${eventsApi}/${current.name}:reactivate`, "POST", {});
    else if (current) await google(`${eventsApi}/${current.name}?updateMask=ttl`, "PATCH", { ttl: "0s" });
    else {
      try {
        await google(`${eventsApi}/subscriptions`, "POST", {
          targetResource: target, eventTypes: meetEventTypes,
          notificationEndpoint: { pubsubTopic: topic }, payloadOptions: { includeResource: false },
        });
      } catch (e) { if (httpStatus(e) !== 409) throw e; }
    }
    // Subscription changes are long-running operations; read the current state back.
    const filter = `event_types:"${meetEventTypes[0]}" AND target_resource="${target}"`;
    const list = await google<{ subscriptions?: Subscription[] }>(`${eventsApi}/subscriptions?${new URLSearchParams({ filter })}`);
    const found = list.subscriptions?.find(s => s.notificationEndpoint?.pubsubTopic === topic);
    await commit(null, { events: {
      subscription: found?.name || null, expire_at: found?.expireTime || null,
      error: found ? null : "Google is still creating the instant-update subscription.",
    } });
  } catch (e) {
    if (authFailure(e)) throw e;
    await commit(null, { events: { error: "Instant updates are unavailable, so HireFlow checks Google every few minutes. " + meetError(e) } });
  }
}

// Maps a Workspace event to its interview and syncs that session. Returns true when Google should redeliver.
export async function handleMeetEvent(subscription: string, type: string, data: { conferenceRecord?: { name?: string }; recording?: { name?: string } }) {
  const db = adminDb();
  const { data: connections, error } = await db.from("hf_meet_connections").select("company_id,credentials")
    .eq("events_subscription", subscription).not("credentials", "is", null);
  if (error) throw new Error("Could not load Google connections.");
  let retry = false;
  for (const connection of connections) {
    if (type.startsWith("google.workspace.events.subscription.")) {
      retry ||= (await syncMeet(connection.company_id, null, undefined, { budget: 50000, renewEvents: true })).state === "busy";
      continue;
    }
    const conference = (data.conferenceRecord?.name || data.recording?.name || "").match(/^conferenceRecords\/[^/]+/)?.[0];
    if (!conference) continue;
    const record = await googleApi(connection.credentials)<{ space?: string }>(`https://meet.googleapis.com/v2/${conference}`);
    const session = await db.from("hf_interviews").select("id").eq("company_id", connection.company_id)
      .eq("meet_space", record.space || "").limit(1).maybeSingle();
    if (session.error || !session.data) continue;
    retry ||= (await syncMeet(connection.company_id, null, session.data.id, { budget: 50000 })).state === "busy";
  }
  return retry;
}

// Removes the event subscription and revokes the grant unless another connection still uses this Google account.
export async function releaseGoogle(credentials: string, organizer: string, subscription: string | null) {
  const db = adminDb();
  const google = googleApi(credentials);
  if (subscription) {
    try { await google(`${eventsApi}/${subscription}`, "DELETE"); } catch { /* Expires within seven days. */ }
  }
  const [meet, gmail] = await Promise.all([
    db.from("hf_meet_connections").select("company_id", { count: "exact", head: true }).eq("organizer", organizer).not("credentials", "is", null),
    db.from("hf_gmail_connections").select("company_id", { count: "exact", head: true }).eq("mailbox", organizer).not("credentials", "is", null),
  ]);
  if (meet.error || gmail.error || meet.count || gmail.count) return;
  try { await meetOAuth().revokeToken(openGmail<{ refresh_token: string }>(credentials).refresh_token); }
  catch { /* Already revoked. */ }
}
