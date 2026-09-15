import "server-only";
import nodemailer from "nodemailer";
export async function sendInvitation(
  email: string,
  company: string,
  url: string,
) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return false;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_PORT === "465",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: `Join ${company} on HireFlow`,
    text: `You've been invited to join ${company} on HireFlow.\n\nAccept your invitation: ${url}\n\nSign in with ${email}. This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.`,
  });
  return true;
}
