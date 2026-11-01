const KEY = "pending-room";

export function takePending(): string | null {
  const value = localStorage.getItem(KEY);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return value;
}
