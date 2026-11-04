"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { LANGS, type Lang } from "@/lib/i18n";
import { useAuth, useT } from "./Providers";

export default function Header() {
  const { me, logout } = useAuth();
  const { t, lang, setLang } = useT();
  const path = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");

  const link = (href: string, label: string) => (
    <Link href={href} className={path === href ? "active" : ""}>{label}</Link>
  );

  return (
    <>
      {api.mode === "demo" && <div className="demo-banner">{t("demo_banner")}</div>}
      <header className="header">
        <Link href="/" className="logo">PULSE<span>GYM</span></Link>
        <nav>
          {link("/", t("nav_classes"))}
          {me && link("/profile", t("nav_profile"))}
          {me?.role === "Trainer" && link("/trainer", t("nav_trainer"))}
          {me?.role === "Admin" && link("/admin", t("nav_admin"))}
        </nav>
        <form className="searchbar" role="search" onSubmit={(e) => { e.preventDefault(); router.push(`/search?q=${encodeURIComponent(q.trim())}`); }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} aria-label={t("search_btn")} />
        </form>
        <div className="who">
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("language")} className="lang">
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          {me ? (
            <button className="btn ghost" onClick={async () => { await logout(); router.push("/"); }}>{t("logout")}</button>
          ) : (
            <Link href="/login" className="btn">{t("login")}</Link>
          )}
        </div>
      </header>
    </>
  );
}
