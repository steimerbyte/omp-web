"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  overlayClassName,
  overlayStyle,
  bare = false,
  children,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /**
   * Laesst die Panel-Klassen des Primaerformulars weg. Fuer Fenster, die ihre
   * Groesse selbst mitbringen (Modul-CSS oder Inline): die Klassen wuerden
   * sonst Breite, Padding, Gap und Ring dazwischensetzen.
   */
  bare?: boolean
  /** Der Hintergrund gehoert dem Aufrufer — Modul-Klasse und Inline-Werte wie zuvor. */
  overlayClassName?: string
  overlayStyle?: React.CSSProperties
}) {
  /*
   * Der Fokus geht beim Schliessen an das Element zurueck, das den Dialog
   * geoeffnet hat.
   *
   * Radix' `DialogContent` verhindert mit `preventDefault()` den eigenen
   * Rueckweg seines `FocusScope` und setzt den Fokus stattdessen auf seinen
   * `DialogTrigger`. Diese Dialoge werden aber von aussen gemountet (`open`
   * bleibt `true`, der Elternteil haelt den Zustand) und haben deshalb keinen
   * Trigger — ohne diesen Griff landet der Fokus im `body`. Der Ausloeser wird
   * beim Mounten gemerkt, also dann, wenn der Klick ihn noch traegt.
   *
   * `isConnected` trennt "der Knopf steht noch" von "der Elternteil hat ihn
   * zusammen mit dem Dialog entfernt"; auf einen ausgebauten Knoten zu zeigen
   * hilft niemandem. Ein eigener `onCloseAutoFocus` des Aufrufers gewinnt.
   */
  const [opener] = React.useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)
  )
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} style={overlayStyle} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onCloseAutoFocus={
          onCloseAutoFocus ??
          ((event) => {
            event.preventDefault()
            if (opener?.isConnected) opener.focus()
          })
        }
        className={cn(
          !bare &&
            "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
