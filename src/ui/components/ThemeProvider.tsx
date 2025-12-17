import { createContext, useContext, useEffect, useState } from "react"
import { applyExternalPalette } from "@/ui/themes/registry"

type Theme = "dark" | "light" | "system"
type Style = "cyberpunk" | "glacier" | "default" | string // Allow string for dynamic themes

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  defaultStyle?: Style
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  style: Style
  setTheme: (theme: Theme) => void
  setStyle: (style: Style) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  style: "classic",
  setTheme: () => null,
  setStyle: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  defaultStyle = "classic",
  storageKey = "moby-ui-theme",
  ...props
}: ThemeProviderProps) {
  // Clean up legacy storage keys so defaults apply on upgrade
  useEffect(() => {
    localStorage.removeItem("vite-ui-theme")
    localStorage.removeItem("vite-ui-theme-style")
  }, [])

  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  )
  const [style, setStyle] = useState<Style>(
    () => (localStorage.getItem(`${storageKey}-style`) as Style) || defaultStyle
  )

  useEffect(() => {
    const root = window.document.documentElement

    root.classList.remove("light", "dark")

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light"

      root.classList.add(systemTheme)
      return
    }

    root.classList.add(theme)
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement
    root.setAttribute("data-style", style)
    // Dynamically inject the CSS for the selected style
    applyExternalPalette(style)
  }, [style])

  const value = {
    theme,
    style,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
    setStyle: (style: Style) => {
      localStorage.setItem(`${storageKey}-style`, style)
      setStyle(style)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}
