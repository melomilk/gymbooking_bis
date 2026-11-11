"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DEMO_ACCOUNTS } from "@/lib/demoApi";
import { checkTrainerApplication, MIN_PASSWORD } from "@/lib/validate";
import { CERT_MAX_BYTES, CERT_MAX_FILES, CERT_TYPES } from "@/lib/types";
import { useAuth, useT } from "@/components/Providers";
import TrainerFields, { emptyTrainerForm, sendApplication, toApplicationInput, type TrainerForm } from "@/components/TrainerFields";

type AccountType = "Member" | "Trainer";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const { t, tr, lang } = useT();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [f, setF] = useState({ phone: "", password: "", name: "", surname: "" });
  const [accountType, setAccountType] = useState<AccountType>("Member");
  const [trainer, setTrainer] = useState<TrainerForm>(emptyTrainerForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setError(null);
    const asTrainer = mode === "up" && accountType === "Trainer";

    // Trainer: check the extra fields BEFORE the account is created
    if (asTrainer) {
      if (!trainer.consent) return setError(tr({ code: "consent_required" }));
      const bad = checkTrainerApplication(toApplicationInput(trainer), trainer.files,
        { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES });
      if (bad) return setError(tr({ code: bad }));
    }

    setBusy(true);
    const r = mode === "in"
      ? await api.login(f.phone, f.password)
      : await api.register({ name: f.name, surname: f.surname, phone: f.phone, password: f.password, lang });
    if (!r.ok) { setBusy(false); return setError(tr(r)); }

    if (asTrainer) {
      // The account already exists here. If the application fails, the profile
      // page shows why and offers to send it again.
      const a = await sendApplication(trainer);
      await refresh();
      router.push(a.ok ? "/profile" : `/profile?app_error=${encodeURIComponent(a.code)}`);
      return;
    }

    const m = await refresh();
    // FR-04: logged in, then redirected to the main page (trainers to their classes)
    router.push(m?.role === "Trainer" ? "/trainer" : "/");
  }

  return (
    <div className="auth">
      <h1>{mode === "in" ? t("login_title") : t("register_title")}</h1>
      <form onSubmit={submit} className="form" noValidate>
        {mode === "up" && (
          <div className="role-pick" role="radiogroup" aria-label={t("account_type")}>
            <span className="small muted">{t("account_type")}</span>
            <div className="role-options">
              {(["Member", "Trainer"] as const).map((x) => (
                <label key={x} className={`role-option ${accountType === x ? "active" : ""}`}>
                  <input type="radio" name="account_type" value={x} checked={accountType === x} onChange={() => { setAccountType(x); setError(null); }} />
                  <b>{t(`role_${x}`)}</b>
                  <span className="small muted">{t(`acct_${x}_desc`)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {mode === "up" && (
          <div className="row">
            <label>{t("first_name")}<input name="name" required value={f.name} onChange={set("name")} autoComplete="given-name" /></label>
            <label>{t("last_name")}<input name="surname" required value={f.surname} onChange={set("surname")} autoComplete="family-name" /></label>
          </div>
        )}
        <label>{t("phone")}<input name="phone" type="tel" required value={f.phone} onChange={set("phone")} placeholder="+7 701 123 4567" autoComplete="tel" /></label>
        <label>{t("password")}
          <input name="password" type="password" required minLength={MIN_PASSWORD} value={f.password} onChange={set("password")} autoComplete={mode === "in" ? "current-password" : "new-password"} />
          {mode === "up" && <span className="small muted">{t("password_hint")}</span>}
        </label>
        {mode === "up" && accountType === "Trainer" && (
          <>
            <TrainerFields value={trainer} onChange={setTrainer} />
            <div className="notice small">{t("trainer_register_note")}</div>
          </>
        )}
        {error && <div className="notice bad" role="alert">{error}</div>}
        <button className="btn big" disabled={busy}>{busy ? t("please_wait") : mode === "in" ? t("login_btn") : t("register_btn")}</button>
      </form>
      <p className="muted small center">
        {mode === "in" ? t("new_here") : t("have_account")}{" "}
        <button className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>
          {mode === "in" ? t("create_account") : t("login_title")}
        </button>
      </p>
      {api.mode === "demo" && (
        <div className="notice small">
          <b>{t("demo_accounts")}:</b>
          {DEMO_ACCOUNTS.map((a) => <div key={a.role}>{t(`role_${a.role}`)}: <code>{a.phone}</code> / <code>{a.password}</code></div>)}
        </div>
      )}
    </div>
  );
}
