import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

export const prerender = true;

export const GET: APIRoute = async () => {
  const site = import.meta.env.SITE ?? "https://www.ricardosanjur.com";
  const staticPages = ["/", "/services", "/about", "/blog", "/contact"];
  const posts = await getCollection("blog");
  const urls = [...staticPages, ...posts.map((p) => `/blog/${p.id}/`)]
    .map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
