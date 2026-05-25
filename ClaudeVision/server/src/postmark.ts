import { c } from "./console-theme.js";

// Minimal Postmark client — single endpoint (/email), JSON body, no SDK.
// Reads POSTMARK_API_KEY + POSTMARK_FROM_EMAIL at call time so a process
// can be reconfigured without a restart in tests.
//
// If POSTMARK_API_KEY is unset, sends are skipped and the reset URL is
// logged to the operator console instead — this keeps local dev usable
// without a real Postmark account, while still surfacing the link so the
// developer can paste it into their browser.

const POSTMARK_URL = "https://api.postmarkapp.com/email";

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

interface PostmarkErrorBody {
  ErrorCode?: number;
  Message?: string;
}

export async function sendPasswordResetEmail(
  toEmail: string,
  resetUrl: string
): Promise<SendResult> {
  const apiKey = process.env.POSTMARK_API_KEY?.trim();
  const fromEmail = process.env.POSTMARK_FROM_EMAIL?.trim();

  if (!apiKey || !fromEmail) {
    console.log(
      c.warn(
        `[Postmark] POSTMARK_API_KEY or POSTMARK_FROM_EMAIL not set — logging reset URL instead of sending.`
      )
    );
    console.log(c.dim(`   To:  ${toEmail}`));
    console.log(c.dim(`   URL: ${resetUrl}`));
    return { ok: true, skipped: true };
  }

  const subject = "Reset your Aside password";
  const textBody = [
    "Someone (hopefully you) asked to reset the password on your Aside account.",
    "",
    "Open this link within the next hour to set a new password:",
    resetUrl,
    "",
    "If you didn't request this, you can safely ignore this email — your password won't change.",
  ].join("\n");

  // SECURITY: only the URL is interpolated into the HTML, and the URL is
  // server-generated (token is hex from crypto.randomBytes + a server-side
  // base URL), so there's no untrusted content to escape here.
  const htmlBody = `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; color: #1A1714; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
  <h2 style="font-weight: 500; font-size: 22px; margin: 0 0 16px;">Reset your Aside password</h2>
  <p style="line-height: 1.55; margin: 0 0 16px;">Someone (hopefully you) asked to reset the password on your Aside account.</p>
  <p style="margin: 24px 0;">
    <a href="${resetUrl}" style="display: inline-block; padding: 12px 20px; background: #6FE3A8; color: #1A1714; border-radius: 8px; text-decoration: none; font-weight: 500;">Set a new password</a>
  </p>
  <p style="font-size: 13px; color: #7B7468; line-height: 1.55; margin: 0 0 16px;">Or paste this link into your browser:<br/><span style="word-break: break-all;">${resetUrl}</span></p>
  <p style="font-size: 13px; color: #7B7468; line-height: 1.55; margin: 24px 0 0;">This link expires in one hour. If you didn't request a reset, ignore this email — your password won't change.</p>
</body></html>`;

  try {
    const res = await fetch(POSTMARK_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": apiKey,
      },
      body: JSON.stringify({
        From: fromEmail,
        To: toEmail,
        Subject: subject,
        TextBody: textBody,
        HtmlBody: htmlBody,
        MessageStream: "outbound",
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as PostmarkErrorBody;
      const detail = body?.Message
        ? `${body.ErrorCode ?? res.status}: ${body.Message}`
        : `HTTP ${res.status}`;
      console.log(c.error(`[Postmark] send failed — ${detail}`));
      return { ok: false, error: detail };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(c.error(`[Postmark] network error — ${msg}`));
    return { ok: false, error: msg };
  }
}
