const modules = import.meta.glob('./*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface ExternalPalette {
  id: string;
  label: string;
  css: string;
  accentColor?: string;
}

const slugFromPath = (path: string) => {
  const match = path.match(/([^/]+)\.css$/);
  if (!match) return path;
  return match[1].toLowerCase();
};

const labelFromSlug = (slug: string) =>
  slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const extractAccent = (css: string) => {
  const match = css.match(/--primary:\s*([^;]+);/);
  if (!match) return undefined;
  const value = match[1].trim();
  // RainbowKit prefers hex, fallback to undefined if not hex
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    return value;
  }
  return undefined;
};

export const externalPalettes: ExternalPalette[] = Object.entries(modules)
  .sort(([a], [b]) => {
    // Prioritize Deep Space, then alphabetical
    const idA = slugFromPath(a);
    const idB = slugFromPath(b);
    if (idA === 'deepspace') return -1;
    if (idB === 'deepspace') return 1;
    return idA.localeCompare(idB);
  })
  .map(([path, css]) => {
    const id = slugFromPath(path);
    return {
      id,
      label: labelFromSlug(id),
      css,
      accentColor: extractAccent(css),
    };
  });

let injectedStyleEl: HTMLStyleElement | null = null;

export function applyExternalPalette(styleId: string | null) {
  if (typeof document === 'undefined') return;
  if (injectedStyleEl) {
    injectedStyleEl.remove();
    injectedStyleEl = null;
  }
  if (!styleId) return;
  const palette = externalPalettes.find((p) => p.id === styleId);
  if (!palette) return;
  injectedStyleEl = document.createElement('style');
  injectedStyleEl.dataset.dynamicPalette = styleId;
  injectedStyleEl.textContent = palette.css;
  document.head.appendChild(injectedStyleEl);
}

export function getExternalPaletteAccent(styleId: string): string | undefined {
  return externalPalettes.find((p) => p.id === styleId)?.accentColor;
}

export const externalPaletteOptions = externalPalettes.map(({ id, label, accentColor }) => ({ id, label, accentColor }));
