export type Theme = 'dark' | 'light';
const KEY = 'tc-codex-4d:theme';

export function storedTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* falls back to dark next time */ }
}
