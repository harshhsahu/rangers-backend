/** JSON.parse that returns `fallback` instead of throwing. */
export function safeJsonParse(text: string | null | undefined, fallback: any = null): any {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
