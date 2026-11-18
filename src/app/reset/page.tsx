"use client";
// Forgotten password. IMITATION for the course project: no SMS is sent. A random
// 6-digit code is made on the server and shown here as the "SMS"; only that
// exact code (within 10 minutes) lets the user set a new password.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth, useT } from "@/components/Providers";
import { maskPhone } from "@/lib/format";
import { MIN_PASSWORD, normalizePhone } from "@/lib/validate";

const CODE_LEN = 6;
const SEND_MS = 1500; // "sending the SMS…"

type Phase = "phone" | "sending" | "code" | "saving" | "done";

export default function ResetPasswordPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const { t, tr } = useT();
  const [phase, setPhase] = useState<Phase>("phone");
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState<{ smsCode: string; token: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState({ a: "", b: "" });
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  // the login page passes the number that was already typed
  useEffect(() => { setPhone(new URLSearchParams(window.location.search).get("phone") ?? ""); }, []);
  useEffect(() => { if (phase === "code") codeInput.current?.focus(); }, [phase]);

  async function sendCode() {
    setError(null);
    if (!normalizePhone(phone)) return setError(tr({ code: "invalid_phone" }));
    setPhase("sending");
    const [r] = await Promise.all([api.requestPasswordReset(phone), new Promise((ok) => setTimeout(ok, SEND_MS))]);
    if (!r.ok || !r.sms_code || !r.token) { setPhase("phone"); return setError(tr(r)); }
    setSent({ smsCode: r.sms_code, token: r.token });
    setCode(""); setPw({ a: "", b: "" });
    setPhase("code");
  }

  async function save(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!sent) return;
    setError(null);
    if (code.length !== CODE_LEN) return setError(t("verify_need_digits", { n: CODE_LEN }));
    if (pw.a.length < MIN_PASSWORD) return setError(tr({ code: "weak_password" }));
    if (pw.a !== pw.b) return setError(tr({ code: "passwords_differ" }));
    setPhase("saving");
    const r = await api.resetPassword({ phone, token: sent.token, smsCode: code, password: pw.a });
    if (!r.ok) {
      setPhase("code");
      if (r.code === "reset_bad_code") setCode("");
      return setError(tr(r));
    }
    setPhase("done");
    // log in with the new password straight away
    const l = await api.login(phone, pw.a);
    if (l.ok) await refresh();
    setTimeout(() => router.replace(l.ok ? "/" : "/login"), 1200);
  }

  return (
    <div className="auth verify">
      <h1>{t("reset_title")}</h1>

      {phase === "phone" && (
        <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
          <p className="muted">{t("reset_intro")}</p>
          <label>{t("phone")}
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 701 123 4567" autoComplete="tel" />
          </label>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <button className="btn big">{t("reset_send_btn")}</button>
        </form>
      )}

      {phase === "sending" && (
        <div className="verify-status" role="status">
          <span className="spinner" aria-hidden />
          <p>{t("verify_sending", { phone: maskPhone(normalizePhone(phone) ?? phone) })}</p>
        </div>
      )}

      {(phase === "code" || phase === "saving") && sent && (
        <form className="form" noValidate onSubmit={save}>
          {/* the imitated SMS */}
          <div className="notice good" role="status">{t("reset_sms_demo", { phone: maskPhone(normalizePhone(phone) ?? phone), code: sent.smsCode })}</div>
          <label>{t("verify_code_label")}
            <input ref={codeInput} className="code-input" value={code} disabled={phase === "saving"}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LEN)); setError(null); }}
              inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_LEN} placeholder={"•".repeat(CODE_LEN)} />
          </label>
          <label>{t("reset_new_password")}
            <input type="password" value={pw.a} disabled={phase === "saving"} autoComplete="new-password"
              onChange={(e) => setPw({ ...pw, a: e.target.value })} />
            <span className="small muted">{t("password_hint")}</span>
          </label>
          <label>{t("reset_repeat_password")}
            <input type="password" value={pw.b} disabled={phase === "saving"} autoComplete="new-password"
              onChange={(e) => setPw({ ...pw, b: e.target.value })} />
          </label>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <button className="btn big" disabled={phase === "saving"}>{phase === "saving" ? t("please_wait") : t("reset_btn")}</button>
          <p className="small muted center">
            <button type="button" className="link" disabled={phase === "saving"} onClick={sendCode}>{t("reset_resend")}</button>
          </p>
        </form>
      )}

      {phase === "done" && (
        <div className="verify-status good" role="status">
          <span className="check-mark" aria-hidden>✓</span>
          <p><b>{t("reset_done_msg")}</b></p>
        </div>
      )}

      {phase !== "done" && <p className="small muted center"><Link href="/login">{t("reset_back")}</Link></p>}
    </div>
  );
}
