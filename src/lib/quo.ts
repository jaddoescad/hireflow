import { z } from "zod";
import { normalizePhone } from "./validation";
const event = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string(),
      phoneNumberId: z.string(),
      direction: z.enum(["incoming", "outgoing"]),
      from: z.string().optional(),
      to: z.union([z.string(), z.array(z.string())]).optional(),
      participants: z.array(z.string()).optional(),
      body: z.string().optional(),
      text: z.string().optional(),
      status: z.string().optional(),
      duration: z.number().optional(),
      createdAt: z.string(),
      completedAt: z.string().nullable().optional(),
      answeredAt: z.string().nullable().optional(),
    }),
  }),
});
export function parseQuoEvent(
  input: unknown,
  lineId: string,
  linePhone: string,
) {
  const e = event.parse(input);
  const obj = e.data.object;
  if (obj.phoneNumberId !== lineId) return null;
  const kind = e.type.startsWith("message.")
    ? "sms"
    : e.type === "call.completed"
      ? "call"
      : null;
  if (!kind) return null;
  const to = Array.isArray(obj.to) ? obj.to : obj.to ? [obj.to] : [];
  const numbers =
    obj.participants || [obj.from, ...to].filter((v): v is string => !!v);
  const peers = [
    ...new Set(
      numbers
        .map((v) => {
          try {
            return normalizePhone(v);
          } catch {
            return "";
          }
        })
        .filter((p) => p && p !== linePhone),
    ),
  ];
  if (peers.length !== 1) return null;
  const occurred_at = obj.completedAt || obj.createdAt;
  // Quo marks every finished call "completed"; only answeredAt says whether someone picked up.
  const answer =
    kind === "call" && obj.answeredAt !== undefined
      ? obj.answeredAt
        ? "answered"
        : obj.direction === "incoming"
          ? "missed"
          : "no answer"
      : obj.status;
  if (!Number.isFinite(Date.parse(occurred_at)))
    throw new Error("Invalid event timestamp");
  return {
    kind,
    direction: obj.direction,
    phone: peers[0],
    email: null,
    body:
      kind === "sms"
        ? obj.body || obj.text || "Attachment"
        : `${obj.direction === "incoming" ? "Incoming" : "Outgoing"} call${answer ? ` · ${answer}` : ""}${obj.duration ? ` · ${obj.duration}s` : ""}`,
    external_id: `quo:${kind}:${obj.id}`,
    occurred_at,
    metadata: {
      status: obj.status,
      duration: obj.duration,
      quo_id: obj.id,
      ...(kind === "call" && obj.answeredAt !== undefined
        ? { answered_at: obj.answeredAt }
        : {}),
    },
  };
}
