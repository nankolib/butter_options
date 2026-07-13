import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useColorScheme } from "react-native";
import {
  THEME_STORAGE_KEY,
  createTheme,
  type AppTheme,
  type ThemeMode,
  type ThemePreference
} from "../theme";

export type ThemeContextValue = {
  theme: AppTheme;
  mode: ThemeMode;
  preference: ThemePreference;
  hydrated: boolean;
  setMode: (mode: ThemeMode) => Promise<void>;
  useSystemMode: () => Promise<void>;
  toggleMode: () => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function deviceMode(scheme: ReturnType<typeof useColorScheme>): ThemeMode {
  return scheme === "light" ? "light" : "dark";
}

function isStoredMode(value: string | null): value is ThemeMode {
  return value === "dark" || value === "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  // Master brief section 1: the app defaults DARK on first launch. A user's
  // explicit dark/light toggle is stored and rehydrated below; only that
  // overrides this default.
  const [preference, setPreference] = useState<ThemePreference>("dark");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((stored) => {
        if (active && isStoredMode(stored)) setPreference(stored);
      })
      .catch(() => {
        // Storage failure must not prevent the device theme from rendering.
      })
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const mode = preference === "system" ? deviceMode(scheme) : preference;

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    setPreference(nextMode);
    await AsyncStorage.setItem(THEME_STORAGE_KEY, nextMode);
  }, []);

  const useSystemMode = useCallback(async () => {
    setPreference("system");
    await AsyncStorage.removeItem(THEME_STORAGE_KEY);
  }, []);

  const toggleMode = useCallback(async () => {
    const nextMode: ThemeMode = mode === "dark" ? "light" : "dark";
    setPreference(nextMode);
    await AsyncStorage.setItem(THEME_STORAGE_KEY, nextMode);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme: createTheme(mode),
    mode,
    preference,
    hydrated,
    setMode,
    useSystemMode,
    toggleMode
  }), [hydrated, mode, preference, setMode, toggleMode, useSystemMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
