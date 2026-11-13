"use client"

import * as React from "react"
import { cn } from "cn"

/** Der 40x22-Schalter der Einstellungs-Panels. Inline-Styles, weil die beiden
 *  Farben die Laufzeit-Palette sind (`--accent` / `--border`) und kein
 *  Theme-Klasse-Vertrag existiert. */
function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-slot="toggle"
      onClick={onChange}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={checked}
      className={cn(className)}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: disabled ? "wait" : "pointer",
        background: checked ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  )
}

export { Toggle }
