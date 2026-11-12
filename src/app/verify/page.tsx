"use client";
// Phone confirmation step shown right after registration.
// IMITATION for the course project: no SMS is sent and no code is stored.
// Any 6 digits are accepted; nothing is saved to the database.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useT } from "@/components/Providers";

const CODE_LEN = 6;
const SEND_MS = 2500;   // "sending the SMS…"
const CHECK_MS = 1500;  // "checking the code…"
const DONE_MS = 1200;   // "phone confirmed ✓" before leaving
const RESEND_S = 30;

type Phase = "sending" | "enter" | "checking" | "done";

/** Only internal paths, so ?next= can't send the user to another site. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/** +77015550101 -> +7 701 ***-**-01 */
function maskPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length < 11) return p;
  // non-breaking space and hyphens, so the number never wraps in the middle
  return `+${d.slice(0, d.length - 10)}\u00a0${d.slice(-10, -7)}\u00a0***\u2011**\u2011${d.slice(-2)}`;
}

export default function VerifyPage() {
  const router = useRouter();
  const { me, loading } = useAuth();
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("sending");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(RESEND_S);
  const [next, setNext] = useState("/");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setNext(safeNext(new URLSearchParams(window.location.search).get("next"))); }, []);

  // only for a logged-in user (the page comes right after registration)
  useEffect(() => { if (!loading && !me) router.replace("/login"); }, [loading, me, router]);

  // "send" the SMS
  useEffect(() => {
    if (phase !== "sending") return;
    const id = setTimeout(() => { setPhase("enter"); setResendIn(RESEND_S); }, SEND_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // resend countdown
  useEffect(() => {
    if (phase !== "enter" || resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, resendIn]);

  useEffect(() => { if (phase === "enter") input.current?.focus(); }, [phase]);

  const submit = useCallback((value: string) => {
    if (value.length !== CODE_LEN) { setError(t("verify_need_digits", { n: CODE_LEN })); return; }
    setError(null);
    setPhase("checking");
    setTimeout(() => {
      setPhase("done");
      setTimeout(() => router.replace(next), DONE_MS);
    }, CHECK_MS);
  }, [next, router, t]);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.replace(/\D/g, "").slice(0, CODE_LEN);
    setCode(v);
    setError(null);
    if (v.length === CODE_LEN) submit(v); // auto-check when 6 digits are typed or pasted
  }

  if (loading || !me) return <p className="muted">{t("loading")}</p>;
  const phone = maskPhone(me.phone_number);

  return (
    <div className="auth verify">
      <h1>{t("verify_title")}</h1>

      {phase === "sending" && (
        <div className="verify-status" role="status">
          <span className="spinner" aria-hidden />
          <p>{t("verify_sending", { phone })}</p>
        </div>
      )}

      {(phase === "enter" || phase === "checking") && (
        <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); submit(code); }}>
          <p>{t("verify_sent", { phone })}</p>
          <label>{t("verify_code_label")}
            <input ref={input} className="code-input" value={code} onChange={onChange} disabled={phase === "checking"}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LEN}
              placeholder={"•".repeat(CODE_LEN)} aria-describedby="verify-hint" />
          </label>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <button className="btn big" disabled={phase === "checking"}>
            {phase === "checking" ? t("verify_checking") : t("verify_btn")}
          </button>
          <p className="small muted center">
            {resendIn > 0
              ? t("verify_resend_in", { s: resendIn })
              : <button type="button" className="link" onClick={() => { setCode(""); setError(null); setPhase("sending"); }}>{t("verify_resend")}</button>}
          </p>
          <p id="verify-hint" className="small muted center">{t("verify_demo_hint")}</p>
        </form>
      )}

      {phase === "done" && (
        <div className="verify-status good" role="status">
          <span className="check-mark" aria-hidden>✓</span>
          <p><b>{t("verify_done")}</b></p>
        </div>
      )}
    </div>
  );
}
