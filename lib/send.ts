/**
 * Outbound send abstractions (Workstream E).
 *
 * TWO channels, two very different transports:
 *
 * EMAIL — sent directly by the worker via the Resend HTTP API
 * (https://api.resend.com/emails). No SDK dependency; plain fetch.
 *
 * SMS — sent from the OWNER's own phone number via the paired-device
 * `message.send` channel. A deployed worker cannot reach the phone
 * directly, so SMS takes the device-bridge path: the worker records a
 * reference-only row in `sms_outbox` (NO body — bodies render at drain
 * time with the current access instructions, contracts §4.14), and a
 * Muse-side scheduled job drains the queue with the device's message.send
 * capability. See docs/sms-device-bridge.md for the drain protocol.
 *
 * Twilio is the DOCUMENTED FALLBACK only (SMS_PROVIDER=twilio): direct
 * HTTPS send for environments where the device bridge is unavailable.
 *
 * BINDING RULES:
 * - Never log recipient addresses, message bodies, or access-instruction
 *   values. Log {event, channel, ref} only.
 * - The send-mode authorization (docs/decisions/2026-10-17-...) covers
 *   reminders + Saturday recap ONLY. This module enforces that by
 *   construction: every send goes through sendReminder/sendRecap/
 *   sendDigest/sendMessageNotification, and there is no generic
 *   "send anything to anyone" entry point.
 */
import { eq } from "drizzle-orm";
import type { Tx } from "./db";
import { smsOutbox } from "./schema";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export class SendError extends Error {
  channel: "email" | "sms";
  provider: string;
  constructor(channel: "email" | "sms", provider: string, message: string) {
    super(message);
    this.channel = channel;
    this.provider = provider;
  }
}

/** Injectable fetch for tests. Defaults to global fetch. */
type FetchFn = typeof fetch;
let fetchImpl: FetchFn = fetch;
export function __setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}
function resetFetchForTests(): void {
  fetchImpl = fetch;
}
export const __testOnly = { resetFetchForTests };

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new SendError("email", "resend", `${name} is not set`);
  return v;
}

/**
 * Send an email via Resend. Throws SendError on failure.
 * Never logs the body.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const apiKey = mustEnv("RESEND_API_KEY");
  const from = process.env.RESEND_FROM ?? "Cleanings <reminders@localhost>";
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
    });
  } catch (e) {
    throw new SendError(
      "email",
      "resend",
      `network error: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Truncate: provider error bodies can echo content; keep the signal.
    throw new SendError("email", "resend", `HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Queue an SMS for the device bridge. Reference-only: stores the reminder
 * or notification id + destination phone, NEVER the body. The drain
 * renders the body at send time. Idempotent per reference row: returns the
 * existing queue id if this reference is already queued and unsent.
 */
export async function queueSmsForDevice(
  tx: Tx,
  ref: { reminderId?: string; notificationId?: string },
  toPhone: string,
): Promise<string> {
  if (!ref.reminderId && !ref.notificationId) {
    throw new SendError("sms", "device_bridge", "queueSms requires a reference id");
  }
  const cond = ref.reminderId
    ? eq(smsOutbox.reminderId, ref.reminderId)
    : eq(smsOutbox.notificationId, ref.notificationId!);
  const existing = await tx
    .select({ id: smsOutbox.id, status: smsOutbox.status })
    .from(smsOutbox)
    .where(cond)
    .limit(1);
  if (existing[0] && existing[0].status === "pending") return existing[0].id;
  const [row] = await tx
    .insert(smsOutbox)
    .values({
      reminderId: ref.reminderId ?? null,
      notificationId: ref.notificationId ?? null,
      toPhone,
      status: "pending",
    })
    .returning({ id: smsOutbox.id });
  return row!.id;
}

/**
 * Twilio fallback sender. Used ONLY when SMS_PROVIDER=twilio.
 * Documented fallback — the device bridge is the primary path.
 */
export async function sendSmsViaTwilio(to: string, body: string): Promise<void> {
  const sid = mustEnv("TWILIO_ACCOUNT_SID");
  const token = mustEnv("TWILIO_AUTH_TOKEN");
  const from = mustEnv("TWILIO_FROM");
  let res: Response;
  try {
    res = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      },
    );
  } catch (e) {
    throw new SendError(
      "sms",
      "twilio",
      `network error: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SendError("sms", "twilio", `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Which SMS transport the worker should use. Default: device_bridge. */
export function smsProvider(): "device_bridge" | "twilio" {
  return process.env.SMS_PROVIDER === "twilio" ? "twilio" : "device_bridge";
}
