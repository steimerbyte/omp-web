/**
 * Die Grenzen einer geplanten Aufgabe — ohne `fs`, ohne `fetch`.
 *
 * ### Warum das eine eigene Datei ist
 *
 * Diese drei Zahlen stehen an zwei Orten: der Speicher weist eine zu lange
 * Eingabe ab, und der Dialog setzt `maxLength` und sperrt den Speichern-Knopf.
 * Sie in `lib/scheduled-tasks-store.ts` zu lassen hiesse, dass die
 * Aufgabenansicht den Speicher importiert — und der zieht `tenant-config`, den
 * `rpc-manager` und damit das omp-SDK nach. Im Client-Bundle ist das kein
 * Schoenheitsfehler: der Build scheitert an einem SDK-Modul, das
 * TypeScript-Syntax enthaelt und kein JavaScript ist.
 *
 * Dieselbe Aufteilung wie bei `lib/quick-phrases.ts`: die Domaene (Form,
 * Grenzen, Pruefung) hat kein `fs`, damit Browser und Route dieselbe Antwort
 * geben. Der Speicher importiert die Werte von hier und gibt sie weiter, damit
 * seine oeffentliche Form unveraendert bleibt.
 */

/** Laengengrenze des Namens; er steht in der Liste, nicht im Prompt. */
export const MAX_TASK_NAME_LENGTH = 120;

/** Laengengrenze des Prompts. Grosszuegig, aber nicht unbegrenzt. */
export const MAX_TASK_PROMPT_LENGTH = 20_000;

/** Laengengrenze fuer `provider` und `modelId`; beide sind Kennungen, kein Fliesstext. */
export const MAX_MODEL_REF_LENGTH = 200;
