"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { hasKey, translate, type Key, type Lang } from "@/lib/i18n";
import type { Me, Result, Role } from "@/lib/types";

const LANG_KEY = "gym-lang";

// ---------------- language (FR-07) ----------------
type LangCtx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key, vars?: Record<string, string | number>) => string;
  /** translate a {ok, code} result from the API */
  tr: (r: Pick<Result, "code" | "message">) => string;
};
const LangContext = createContext<LangCtx>(null as unknown as LangCtx);
export const useT = () => useContext(LangContext);

// ---------------- auth (FR-04, FR-10) ----------------
type AuthCtx = { me: Me | null; loading: boolean; refresh: () => Promise<Me | null>; logout: () => Promise<void> };
const AuthContext = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(AuthContext);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const applyLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
    document.documentElement.lang = l;
  }, []);

  // kept after page reload
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANG_KEY) as Lang | null;
      if (saved === "kk" || saved === "en" || saved === "ru") applyLang(saved);
    } catch { /* ignore */ }
  }, [applyLang]);

  const refresh = useCallback(async () => {
    let m: Me | null = null;
    try { m = await api.getMe(); } catch { m = null; }
    setMe(m);
    setLoading(false);
    // kept on the next login: the member's saved language wins
    if (m?.preferred_language) applyLang(m.preferred_language);
    return m;
  }, [applyLang]);

  useEffect(() => { refresh(); }, [refresh]);

  const setLang = useCallback((l: Lang) => {
    applyLang(l);
    if (me) api.setLanguage(l).catch(() => {});
  }, [applyLang, me]);

  const t = useCallback((k: Key, vars?: Record<string, string | number>) => translate(lang, k, vars), [lang]);
  const tr = useCallback((r: Pick<Result, "code" | "message">) => {
    const k = `code_${r.code}`;
    return hasKey(k) ? translate(lang, k) : r.message || translate(lang, "code_error");
  }, [lang]);

  const logout = useCallback(async () => { await api.logout(); setMe(null); }, []);

  return (
    <LangContext.Provider value={{ lang, setLang, t, tr }}>
      <AuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AuthContext.Provider>
    </LangContext.Provider>
  );
}

/** FR-10: pages for a role. Others are redirected to the main page. */
export function useRequireRole(roles: Role[]) {
  const { me, loading } = useAuth();
  const allowed = !!me && roles.includes(me.role);
  useEffect(() => {
    if (!loading && !allowed) window.location.replace("/");
  }, [loading, allowed]);
  return { allowed, loading };
}
