import type { Api } from "./types";
import { demoApi } from "./demoApi";
import { supabaseApi } from "./supabaseApi";

export const isSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export const api: Api = isSupabaseConfigured ? supabaseApi : demoApi;
