/* RS ID - kit del servidor para los sitios (id.rsanjur.com).
 *
 * POR QUÉ EXISTE
 * El mismo flujo de login estaba copiado en cada sitio: armar la URL de entrada,
 * canjear el codigo de un solo uso, guardar la sesion del sitio y volver a la
 * pagina donde estaban. Cada copia fallaba distinto (una perdia el `?volver=`,
 * otra no cerraba sesion en el SSO), y arreglar el login en un sitio no arreglaba
 * los demas.
 *
 * CÓMO SE USA (en el worker de un sitio):
 *
 *   import { rsid } from "./rs-id-kit.js";
 *   const SSO = rsid(env, { clientId: "proptech-gis", origen: "https://proptech-gis.ricardosanjur.com" });
 *   const intento = await SSO.iniciar(); // guardar intento.cookie y redirigir a intento.url
 *   const datos = SSO.leerIntento(request, code); // state + verifier, rechazando duplicados
 *   const cuenta = await SSO.canjear(code, datos); // -> { email, cuentaId } | null
 *
 * El sitio sigue decidiendo QUE HACE con la cuenta (crear su cookie, su sesion);
 * aca solo vive el protocolo con el RS ID, que es lo que estaba duplicado.
 */

const ID_ORIGEN = "https://id.rsanjur.com";
const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const STATE_RE = /^[A-Za-z0-9_-]{43,128}$/u;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/u;
const CODE_RE = /^[A-Za-z0-9_-]{32,128}$/u;

function b64url(bytes) {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  return null;
}

function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diferencia = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diferencia |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diferencia === 0;
}

function origenHttpsValido(origen) {
  if (!origen) return true;
  try {
    const url = new URL(origen);
    return url.protocol === "https:" && url.origin === origen;
  } catch {
    return false;
  }
}

function randomToken() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") return null;
  try {
    const bytes = new Uint8Array(32);
    cryptoApi.getRandomValues(bytes);
    return b64url(bytes);
  } catch {
    return null;
  }
}

async function iniciarPkce(clientId, base) {
  if (!CLIENT_ID_RE.test(clientId)) return null;
  const state = randomToken();
  const verifier = randomToken();
  if (!state || !verifier || !globalThis.crypto || !globalThis.crypto.subtle) return null;
  let challenge;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    challenge = b64url(new Uint8Array(digest));
  } catch {
    return null;
  }
  if (!challenge || challenge.length !== 43) return null;
  let url;
  try { url = new URL("/api/auth/authorize", base); } catch { return null; }
  if (url.protocol !== "https:") return null;
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { clientId: clientId, state: state, verifier: verifier, challenge: challenge, url: url.toString() };
}

export function rsid(env, opts) {
  const base = String((env && env.ID_ORIGEN) || ID_ORIGEN).replace(/\/+$/, "");
  const secreto = String((env && env.RS_ID_MOD_SECRET) || "");
  const origen = String((opts && opts.origen) || "").replace(/\/+$/, "");
  const clientId = String((opts && opts.clientId) || "");
  const cookieEstado = CLIENT_ID_RE.test(clientId) ? "__Host-rsid-sso-" + clientId : "";

  const listo = () => clientId
    ? !!cookieEstado && origenHttpsValido(origen)
    : secreto.length > 0;

  /**
   * URL a la que se manda a la persona para que entre con RS ID y vuelva.
   * `volver` SIEMPRE tiene que ser una ruta del propio sitio (o una URL absoluta
   * del mismo origen): si se acepta cualquier cosa, es un redirect abierto.
   */
  function urlEntrar(volver) {
    if (clientId) return null; // los clientes registrados deben crear state + PKCE con iniciar()
    const destino = origen + (String(volver || "/").startsWith("/") ? String(volver || "/") : "/");
    return base + "/id?volver=" + encodeURIComponent(destino);
  }

  /** Crea state/verifier/challenge y una cookie host-only para el cliente registrado. */
  async function iniciar() {
    if (!cookieEstado || !listo()) return null;
    const intento = await iniciarPkce(clientId, base);
    if (!intento) return null;
    return {
      ...intento,
      cookie: cookieEstado + "=" + intento.state + "." + intento.verifier + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
      clearCookie: cookieEstado + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    };
  }

  /** Lee una sola cookie del intento y verifica que su state coincide con callback. */
  function leerIntento(request, state) {
    if (!cookieEstado || !request || !request.headers || typeof state !== "string" || !STATE_RE.test(state)) return null;
    const matches = String(request.headers.get("cookie") || "").split(";").map((x) => x.trim())
      .filter((x) => x.slice(0, cookieEstado.length + 1) === cookieEstado + "=");
    if (matches.length !== 1) return null;
    const valor = matches[0].slice(cookieEstado.length + 1);
    const punto = valor.indexOf(".");
    if (punto < 1 || valor.indexOf(".", punto + 1) !== -1) return null;
    const cookieState = valor.slice(0, punto);
    const verifier = valor.slice(punto + 1);
    if (!STATE_RE.test(cookieState) || !VERIFIER_RE.test(verifier) || !igualSeguro(cookieState, state)) return null;
    return { clientId: clientId, state: cookieState, verifier: verifier };
  }

  /** Canjea el codigo de un solo uso (?rsid=). Devuelve { email, cuentaId } o null. */
  async function canjear(codigo, intento) {
    if (clientId) {
      if (!cookieEstado || !intento || intento.clientId !== clientId || typeof codigo !== "string" || !CODE_RE.test(codigo)
          || typeof intento.state !== "string" || !STATE_RE.test(intento.state)
          || typeof intento.verifier !== "string" || !VERIFIER_RE.test(intento.verifier)) return null;
      try {
        const r = await fetch(base + "/api/auth/canjear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            codigo: String(codigo),
            code_verifier: intento.verifier,
            state: intento.state,
          }),
          redirect: "manual",
          cache: "no-store",
        });
        if (r.status >= 300 && r.status < 400) return null;
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.email || !j.cuenta_id) {
          console.warn("[rsid] canje PKCE fallo:", r.status);
          return null;
        }
        return {
          email: String(j.email).toLowerCase(),
          cuentaId: String(j.cuenta_id),
          compraFalta: Array.isArray(j.compra_falta) ? j.compra_falta : [],
        };
      } catch (e) {
        console.error("[rsid] error canjeando PKCE:", (e && e.message) || e);
        return null;
      }
    }
    if (!secreto || !codigo) return null;
    try {
      const r = await fetch(base + "/api/auth/canjear", {
        method: "POST",
        headers: { "content-type": "application/json", "x-rsid-app-secret": secreto },
        body: JSON.stringify({ codigo: String(codigo), origen }),
        redirect: "manual",
        cache: "no-store",
      });
      if (r.status >= 300 && r.status < 400) return null;
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.email) {
        console.warn("[rsid] canje fallo:", r.status, JSON.stringify(j || {}));
        return null;
      }
      return {
        email: String(j.email).toLowerCase(),
        cuentaId: String(j.cuenta_id || ""),
        compraFalta: Array.isArray(j.compra_falta) ? j.compra_falta : []
      };
    } catch (e) {
      console.error("[rsid] error canjeando:", (e && e.message) || e);
      return null;
    }
  }

  /** URL para cerrar la sesion EN EL SSO (no solo la cookie del sitio). */
  function urlSalir(volver) {
    const destino = origen + (String(volver || "/").startsWith("/") ? String(volver || "/") : "/");
    return base + "/salir?volver=" + encodeURIComponent(destino);
  }

  return { listo, urlEntrar, urlSalir, iniciar, leerIntento, canjear, base, clientId };
}
