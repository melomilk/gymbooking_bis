"use client";
// useState that survives moving between pages (bug 19): the value is kept in
// sessionStorage for this browser tab, so filters and half-filled forms are
// still there when the user comes back. Cleared on logout and when the tab
// is closed. Pass key = null to keep the value in memory only.
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const PREFIX = "ui:";

export function useSessionState<T>(key: string | null, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);

  // read after the first render (the server render has no sessionStorage)
  useEffect(() => {
    if (key !== null) {
      try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (raw !== null) setValue(JSON.parse(raw) as T);
      } catch { /* storage blocked or bad JSON: keep the initial value */ }
    }
    setReady(true);
  }, [key]);

  // write every change, but only after the saved value was read
  useEffect(() => {
    if (!ready || key === null) return;
    try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
  }, [key, value, ready]);

  return [value, setValue];
}

/** Forgets one remembered value (e.g. a form draft after it was sent). */
export function forgetSessionState(key: string) {
  try { sessionStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

/** Forgets every remembered filter and form draft (called on logout). */
export function clearSessionState() {
  try {
    Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
}
