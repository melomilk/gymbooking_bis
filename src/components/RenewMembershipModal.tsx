"use client";
// Membership renewal dialog with imitation online card payment.
// No payment table or external gateway: simulates acquiring (1.8 s), then calls
// api.renewMembership() which updates only membership_status and membership_expiry.
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/components/Providers";
import Modal from "@/components/Modal";
import { fmtDate, fmtKzt, nextMembershipExpiry } from "@/lib/format";
import { MEMBERSHIP_PLANS, type Me, type MembershipPlanMonths } from "@/lib/types";
import type { Key } from "@/lib/i18n";

const PROCESSING_MS = 1800;

function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 16);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function formatCardExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

type Phase = "form" | "processing" | "done";

export default function RenewMembershipModal({
  me,
  onClose,
  onRenewed,
}: {
  me: Me;
  onClose: () => void;
  onRenewed: () => Promise<void>;
}) {
  const { t, tr, lang } = useT();
  const [months, setMonths] = useState<MembershipPlanMonths>(1);
  // Pre-filled demo card details for one-click confirmation
  const [cardNumber, setCardNumber] = useState("4242 4242 4242 4242");
  const [cardExpiry, setCardExpiry] = useState("12/28");
  const [cardCvc, setCardCvc] = useState("123");
  const [cardHolder, setCardHolder] = useState(`${me.member_name} ${me.member_surname}`.toUpperCase());
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [newExpiry, setNewExpiry] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const plan = MEMBERSHIP_PLANS.find((p) => p.months === months) ?? MEMBERSHIP_PLANS[0];
  const previewExpiry = nextMembershipExpiry(me.membership_expiry, plan.months);
  const isActive = me.effective_status === "Active";

  function validateCard(): string | null {
    if (cardNumber.replace(/\D/g, "").length !== 16) return t("renew_invalid_card");
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(cardExpiry.trim())) return t("renew_invalid_expiry");
    if (!/^\d{3,4}$/.test(cardCvc.trim())) return t("renew_invalid_cvc");
    if (!cardHolder.trim()) return t("renew_invalid_holder");
    return null;
  }

  function handlePay(e: React.FormEvent) {
    e.preventDefault();
    const err = validateCard();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setPhase("processing");
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      const r = await api.renewMembership(plan.months);
      if (!r.ok) {
        setError(tr(r));
        setPhase("form");
        return;
      }
      setNewExpiry(r.membership_expiry ?? previewExpiry);
      await onRenewed();
      setPhase("done");
    }, PROCESSING_MS);
  }

  return (
    <Modal
      title={t("renew_modal_title")}
      onClose={phase === "processing" ? () => {} : onClose}
      actions={
        phase === "done" ? (
          <button className="btn" onClick={onClose}>{t("renew_done_btn")}</button>
        ) : undefined
      }
    >
      {phase === "form" && (
        <form className="form renew-form" noValidate onSubmit={handlePay}>
          <div className="role-pick">
            <span className="small muted">{t("renew_choose_plan")}</span>
            <div className="plan-options" role="radiogroup" aria-label={t("renew_choose_plan")}>
              {MEMBERSHIP_PLANS.map((p) => (
                <label key={p.months} className={`role-option plan-option ${months === p.months ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="renew_plan"
                    value={p.months}
                    checked={months === p.months}
                    onChange={() => setMonths(p.months)}
                  />
                  <span className="plan-head">
                    <b>{t(`renew_plan_${p.months}` as Key)}</b>
                    {p.savePct && <span className="pill st-active">{t("renew_save", { n: p.savePct })}</span>}
                  </span>
                  <span className="plan-price">{fmtKzt(p.priceKzt)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="renew-preview small">
            {isActive
              ? t("renew_preview_active", {
                  current: fmtDate(me.membership_expiry, lang),
                  next: fmtDate(previewExpiry, lang),
                })
              : t("renew_preview_expired", { next: fmtDate(previewExpiry, lang) })}
          </div>

          <fieldset className="trainer-fields">
            <legend>{t("renew_card_section")}</legend>
            <label>
              {t("renew_card_number")}
              <input
                value={cardNumber}
                onChange={(e) => { setCardNumber(formatCardNumber(e.target.value)); setError(null); }}
                inputMode="numeric"
                autoComplete="cc-number"
                maxLength={19}
              />
            </label>
            <div className="row">
              <label>
                {t("renew_card_expiry")}
                <input
                  value={cardExpiry}
                  onChange={(e) => { setCardExpiry(formatCardExpiry(e.target.value)); setError(null); }}
                  inputMode="numeric"
                  autoComplete="cc-exp"
                  maxLength={5}
                />
              </label>
              <label>
                {t("renew_card_cvc")}
                <input
                  value={cardCvc}
                  onChange={(e) => { setCardCvc(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(null); }}
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  maxLength={4}
                />
              </label>
            </div>
            <label>
              {t("renew_card_holder")}
              <input
                value={cardHolder}
                onChange={(e) => { setCardHolder(e.target.value); setError(null); }}
                autoComplete="cc-name"
                maxLength={80}
              />
            </label>
            <p className="small muted">{t("renew_demo_hint")}</p>
          </fieldset>

          <div className="renew-summary">
            <span className="muted">{t("renew_total")}</span>
            <b>{fmtKzt(plan.priceKzt)}</b>
          </div>

          {error && <div className="notice bad small" role="alert">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>{t("discard")}</button>
            <button type="submit" className="btn">{t("renew_pay_btn", { amount: fmtKzt(plan.priceKzt) })}</button>
          </div>
        </form>
      )}

      {phase === "processing" && (
        <div className="verify-status renew-status" role="status">
          <span className="spinner" aria-hidden />
          <p><b>{t("renew_processing_title")}</b></p>
          <p className="small muted">{t("renew_processing_sub", { amount: fmtKzt(plan.priceKzt) })}</p>
        </div>
      )}

      {phase === "done" && (
        <div className="verify-status renew-status" role="status">
          <span className="check-mark" aria-hidden>✓</span>
          <p><b>{t("renew_success_title")}</b></p>
          <p className="small muted">
            {t("renew_success_body", {
              plan: t(`renew_plan_${plan.months}` as Key),
              amount: fmtKzt(plan.priceKzt),
            })}
          </p>
          <p className="good-text">
            <b>{t("renew_valid_until", { date: fmtDate(newExpiry ?? previewExpiry, lang) })}</b>
          </p>
        </div>
      )}
    </Modal>
  );
}
