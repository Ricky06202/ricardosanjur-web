import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { FICHAS } from "../content/blog-fichas";

export const prerender = true;

interface Entry {
  loc: string;
  lastmod: string;
  es: string | null;
  en: string | null;
}

export const GET: APIRoute = async () => {
  const site = import.meta.env.SITE ?? "https://www.ricardosanjur.com";
  const origin = site.replace(/\/$/, "");
  const now = new Date().toISOString();

  const entries: Entry[] = [];
  const add = (loc: string, lastmod: string, es: string | null, en: string | null) =>
    entries.push({ loc, lastmod, es, en });

  // Rutas estaticas bilingues (barra final = formato directory de Astro).
  const routes = [
    { es: "/", en: "/en/" },
    { es: "/services/", en: "/en/services/" },
    { es: "/about/", en: "/en/about/" },
    { es: "/blog/", en: "/en/blog/" },
    { es: "/contact/", en: "/en/contact/" },
  ];
  for (const r of routes) {
    add(origin + r.es, now, origin + r.es, origin + r.en);
    add(origin + r.en, now, origin + r.es, origin + r.en);
  }

  // Posts del blog (ES en /blog/, EN en /en/blog/).
  const postsEs = await getCollection("blog");
  const postsEn = await getCollection("blogEn");
  const esBySlug = new Map(postsEs.map((p) => [p.id, p]));
  const enBySlug = new Map(postsEn.map((p) => [p.id, p]));
  const slugs = new Set([...esBySlug.keys(), ...enBySlug.keys()]);
  for (const slug of slugs) {
    const esPost = esBySlug.get(slug);
    const enPost = enBySlug.get(slug);
    const date = esPost?.data.date ?? enPost?.data.date;
    const lastmod = date ? new Date(date).toISOString() : now;
    const esLoc = esPost ? origin + `/blog/${slug}/` : null;
    const enLoc = enPost ? origin + `/en/blog/${slug}/` : null;
    if (esLoc) add(esLoc, lastmod, esLoc, enLoc);
    if (enLoc) add(enLoc, lastmod, esLoc, enLoc);
  }

  // Artículos HTML (solo español: hechos a mano, sin versión en inglés).
  const htmlEs = import.meta.glob("/src/content/blog/*.html", { eager: true });
  for (const slug of Object.keys(htmlEs).map((r) => r.split("/").pop()!.replace(/\.html$/, ""))) {
    const ficha = FICHAS[slug];
    const loc = origin + `/blog/${slug}/`;
    add(loc, ficha ? new Date(ficha.fecha + "T12:00:00Z").toISOString() : now, loc, null);
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    entries
      .map((e) => {
        const alts: string[] = [];
        if (e.es) alts.push(`    <xhtml:link rel="alternate" hreflang="es" href="${e.es}"/>`);
        if (e.en) alts.push(`    <xhtml:link rel="alternate" hreflang="en" href="${e.en}"/>`);
        alts.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${e.es ?? e.en}"/>`);
        return `  <url>\n    <loc>${e.loc}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n${alts.join("\n")}\n  </url>`;
      })
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
