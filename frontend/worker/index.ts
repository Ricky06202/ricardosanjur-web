// Cloudflare Worker: country-based language redirect for the site root.
// Spanish-speaking visitors (or anyone with a manual "lang" cookie) get the
// default Spanish site; everyone else is sent to /en/ once, at "/" only.

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

// Countries and territories where Spanish is an official/majority language.
const HISPANIC_COUNTRIES = new Set([
  "ES", "MX", "GT", "SV", "HN", "NI", "CR", "PA", "CU", "DO", "PR",
  "CO", "VE", "EC", "PE", "BO", "CL", "AR", "UY", "PY", "GQ",
]);

function hasLangCookie(request: Request): boolean {
  const cookie = request.headers.get("Cookie") ?? "";
  return /(?:^|;\s*)lang=/.test(cookie);
}

export default {
  async fetch(
    request: Request & { cf?: { country?: string } },
    env: Env,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Never redirect crawlers: let them index both language versions (hreflang handles the rest).
    const ua = request.headers.get("User-Agent") ?? "";
    const isBot = /(googlebot|bingbot|bingpreview|duckduckbot|yandex|baiduspider|slurp|crawler|spider|bot)/i.test(ua);

    if (request.method === "GET" && url.pathname === "/" && !hasLangCookie(request) && !isBot) {
      const country = request.cf?.country;
      if (country && !HISPANIC_COUNTRIES.has(country)) {
        // 302 to the English home. No loop: /en/ is not "/".
        return Response.redirect(new URL("/en/", url).toString(), 302);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
