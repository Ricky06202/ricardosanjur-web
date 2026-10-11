import { ui, type Lang } from "./ui";

export type { Lang };
export const defaultLang: Lang = "es";
export const languages: Lang[] = ["es", "en"];

/** Canonical (Spanish, root) paths per logical route. */
export const routes = {
  home: "/",
  services: "/services/",
  about: "/about/",
  blog: "/blog/",
  contact: "/contact/",
} as const;

export type RouteKey = keyof typeof routes;
export const routeKeys: RouteKey[] = ["home", "services", "about", "blog", "contact"];

/** Locale detected from a URL pathname ("/en/..." => en, otherwise es). */
export function getLangFromUrl(url: URL): Lang {
  return isEnPath(url.pathname) ? "en" : "es";
}

function isEnPath(pathname: string): boolean {
  return pathname === "/en" || pathname.startsWith("/en/");
}

/** Remove the /en prefix so we always reason about the canonical Spanish path. */
export function stripLang(pathname: string): string {
  const stripped = pathname.replace(/^\/en(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * Build the URL path for a given canonical path and language.
 * es: /services -> /services   en: /services -> /en/services
 */
export function localePath(path: string, lang: Lang): string {
  // Las rutas construidas por Astro son "directory" (con barra final): /services/
  // Normalizamos siempre a barra final para que canonical y hreflang coincidan.
  let p = path === "" ? "/" : path;
  if (p !== "/" && !p.endsWith("/")) p += "/";
  if (lang === "es") return p;
  return p === "/" ? "/en/" : "/en" + p;
}

/** Href for a logical route in a given language. */
export function routeHref(key: RouteKey, lang: Lang): string {
  return localePath(routes[key], lang);
}

export function otherLang(lang: Lang): Lang {
  return lang === "es" ? "en" : "es";
}

/** Same page, other language (used by the ES/EN toggle). */
export function switchPath(pathname: string, target: Lang): string {
  return localePath(stripLang(pathname), target);
}

/** Absolute hreflang alternates for the current page. */
export function alternates(url: URL, site: URL | URL["href"] | undefined) {
  const base = site ? new URL(site) : new URL("https://www.ricardosanjur.com");
  const canonical = stripLang(url.pathname);
  return {
    es: new URL(localePath(canonical, "es"), base).href,
    en: new URL(localePath(canonical, "en"), base).href,
  };
}
