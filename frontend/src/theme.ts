// The theme must paint before the first frame and survive offline starts, so
// it lives in localStorage and is stamped onto the root element; the profile
// in config is the durable copy and wins whenever it arrives.

export type Theme = "dark" | "light";

const KEY = "jarvis-theme";

export function storedTheme(): Theme {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
}
