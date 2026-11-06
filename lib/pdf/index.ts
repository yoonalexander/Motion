import "client-only";

/**
 * Browser-only PDF entrypoint. Never import this module from API routes or
 * server code; PDF bytes and page images must stay in the browser (SDD §6.2).
 */
export const PDF_ENGINE_BOUNDARY = "browser-only" as const;
