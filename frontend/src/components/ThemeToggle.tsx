import { useTheme } from "../theme";
import { MoonIcon, SunIcon } from "./Icon";

/**
 * Switches between light and dark. It shows the side it will switch *to*, so the icon and the
 * label always describe the same thing — the button that says "Dark" is the button that gives you
 * dark.
 */
export function ThemeToggle() {
  const { theme, following, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={following
        ? `Switch to ${next} mode — currently matching your system setting`
        : `Switch to ${next} mode`}
    >
      {next === "dark" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
