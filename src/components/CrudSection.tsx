"use client";
import { useState } from "react";
import type { Key } from "@/lib/i18n";
import type { Result, Row } from "@/lib/types";
import { useT } from "./Providers";
import Modal from "./Modal";

export type Form = Record<string, string>;
export type Field = {
  key: string; label: Key; required?: boolean;
  type: "text" | "number" | "textarea" | "select" | "date" | "time" | "tel" | "email";
  options?: { value: string; label: string }[];
};
export type CrudConfig = {
  rows: Row[];
  id: (r: Row) => number;
  columns: { label: Key; cell: (r: Row) => React.ReactNode }[];
  fields: Field[];
  canCreate?: boolean;
  canDelete?: boolean;
  blank?: () => Form;
  toForm: (r: Row) => Form;
  /** returns the row to save, or an error code */
  fromForm: (f: Form) => Row | string;
  onChange?: (f: Form, key: string) => Form;
  save: (id: number | null, row: Row) => Promise<Result>;
  remove?: (id: number) => Promise<Result>;
  toolbar?: React.ReactNode;
};

export default function CrudSection({ cfg, onResult }: { cfg: CrudConfig; onResult: (r: Result) => void }) {
  const { t } = useT();
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!editing) return;
    const missing = cfg.fields.some((f) => f.required && !String(editing.form[f.key] ?? "").trim());
    if (missing) return onResult({ ok: false, code: "required" });
    const row = cfg.fromForm(editing.form);
    if (typeof row === "string") return onResult({ ok: false, code: row });
    setBusy(true);
    const r = await cfg.save(editing.id, row);
    setBusy(false);
    onResult(r);
    if (r.ok) setEditing(null);
  }

  function change(key: string, value: string) {
    if (!editing) return;
    let form = { ...editing.form, [key]: value };
    if (cfg.onChange) form = cfg.onChange(form, key);
    setEditing({ ...editing, form });
  }

  return (
    <div className="crud">
      <div className="toolbar">
        {cfg.canCreate !== false && cfg.blank && (
          <button className="btn" onClick={() => setEditing({ id: null, form: cfg.blank!() })}>+ {t("add_new")}</button>
        )}
        {cfg.toolbar}
      </div>

      {editing && (
        <form className="editor" onSubmit={submit} noValidate>
          <div className="editor-grid">
            {cfg.fields.map((f) => (
              <label key={f.key} className={f.type === "textarea" ? "wide" : ""}>
                {t(f.label)}{f.required ? " *" : ""}
                {f.type === "select" ? (
                  <select name={f.key} value={editing.form[f.key] ?? ""} onChange={(e) => change(f.key, e.target.value)}>
                    {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea name={f.key} rows={2} value={editing.form[f.key] ?? ""} onChange={(e) => change(f.key, e.target.value)} />
                ) : (
                  <input name={f.key} type={f.type} value={editing.form[f.key] ?? ""} min={f.type === "number" ? 1 : undefined}
                    onChange={(e) => change(f.key, e.target.value)} />
                )}
              </label>
            ))}
          </div>
          <div className="editor-actions">
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>{t("discard")}</button>
            <button className="btn" disabled={busy}>{busy ? t("please_wait") : t("save")}</button>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr>{cfg.columns.map((c) => <th key={c.label}>{t(c.label)}</th>)}<th>{t("actions")}</th></tr></thead>
          <tbody>
            {cfg.rows.map((r) => (
              <tr key={cfg.id(r)}>
                {cfg.columns.map((c) => <td key={c.label}>{c.cell(r)}</td>)}
                <td className="nowrap">
                  <button className="btn ghost sm" onClick={() => setEditing({ id: cfg.id(r), form: cfg.toForm(r) })}>{t("edit")}</button>
                  {cfg.canDelete !== false && cfg.remove && (
                    <button className="btn ghost sm danger-text" onClick={() => setDeleting(cfg.id(r))}>{t("delete")}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleting !== null && (
        <Modal title={t("delete_title")} onClose={() => setDeleting(null)} actions={<>
          <button className="btn ghost" onClick={() => setDeleting(null)}>{t("discard")}</button>
          <button className="btn danger" onClick={async () => { const r = await cfg.remove!(deleting); setDeleting(null); onResult(r); }}>{t("delete")}</button>
        </>}>
          <p>{t("delete_body")}</p>
        </Modal>
      )}
    </div>
  );
}
