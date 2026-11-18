// Forgotten password (Supabase mode). IMITATION for the course project:
// no SMS is sent. "send" makes a random 6-digit code and returns it, so the
// page can show it as the "SMS". "confirm" changes the password only if the
// code matches the one that was sent and is less than 10 minutes old.
//
// Nothing is stored: the answer to "send" carries a token = expiry time +
// HMAC(phone, code, expiry) signed with the service key, so the server can
// check later that this exact code was sent for this phone. A token can't be
// made without the key.
//
// Staff accounts (Admin, Receptionist) can't be reset here, so the admin
// account can't be taken over through this imitation.
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MIN_PASSWORD, normalizePhone } from "@/lib/validate";

const TTL_MS = 10 * 60_000;
const sign = (secret: string, phone: string, code: string, expires: number) =>
  createHmac("sha256", secret).update(`reset:${phone}:${code}:${expires}`).digest("base64url");
const reply = (body: Record<string, unknown>) => NextResponse.json(body);

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply({ ok: false, code: "reset_unavailable" });

  const b = await req.json().catch(() => ({}));
  const phone = normalizePhone(String(b.phone ?? ""));
  if (!phone) return reply({ ok: false, code: "invalid_phone" });

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: member } = await admin.from("members").select("auth_user_id, role").eq("phone_number", phone).maybeSingle();
  if (!member?.auth_user_id) return reply({ ok: false, code: "reset_unknown_phone" });
  if (member.role === "Admin" || member.role === "Receptionist") return reply({ ok: false, code: "reset_staff" });

  if (b.action === "send") {
    const smsCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = Date.now() + TTL_MS;
    return reply({ ok: true, code: "reset_code_sent", sms_code: smsCode, token: `${expires}.${sign(key, phone, smsCode, expires)}` });
  }

  if (b.action === "confirm") {
    const smsCode = String(b.sms_code ?? "");
    const password = String(b.password ?? "");
    const [expiresRaw, mac] = String(b.token ?? "").split(".");
    const expires = Number(expiresRaw);
    if (!expires || !mac) return reply({ ok: false, code: "reset_bad_code" });
    const expected = Buffer.from(sign(key, phone, smsCode, expires));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply({ ok: false, code: "reset_bad_code" });
    if (Date.now() > expires) return reply({ ok: false, code: "reset_expired" });
    if (password.length < MIN_PASSWORD) return reply({ ok: false, code: "weak_password" });

    const { error } = await admin.auth.admin.updateUserById(member.auth_user_id, { password });
    if (error) {
      const weak = error.message.toLowerCase().includes("password");
      return reply({ ok: false, code: weak ? "weak_password" : "error", message: error.message });
    }
    return reply({ ok: true, code: "reset_done" });
  }

  return reply({ ok: false, code: "error" });
}
