"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DEMO_ACCOUNTS } from "@/lib/demoApi";
import { MIN_PASSWORD } from "@/lib/validate";
import { useAuth, useT } from "@/components/Providers";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const { t, tr, lang } = useT();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [f, setF] = useState({ phone: "", password: "", name: "", surname: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = mode === "in"
      ? await api.login(f.phone, f.password)
      : await api.register({ name: f.name, surname: f.surname, phone: f.phone, password: f.password, lang });
    if (!r.ok) { setBusy(false); return setError(tr(r)); }
    await refresh();
    router.push("/"); // FR-04: logged in and redirected to the main page
  }

  return (
    <div className="auth">
      <h1>{mode === "in" ? t("login_title") : t("register_title")}</h1>
      <form onSubmit={submit} className="form" noValidate>
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
