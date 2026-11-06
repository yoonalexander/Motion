import "client-only";

/**
 * Browser-only OCR entrypoint. Never import this module from API routes or
 * server code; OCR text and page images must stay in the browser (SDD §6.2).
 */
export const OCR_ENGINE_BOUNDARY = "browser-only" as const;
