"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";

/**
 * Die eigentliche Hervorhebung. Dieses Modul statisch zu importieren zieht
 * `react-syntax-highlighter`s volles Prism (= refractor mit jeder Grammatik)
 * in den Chunk, und dessen Modul-Auswertung laeuft `Prism.languages.insertBefore`
 * / `DFS` ueber alle Grammatiken: gemessen 2026-11-07 im Boot-Profil 102 ms
 * (Median aus 3 Laeufen) in einem 186-213 ms langen Task, bevor die
 * Sitzungsdaten ueberhaupt ankommen. Deshalb nur ueber `CodeHighlighterLazy`.
 */
export function CodeHighlighter(props: SyntaxHighlighterProps) {
  return <SyntaxHighlighter {...props} />;
}
