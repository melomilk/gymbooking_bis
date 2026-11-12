// FR-04 registration (Supabase mode). Creates a confirmed auth user with the
// service-role key, so no confirmation email is needed. The key stays on the
// server. Without the key, the client falls back to a normal sign-up.
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MIN_PASSWORD, normalizePhone, phoneToAuthEmail, validName } from "@/lib/validate";

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, code: "error", fallback: true });

  const b = await req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  const surname = String(b.surname ?? "").trim();
  const phone = normalizePhone(String(b.phone ?? ""));
  const password = String(b.password ?? "");
  const lang = ["kk", "en", "ru"].includes(b.lang) ? b.lang : "en";

  if (!validName(name) || !validName(surname)) return NextResponse.json({ ok: false, code: "invalid_name" });
  if (!phone) return NextResponse.json({ ok: false, code: "invalid_phone" });
  if (password.length < MIN_PASSWORD) return NextResponse.json({ ok: false, code: "weak_password" });

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Sign-up rate limit (migration_signup_rate_limit.sql). If the migration is
  // not applied yet, the call fails and registration goes on as before.
  const limited = await rateLimited(admin);
  if (limited) return NextResponse.json(limited);

  const { data: existing } = await admin.from("members").select("member_id").eq("phone_number", phone).maybeSingle();
  if (existing) return NextResponse.json({ ok: false, code: "phone_taken" });

  const { error } = await admin.auth.admin.createUser({
    email: phoneToAuthEmail(phone),
    password,
    email_confirm: true,
    user_metadata: { member_name: name, member_surname: surname, phone_number: phone, preferred_language: lang },
  });
  if (error) {
    // the database trigger refused the user: the limit was reached meanwhile
    const late = await rateLimited(admin);
    if (late) return NextResponse.json(late);
    const m = error.message.toLowerCase();
    if (m.includes("already") || error.code === "email_exists") return NextResponse.json({ ok: false, code: "phone_taken" });
    if (m.includes("password")) return NextResponse.json({ ok: false, code: "weak_password" });
    return NextResponse.json({ ok: false, code: "error", message: error.message });
  }
  return NextResponse.json({ ok: true, code: "created" });
}

/** `{ok:false, code:"rate_limited", retry_after}` when the per-minute sign-up limit is reached, else null. */
async function rateLimited(admin: SupabaseClient) {
  const { data, error } = await admin.rpc("signup_rate_status");
  const st = data as { allowed?: boolean; retry_after?: number } | null;
  if (error || !st || st.allowed !== false) return null;
  return { ok: false, code: "rate_limited", retry_after: st.retry_after ?? 60 };
}
