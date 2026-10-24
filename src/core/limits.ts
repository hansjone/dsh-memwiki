/** Maximum UTF-8 body size for ordinary pages; meta/ pages are exempt. */
export const MAX_BODY_BYTES = 20 * 1024

/** Keeps the first 120 Unicode characters and marks truncated descriptions. */
export function shortDescription(value: string): string {
  const chars = [...value]
  return chars.length > 120 ? chars.slice(0, 120).join('') + '…' : value
}
