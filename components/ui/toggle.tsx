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
        transition: "background-color var(--duration-enter) var(--ease-standard)",
        outline: "none",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {/* Der Knopf fährt `transform`, nie `left`. Eine linke Kante ist eine
          Layout-Eigenschaft: jeder Frame hätte das Element neu gesetzt. Die
          18 px sind die Strecke, die `left: 3 -> 21` vorher zurückgelegt hat
          (40 - 2 * 3 - 16), damit der Knopf an derselben Stelle sitzt. */}
      <span
        style={{
          position: "absolute",
          top: 3,
          left: 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          transform: checked ? "translateX(18px)" : "none",
          transition:
            "transform var(--duration-enter) var(--ease-standard), background-color var(--duration-enter) var(--ease-standard)",
        }}
      />
    </button>
  )
}

export { Toggle }
