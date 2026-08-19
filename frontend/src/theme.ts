// The theme must paint before the first frame and survive offline starts, so
// it lives in localStorage and is stamped onto the root element; the profile
// in config is the durable copy and wins whenever it arrives. "system"
// follows macOS: it stamps whatever the OS says now and keeps following it.

export type Theme = "dark" | "light" | "system";

const KEY = "jarvis-theme";

let media: MediaQueryList | null = null;
let follow: ((e: MediaQueryListEvent) => void) | null = null;

export function storedTheme(): Theme {
  const raw = localStorage.getItem(KEY);
  return raw === "light" || raw === "system" ? raw : "dark";
}

function stamp(resolved: "dark" | "light") {
  document.documentElement.dataset.theme = resolved;
}

export function applyTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  if (media && follow) {
    media.removeEventListener("change", follow);
    media = null;
    follow = null;
  }
  if (theme === "system") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    stamp(media.matches ? "dark" : "light");
    follow = (e) => stamp(e.matches ? "dark" : "light");
    media.addEventListener("change", follow);
    return;
  }
  stamp(theme);
}
