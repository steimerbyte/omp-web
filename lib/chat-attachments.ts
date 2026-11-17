import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import type { AgentSessionLike } from "./omp-types";

/**
 * Ein eingefuegtes Bild wird eine echte Datei im `local://`-Wurzelverzeichnis
 * der Session — wie im TUI.
 *
 * ### Warum das der Server tun muss
 *
 * Das Browser-UI schickt das Bild als Base64 im JSON-Body. Ohne diese Datei
 * sieht das Modell nur Pixel: es kann sie ansehen, aber nicht erneut lesen,
 * nicht weiterverarbeiten und nach einer Kompaktierung gar nicht mehr
 * erreichen. Das TUI legt denselben Fall unter
 * `<Session-Artefakte>/local/pasted-image-<hash>.<ext>` ab und haengt an die
 * Nachricht einen versteckten Hinweis auf diesen Pfad
 * (`input-controller.ts:2349-2384`, `agent-session.ts:7979-8004`).
 *
 * ### Warum der Name ein Inhalts-Hash ist
 *
 * Zweimal derselbe Screenshot ergibt zweimal denselben Dateinamen; ein zweiter
 * Schreibvorgang ist dann ein No-Op statt einer zweiten Kopie. Weder der Name
 * noch die Endung kommen vom Client: der Stamm ist `Bun.hash` ueber die Bytes,
 * die Endung stammt aus der Whitelist des SDK
 * (`blobExtensionForImageMimeType`) und faellt auf `png` zurueck. Ein
 * `mimeType` wie `../../etc/passwd` kann deshalb keinen Pfad verschieben —
 * `resolveLocalUrlToPath` prueft die Wurzel zusaetzlich.
 *
 * ### Warum Fehler degradieren statt zu scheitern
 *
 * Ein fehlendes Artefaktverzeichnis oder ein voller Datentraeger darf einen
 * Prompt nicht verhindern. Das Bild geht dann ohne Pfad-Tag raus — genau wie
 * im CLI, das nur eine Warnung schreibt. Der Nutzer verliert die
 * Datei-Referenz, nicht seine Nachricht.
 */
export async function persistPromptImages(
  session: AgentSessionLike,
  images?: readonly ImageContent[],
): Promise<ImageContent[]> {
  if (!images?.length) return [];

  const artifactsDir = session.sessionManager.getArtifactsDir();
  if (!artifactsDir) {
    console.warn("[attachments] the session has no artifacts directory; pasted images stay untagged");
    return [...images];
  }

  const prepared: ImageContent[] = [];
  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    const extension = blobExtensionForImageMimeType(image.mimeType) ?? "png";
    const url = `local://pasted-image-${Bun.hash(bytes).toString(16)}.${extension}`;
    try {
      const filePath = resolveLocalUrlToPath(url, {
        getArtifactsDir: () => artifactsDir,
      });
      await mkdir(dirname(filePath), { recursive: true });
      try {
        // `wx` schreibt nur, wenn die Datei fehlt: ein vorhandener Hash ist
        // derselbe Inhalt, und `mode` gilt ohnehin nur beim Anlegen.
        await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      prepared.push(tagImageAttachmentSource(image, url, "image"));
    } catch (error) {
      console.warn(
        `[attachments] could not persist ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      prepared.push(image);
    }
  }
  return prepared;
}

