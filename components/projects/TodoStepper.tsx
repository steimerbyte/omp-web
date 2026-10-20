"use client";

import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";

/**
 * The open-todo counter: a number with − and + beside it.
 *
 * A counter, not a checklist, on purpose. The value is a note to self, it is
 * settable to zero without deleting anything, and it fits on one card line
 * where a list would not. The stepper is therefore the whole feature — no
 * second artefact, no text to store.
 *
 * Server-deaf: it holds no state of its own. The parent owns the value and
 * re-renders with the new one, so the number on screen is never a guess.
 */
export function TodoStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const { t } = useI18n();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>{value}</span>
      <StepButton
        label="−"
        ariaLabel={`${t("projects.metric.todos")} −`}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      />
      <StepButton label="+" ariaLabel={`${t("projects.metric.todos")} +`} onClick={() => onChange(value + 1)} />
    </div>
  );
}

/**
 * One stepper button.
 *
 * Kept as its own component because the hover-only reveal is shared by both
 * buttons: the card is dense, and two permanent 20px buttons on every metric
 * line would compete with the numbers they belong to.
 */
function StepButton({
  label,
  ariaLabel,
  onClick,
  disabled = false,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        width: 18,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        fontSize: 12,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </Pressable>
  );
}