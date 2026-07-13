import type { TextStyle } from "react-native";

export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "system";

export const THEME_STORAGE_KEY = "@opta/seeker/theme-mode";

const darkColors = {
  bg: "#0C0C0A",
  surface: "#14140F",
  surface2: "#1A1A15",
  text: "#F1ECE2",
  text2: "#8C897C",
  text3: "#5E5B50",
  hairline: "#26261F",
  up: "#1AC6A5",
  down: "#D7263D",
  upTextSmall: "#1AC6A5",
  onUp: "#04342C",
  onDown: "#FCEBEB",
  dot: "#D7263D",
  overlay: "rgba(6, 6, 4, 0.72)",
  transparent: "transparent"
} as const;

const lightColors = {
  bg: "#F1ECE2",
  surface: "#EAE4D6",
  surface2: "#E4DDCB",
  text: "#0A0A08",
  text2: "#4A463C",
  text3: "#8A8577",
  hairline: "#D8D2C4",
  up: "#1AC6A5",
  down: "#D7263D",
  upTextSmall: "#0E9B80",
  onUp: "#04342C",
  onDown: "#FCEBEB",
  dot: "#1AC6A5",
  overlay: "rgba(10, 10, 8, 0.34)",
  transparent: "transparent"
} as const;

const type = {
  family: {
    ui: "Inter",
    mono: "IBMPlexMono",
    logo: "Fraunces-Italic"
  },
  face: {
    uiRegular: "Inter_400Regular",
    uiMedium: "Inter_500Medium",
    monoRegular: "IBMPlexMono_400Regular",
    monoMedium: "IBMPlexMono_500Medium",
    logoItalic: "Fraunces_400Regular_Italic"
  },
  sizes: {
    eyebrow: 12,
    label: 12,
    body: 14,
    emphasis: 15,
    num: 14,
    spot: 20,
    centerpiece: 48
  },
  lineHeights: {
    label: 18,
    body: 20
  },
  weights: {
    regular: "400" as NonNullable<TextStyle["fontWeight"]>,
    medium: "500" as NonNullable<TextStyle["fontWeight"]>
  },
  tabularNums: true,
  numericVariant: ["tabular-nums"] as NonNullable<TextStyle["fontVariant"]>
} as const;

const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
const radius = { control: 6, panel: 10, sheetTop: 16 } as const;
const hit = { min: 44 } as const;
const motion = { fast: 100, base: 150, flash: 300, toast: 4000 } as const;

const layout = {
  headerHeight: 56,
  tickerHeight: 44,
  controlHeight: 44,
  offerRowHeight: 44,
  positionRowHeight: 64,
  primaryButtonHeight: 48,
  tabBarHeight: 56,
  gestureInset: 12,
  horizontalPadding: 16
} as const;

export function createTheme(mode: ThemeMode) {
  return {
    mode,
    colors: mode === "dark" ? darkColors : lightColors,
    type,
    space,
    radius,
    hit,
    motion,
    layout
  } as const;
}

export type AppTheme = ReturnType<typeof createTheme>;

export const darkTheme = createTheme("dark");
export const lightTheme = createTheme("light");

/** Backwards-friendly name for callers that prefer the handoff's `theme(mode)` API. */
export const theme = createTheme;
