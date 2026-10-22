/**
 * Tiny persistence layer for player preferences (car, paint, settings).
 * localStorage can be missing or throw (private mode, blocked storage,
 * quota), so every access is wrapped and failures fall back to defaults.
 */
const KEY = 'metro-drive:prefs:v1';

export function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function savePrefs(patch) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Storage unavailable: preferences just won't persist.
  }
}
