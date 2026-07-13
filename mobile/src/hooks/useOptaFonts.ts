import { useMemo } from "react";
import { useFonts, type FontSource } from "expo-font";

export type OptaFontSources = {
  interRegular: FontSource;
  interMedium: FontSource;
  ibmPlexMonoRegular: FontSource;
  ibmPlexMonoMedium: FontSource;
  frauncesItalic: FontSource;
};

/**
 * Loads the five locked Seeker font faces supplied by local assets or an
 * installed font package. Keep the app behind its font/skeleton gate until
 * `loaded` is true so platform-default text is never shown.
 */
export function useOptaFonts(sources: OptaFontSources) {
  const map = useMemo(() => ({
    Inter_400Regular: sources.interRegular,
    Inter_500Medium: sources.interMedium,
    IBMPlexMono_400Regular: sources.ibmPlexMonoRegular,
    IBMPlexMono_500Medium: sources.ibmPlexMonoMedium,
    Fraunces_400Regular_Italic: sources.frauncesItalic
  }), [sources]);
  const [loaded, error] = useFonts(map);
  return { loaded, error } as const;
}
