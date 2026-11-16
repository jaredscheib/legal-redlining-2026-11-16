const SYNONYMS_KEY = "redline.synonyms";

/** Whether synonym expansion is on. Defaults to on when storage is empty or unavailable. */
export function loadSynonyms(): boolean {
  try {
    return window.localStorage.getItem(SYNONYMS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveSynonyms(on: boolean): void {
  try {
    window.localStorage.setItem(SYNONYMS_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked (private mode, policy); the toggle still works for this session.
  }
}
