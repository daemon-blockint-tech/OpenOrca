/** Escape untuk literal string TypeQL. Dipakai SEMUA modul triage — jangan duplikasi. */
export function tqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Timestamp format datetime TypeDB (⊥ suffix Z, presisi milidetik). */
export function tqlNow(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "").concat(".000");
}
