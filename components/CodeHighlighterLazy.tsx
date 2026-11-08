"use client";

import { Suspense, createElement, lazy, useEffect, useState } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";

/**
 * Die Hervorhebung haengt hinter einem eigenen Chunk (siehe CodeHighlighter.tsx).
 *
 * `next/dynamic` waere hier falsch: sein `loading`-Element wird ohne die Props
 * des Ziel-Components gerendert (next/dist/shared/lib/lazy-dynamic/loadable.js
 * rendert `<Loading isLoading pastDelay error />`), und mit `ssr: false` besitzt
 * es seine eigene Suspense-Grenze — ein Fallback von aussen kaeme nie zum Zug.
 * Dann stuende dort nichts, der Block faellt auf Hoehe 0 und springt beim
 * Nachladen. Also eigener Suspense-Boundary plus `mounted`-Gate: Server und
 * erster Client-Render zeigen denselben Klartext-Block, erst nach dem Mount
 * darf der Chunk laden.
 */
const LazyHighlighter = lazy(() => import("./CodeHighlighter").then((mod) => ({ default: mod.CodeHighlighter })));

/** Derselbe Block ohne Hervorhebung: gleicher Text, gleiches Element, gleiche Box. */
function PlainCode({ className, customStyle, codeTagProps, PreTag, CodeTag, children, wrapLongLines }: SyntaxHighlighterProps) {
  return createElement(
    PreTag ?? "pre",
    { className, style: customStyle },
    createElement(
      CodeTag ?? "code",
      { ...codeTagProps, style: { whiteSpace: wrapLongLines ? "pre-wrap" : "pre", ...codeTagProps?.style } },
      children,
    ),
  );
}

export function CodeHighlighter(props: SyntaxHighlighterProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <PlainCode {...props} />;
  return (
    <Suspense fallback={<PlainCode {...props} />}>
      <LazyHighlighter {...props} />
    </Suspense>
  );
}
