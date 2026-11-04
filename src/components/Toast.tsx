"use client";
import { useEffect } from "react";

export type ToastMsg = { ok: boolean; text: string } | null;

export default function Toast({ msg, onDone }: { msg: ToastMsg; onDone: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onDone, 4500);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  if (!msg) return null;
  return <div className={`toast ${msg.ok ? "good" : "bad"}`} role="status">{msg.text}</div>;
}
