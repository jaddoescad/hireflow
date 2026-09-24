import "server-only";
import nodemailer from "nodemailer";
import { interviewNotificationMessage, type InterviewNotification } from "./interviews";
function mailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_PORT === "465",
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
}
export async function sendInvitation(
  email: string,
  company: string,
  url: string,
) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return false;
  await mailTransport().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: `Join ${company} on HireFlow`,
    text: `You've been invited to join ${company} on HireFlow.\n\nAccept your invitation: ${url}\n\nSign in with ${email}. This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.`,
  });
  return true;
}

export async function sendInterviewNotification(session: InterviewNotification) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
    throw new Error("Organizer email delivery is not configured.");
  const result = await mailTransport().sendMail({
    from: process.env.SMTP_FROM,
    // An address object prevents an unexpected comma from becoming another recipient.
    to: { name: "", address: session.organizer },
    messageId: `<interview-${session.company_id}-${session.id}-${session.version}@${new URL(process.env.APP_URL!).hostname}>`,
    ...interviewNotificationMessage(session),
  });
  if (!result.accepted.length || result.rejected.length)
    throw new Error("Organizer email was not accepted for delivery.");
}
