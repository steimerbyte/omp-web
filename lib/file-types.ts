export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  webm: "audio/webm",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Archive, die der Browser nicht anzeigen kann.
 *
 * Anders als ein Bild, ein PDF oder ein Text hat keine dieser Endungen eine
 * Vorschau. Ein Klick auf die Zeile laeuft bei ihnen in einen Viewer, der
 * entweder gar nichts anzeigt oder den Browser dazu bringt, die Datei zu
 * entpacken — beides ist fuer ein Archiv der falsche Weg. Der Explorer
 * braucht fuer sie deshalb einen Download-Knopf, der ohne Hover dasteht: auf
 * einem Telefon loest es keinen Hover aus, dort ist ein Knopf, der erst beim
 * Darueberfahren erscheint, unauffindbar.
 */
export const ARCHIVE_EXTENSIONS: Record<string, true> = {
  zip: true,
  tar: true,
  gz: true,
  tgz: true,
  bz2: true,
  xz: true,
  "7z": true,
  rar: true,
};

export function isArchivePath(filePath: string): boolean {
  return ARCHIVE_EXTENSIONS[getFileExt(filePath)] === true;
}

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
  return DOCUMENT_EXT_TO_MIME[getFileExt(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}
