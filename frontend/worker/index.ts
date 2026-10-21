// Cloudflare Worker: redirect por pais en "/" + area privada "Mis Planos".
// Bindings: ASSETS (sitio estatico), DB (D1: clients/plans/downloads), PLANOS (R2).
// Secretos: PANEL_CLAVE (contrasena del panel), PANEL_SECRET (firma de cookie).
// Solo usa las tablas clients, plans y downloads de la D1 compartida, mas la tabla
// aditiva certificados (huella SHA-256 de documentos, pagina publica y verificacion).

import RSQR from './qr.js';
import { handleBlogLista, handleBlogForm, handleBlogGuardar, handleBlogBorrar } from './admin-blog';
import { handleBlogIndex, handleBlogPost, BLOG_SCHEMA, handleBlogArchivo, handleBlogTarjeta, handleBlogPostHtml, NUBE_CSS } from './blog';
import { ARCHIVOS_BLOG } from './blog-archivos';
import { FICHAS } from '../src/content/blog-fichas';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  DB: any;
  // Corriendo en la maquina del desarrollador (wrangler dev), no en produccion.
  LOCAL_PRUEBA?: string;
  // Cloudflare Email Service (binding send_email). Opcional: si no esta, el
  // mensaje igual queda guardado en la base (con avisado = 0).
  EMAIL?: { send: (msg: Record<string, unknown>) => Promise<{ messageId?: string } | null> };
  PLANOS: any;
  PANEL_CLAVE?: string;
  PANEL_SECRET?: string;
  ADMIN_TOKEN?: string;
  // Acceso de administradores con la cuenta RS ID (id.rsanjur.com).
  // ADMIN_EMAILS: lista blanca separada por comas de correos autorizados.
  // RS_ID_SESSION_SECRET (opcional): mismo secreto del worker rs-id; si esta,
  //   la cookie se valida localmente sin llamar a la API. Si no, se consulta
  //   GET /api/auth/yo de id.rsanjur.com (no requiere compartir secretos).
  ADMIN_EMAILS?: string;
  RS_ID_SESSION_SECRET?: string;
  RS_ID_VERIFY_URL?: string;
  // SSO cross-domain (ver /admin/entrar): secreto compartido con el worker rs-id
  // para llamar a POST /api/auth/canjear, y secreto propio que firma la cookie de
  // sesion del panel (si falta, se usa PANEL_SECRET).
  RS_ID_CANJE_SECRET?: string;
  RS_ID_CANJE_URL?: string;
  ADMIN_SESSION_SECRET?: string;
}

// Contexto del worker (waitUntil para trabajo en segundo plano).
type Ctx = { waitUntil: (p: Promise<unknown>) => void };

// Paises/territorios donde el espanol es idioma oficial o mayoritario.
const HISPANIC_COUNTRIES = new Set([
  'ES', 'MX', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA', 'CU', 'DO', 'PR',
  'CO', 'VE', 'EC', 'PE', 'BO', 'CL', 'AR', 'UY', 'PY', 'GQ',
]);

const COOKIE_NAME = 'panel_planos';
const YEAR_SECONDS = 31536000;
const SITE_ORIGIN = 'https://www.ricardosanjur.com';
const enc = new TextEncoder();

/* ================= migracion WordPress viejo (301 / 410) ================= */
// Inventario del WordPress anterior (www.ricardosanjur.com). Claves SIN barra final.
// Solo se aplica el 301 cuando el destino difiere de la URL pedida (evita bucles).
const LEGACY_REDIRECTS: Record<string, string> = {
  '/about': '/about/',
  '/servicios': '/services/',
  '/contacto': '/contact/',
  '/nosotros': '/about/',
  '/empresa': '/about/',
  '/proyectos': '/services/',
  '/projectos': '/services/',
  '/portafolio': '/services/',
  '/projects': '/services/',
  '/inicio': '/',
  '/home': '/',
  '/feed': '/blog/',
  '/comments/feed': '/blog/',
  '/privacidad': '/',
  '/aviso-de-privacidad': '/',
  '/politica-de-privacidad': '/',
  '/terminos': '/',
  '/page/2': '/blog/',
};

// Rutas de sistema de WordPress que se retiran de la web publica -> 410 Gone.
const GONE_PREFIXES = [
  '/wp-admin', '/wp-login.php', '/wp-json', '/xmlrpc.php',
  '/wp-content', '/wp-includes', '/wp-cron.php', '/wp-activate.php',
  '/readme.html', '/license.txt', '/wp-signup.php',
];

// Archivos/estructuras tipicas de WP (fechas, categorias, tags, autores) -> blog.
function legacyArchiveTarget(path: string): string | null {
  if (/^\/\d{4}(\/\d{1,2})?(\/\d{1,2})?$/.test(path)) return '/blog/';
  if (/^\/(category|tag|author)(\/|$)/.test(path)) return '/blog/';
  return null;
}

function hasLangCookie(request: Request): boolean {
  const cookie = request.headers.get('Cookie') ?? '';
  return /(?:^|;\s*)lang=/.test(cookie);
}

/* ============================ utilidades ============================ */

function esc(value: unknown): string {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function redirect(location: string, status: number): Response {
  return new Response(null, { status: status, headers: { location: location } });
}

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// Compara dos secretos en tiempo constante (hash primero para no filtrar longitud).
// Huella SHA-256 de bytes (el archivo se lee en memoria; nunca se guarda).
async function sha256BytesHex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as any);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function secretEquals(a: string, b: string): Promise<boolean> {
  return constantTimeEqual(await sha256Hex(a), await sha256Hex(b));
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return b64url(sig);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq > -1 && p.slice(0, eq) === name) return p.slice(eq + 1);
  }
  return null;
}

// Cookie firmada: valor = "<expMs>.<hmac-sha256-base64url(expMs)>".
async function issueCookie(secret: string): Promise<string> {
  const exp = Date.now() + YEAR_SECONDS * 1000;
  const payload = String(exp);
  const sig = await hmacSign(secret, payload);
  return COOKIE_NAME + '=' + payload + '.' + sig +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + YEAR_SECONDS;
}

async function validSession(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false;
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[0-9]+$/.test(payload)) return false;
  if (!(Number(payload) > Date.now())) return false;
  const expected = await hmacSign(secret, payload);
  return constantTimeEqual(sig, expected);
}

async function requireSession(request: Request, env: Env): Promise<Response | null> {
  const secret = env.PANEL_SECRET || '';
  if (!secret || !(await validSession(request, secret))) return redirect('/panel-planos', 303);
  return null;
}

/* ================= acceso admin con la cuenta RS ID ================= */
// RS ID (id.rsanjur.com) firma la cookie "rs_id" (Domain=.rsanjur.com) como
//   v1.<payloadB64url>.<hmacB64url(secret, "v1." + payloadB64url)>
// donde el payload JSON trae { sid, sub, email, exp (segundos) }.
// Aqui solo se lee para saber QUE correo entro; no se toca la sesion de RS ID.

const RS_ID_COOKIE = 'rs_id';
const RS_ID_VERSION = 'v1';
const RS_ID_VERIFY_URL_DEFAULT = 'https://id.rsanjur.com/api/auth/yo';
const RS_ID_CANJE_URL_DEFAULT = 'https://id.rsanjur.com/api/auth/canjear';
// Cookie PROPIA de la topografia (Domain=.ricardosanjur.com). No es la del RS ID:
// por eso puede viajar dentro de este dominio, que NO es subdominio de rsanjur.com.
const ADMIN_COOKIE = 'admin_sesion';
const ADMIN_DAYS = 30;

function deB64urlStr(input: string): string {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const b64 = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Correos autorizados como admin (lista blanca en ADMIN_EMAILS, separada por comas).
function adminEmails(env: Env): string[] {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Valida la cookie rs_id localmente (misma firma que el worker rs-id).
async function rsIdEmailLocal(request: Request, secret: string): Promise<string | null> {
  const token = readCookie(request, RS_ID_COOKIE);
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== RS_ID_VERSION) return null;
  const esperada = await hmacSign(secret, RS_ID_VERSION + '.' + partes[1]);
  if (!constantTimeEqual(esperada, partes[2])) return null;
  let payload: any = null;
  try {
    payload = JSON.parse(deB64urlStr(partes[1]));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return str(payload.email);
}

// Valida la cookie rs_id contra la API de RS ID (no requiere compartir secretos).
async function rsIdEmailApi(request: Request, env: Env): Promise<string | null> {
  const token = readCookie(request, RS_ID_COOKIE);
  if (!token) return null;
  const target = env.RS_ID_VERIFY_URL || RS_ID_VERIFY_URL_DEFAULT;
  try {
    const res = await fetch(target, {
      headers: { cookie: RS_ID_COOKIE + '=' + token, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!data || data.autenticado !== true) return null;
    return str(data.email);
  } catch (e) {
    return null;
  }
}

/* -------- sesion PROPIA del panel (cookie admin_sesion) -------- */
// La cookie esta firmada con un secreto del worker y vive en el dominio de la
// topografia (Domain=.ricardosanjur.com), asi que SI viaja aqui. Es independiente
// de la cookie del RS ID (que es de .rsanjur.com y nunca llega a este dominio).
function adminSessionSecret(env: Env): string {
  return env.ADMIN_SESSION_SECRET || env.PANEL_SECRET || '';
}

function adminCookieDomain(request: Request): string {
  const host = new URL(request.url).hostname.toLowerCase();
  if (host === 'ricardosanjur.com' || host.endsWith('.ricardosanjur.com')) return '.ricardosanjur.com';
  return '';
}

async function issueAdminCookie(request: Request, env: Env, email: string): Promise<string> {
  const secret = adminSessionSecret(env);
  const exp = Date.now() + ADMIN_DAYS * 86400000;
  const emailEnc = b64url(enc.encode(email));
  const payload = exp + '.' + emailEnc;
  const sig = await hmacSign(secret, 'admin|' + payload);
  const partes = [ADMIN_COOKIE + '=' + payload + '.' + sig, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + (ADMIN_DAYS * 86400)];
  const dom = adminCookieDomain(request);
  if (dom) partes.push('Domain=' + dom);
  if (new URL(request.url).protocol === 'https:') partes.push('Secure');
  return partes.join('; ');
}

function clearAdminCookie(request: Request, env: Env): string {
  const partes = [ADMIN_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const dom = adminCookieDomain(request);
  if (dom) partes.push('Domain=' + dom);
  if (new URL(request.url).protocol === 'https:') partes.push('Secure');
  return partes.join('; ');
}

async function validAdminSession(request: Request, env: Env): Promise<string | null> {
  const secret = adminSessionSecret(env);
  if (!secret) return null;
  const raw = readCookie(request, ADMIN_COOKIE);
  if (!raw) return null;
  const partes = raw.split('.');
  if (partes.length !== 3) return null;
  const exp = partes[0];
  const emailEnc = partes[1];
  const sig = partes[2];
  if (!/^[0-9]+$/.test(exp)) return null;
  if (!(Number(exp) > Date.now())) return null;
  const expected = await hmacSign(secret, 'admin|' + exp + '.' + emailEnc);
  if (!constantTimeEqual(sig, expected)) return null;
  try { return deB64urlStr(emailEnc).trim().toLowerCase(); } catch (e) { return null; }
}

/* -------- canje del codigo de un solo uso contra el RS ID -------- */
async function canjearRsid(env: Env, codigo: string, origen: string): Promise<{ email?: string; cuenta_id?: string; error?: string }> {
  const secret = env.RS_ID_CANJE_SECRET || '';
  if (!secret) return { error: 'no_configurado' };
  const target = env.RS_ID_CANJE_URL || RS_ID_CANJE_URL_DEFAULT;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-rsid-app-secret': secret,
      },
      body: JSON.stringify({ codigo: codigo, origen: origen }),
    });
    let data: any = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok !== true) return { error: (data && data.error) || 'canje_fallido' };
    return { email: str(data.email) || undefined, cuenta_id: str(data.cuenta_id) || undefined };
  } catch (e) {
    return { error: 'canje_error' };
  }
}

// Devuelve el correo autorizado. Primero la sesion PROPIA del panel (cookie
// admin_sesion); si no, la cookie del RS ID (compatibilidad). Si no hay lista
// configurada, NADIE entra (nunca se filtra el panel por defecto).
async function adminAutorizado(request: Request, env: Env): Promise<string | null> {
  const lista = adminEmails(env);
  if (!lista.length) return null;
  let email: string | null = await validAdminSession(request, env);
  if (!email) {
    const secret = env.RS_ID_SESSION_SECRET || '';
    if (secret) email = await rsIdEmailLocal(request, secret);
    if (!email) email = await rsIdEmailApi(request, env);
  }
  if (!email) return null;
  const norm = email.trim().toLowerCase();
  return lista.indexOf(norm) > -1 ? norm : null;
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const txt = i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return txt + ' ' + units[i];
}

function extDe(name: unknown): string {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return '';
  const ext = s.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

function dateFmt(value: unknown): string {
  const s = String(value || '');
  if (!s) return '';
  const iso = s.indexOf(' ') > -1 && s.indexOf('T') === -1 ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  try {
    return d.toLocaleDateString('es-PA', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}

function sanitizeFileName(name: unknown): string {
  const base = String(name || 'archivo').split('/').pop() || 'archivo';
  return base.replace(/[^\w.\-() ]+/g, '_').slice(0, 160) || 'archivo';
}

function fileNameFromKey(key: unknown): string {
  const base = String(key || '').split('/').pop() || 'plano';
  return base.replace(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-/, '') || base;
}

/* ====================== contactos (/api/contact) ====================== */

let contactosListo = false;
async function ensureContactos(env: Env): Promise<void> {
  if (contactosListo) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS contactos (' +
    'id TEXT PRIMARY KEY, nombre TEXT NOT NULL, email TEXT, telefono TEXT, tema TEXT, ' +
    'mensaje TEXT NOT NULL, creado_en TEXT NOT NULL, ip TEXT, user_agent TEXT, avisado INTEGER DEFAULT 0)',
  ).run();
  // Archivos que el cliente adjunta a una solicitud de cotizacion. Se suben
  // ANTES del mensaje, con un ref comun; si la subida falla el mensaje igual sale.
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS contacto_archivos (' +
    'id TEXT PRIMARY KEY, ref TEXT NOT NULL, nombre TEXT NOT NULL, r2_key TEXT NOT NULL, ' +
    'mime TEXT, tamano INTEGER, creado_en TEXT NOT NULL)',
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_contacto_archivos_ref ON contacto_archivos (ref)').run();
  contactosListo = true;
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// A donde llegan los mensajes del sitio: el correo que la pagina ya publica.
const DESTINO_CONTACTO = 'asistente@ricardosanjur.com';
const LIMITES_CONTACTO = { nombre: 120, email: 254, telefono: 32, tema: 120, mensaje: 10_000 } as const;

function escCorreo(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Aviso por correo. BEST-EFFORT: si falla, el mensaje YA quedo en la base.
async function avisarContacto(env: Env, d: { nombre: string; email: string; telefono: string; tema: string; mensaje: string; id: string; ahora: string; archivos?: { id: string; nombre: string; tamano: number }[] }) {
  if (!env.EMAIL) return { enviado: false, error: 'sin_binding_email' };
  const nombreAsunto = String(d.nombre || '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
  const filas = [
    ['Nombre', d.nombre],
    ['Correo', d.email || '-'],
    ['Telefono', d.telefono || '-'],
    ['Tema', d.tema || '-'],
    ['Recibido', d.ahora],
  ].map(([k, v]) => '<tr><td style="padding:6px 14px 6px 0;color:#777;vertical-align:top">' + escCorreo(k) + '</td><td style="padding:6px 0;font-weight:600">' + escCorreo(v) + '</td></tr>').join('');
  const respuestaHtml = d.email
    ? '<p style="margin-top:18px;color:#777;font-size:13px">Para responder, escribile a <a href="mailto:' + escCorreo(d.email) + '">' + escCorreo(d.email) + '</a>.</p>'
    : d.telefono
      ? '<p style="margin-top:18px;color:#777;font-size:13px">Para responder por teléfono o WhatsApp, contacta al ' + escCorreo(d.telefono) + '.</p>'
      : '';
  const respuestaTexto = d.email
    ? '\n\n---\nResponde por correo a ' + d.email + '.'
    : d.telefono
      ? '\n\n---\nResponde por teléfono o WhatsApp al ' + d.telefono + '.'
      : '';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827">' +
      '<h2 style="margin:0 0 4px">Nuevo mensaje del sitio</h2>' +
      '<p style="margin:0 0 16px;color:#777">Topografia Especializada — ricardosanjur.com</p>' +
      '<table style="border-collapse:collapse">' + filas + '</table>' +
      '<div style="margin-top:18px;padding:16px;background:#F3F6FF;border-left:3px solid #2b5cff;white-space:pre-wrap">' + escCorreo(d.mensaje) + '</div>' +
      ((d.archivos && d.archivos.length)
        ? '<div style="margin-top:16px"><strong>Archivos adjuntos (' + d.archivos.length + ')</strong><ul style="margin:8px 0 0;padding-left:18px">' +
          d.archivos.map((a) => '<li>' + (a.link
            ? '<a href="' + escCorreo(a.link) + '">' + escCorreo(a.nombre) + '</a>'
            : escCorreo(a.nombre)) + ' <span style="color:#777">(' + Math.round((a.tamano || 0) / 1024) + ' KB)</span></li>').join('') +
          '</ul><p style="color:#777;font-size:13px;margin:6px 0 0">Los enlaces vencen en 30 dias.</p></div>'
        : '') +
      respuestaHtml +
    '</div>';
  const text = 'Nuevo mensaje del sitio\n\nNombre: ' + d.nombre + '\nCorreo: ' + (d.email || '-') +
    '\nTelefono: ' + (d.telefono || '-') + '\nTema: ' + (d.tema || '-') + '\n\n' + d.mensaje +
    respuestaTexto +
    ((d.archivos && d.archivos.length)
      ? '\n\nArchivos adjuntos (' + d.archivos.length + '):\n' + d.archivos.map((a) => '- ' + a.nombre + ' (' + Math.round((a.tamano || 0) / 1024) + ' KB)' + (a.link ? '\n  ' + a.link : '')).join('\n')
      : '');
  try {
    const res = await env.EMAIL.send({
      to: DESTINO_CONTACTO,
      from: 'Topografia Ricardosanjur <no-reply@ricardosanjur.com>',
      subject: 'Nuevo mensaje del sitio: ' + nombreAsunto,
      html: html,
      text: text,
    });
    return { enviado: true, messageId: (res && res.messageId) || null };
  } catch (e) {
    console.log('[contacto] EMAIL.send fallo: ' + String((e as any) && (e as any).message || e));
    return { enviado: false, error: 'envio_fallo' };
  }
}

/* POST /api/contact/files?ref=<uuid>  (multipart/form-data, campo "archivos")
   El formulario manda PRIMERO los adjuntos y DESPUES el texto a /api/contact con
   el mismo "ref". Van separados a proposito: si un archivo pesa demasiado o el
   movil corta la subida, el mensaje de texto igual se guarda y se avisa. */
const MAX_ARCHIVOS = 5;
const MAX_BYTES_ARCHIVO = 10 * 1024 * 1024;
const EXT_PERMITIDAS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.dwg', '.dxf'];

/* GET /mis-solicitudes/<archivoId>?t=<firma>
   Enlace de descarga que va en el correo de aviso: lleva la firma HMAC del id y
   caduca. Asi el correo trae enlaces en vez de adjuntos (Cloudflare Email corta
   los mensajes grandes y base64 engorda los archivos). */
async function firmaArchivo(env: Env, id: string, exp: number): Promise<string> {
  // Si por lo que sea no hay secreto configurado, se firma con uno derivado del
  // nombre del sitio: el enlace sigue funcionando (no es una frontera de seguridad
  // fuerte, solo evita que cualquiera adivine un id).
  const secreto = adminSessionSecret(env) || 'ricardosanjur-adjuntos';
  return hmacSign(secreto, 'archivo.' + id + '.' + exp);
}

/* En local (wrangler dev) la base arranca vacia: se crean las tablas del blog la
 * primera vez para poder probar el formulario sin tocar la base de produccion. */
async function prepararBaseLocal(env: Env) {
  if (env.LOCAL_PRUEBA !== '1') return;
  try {
    await env.DB.prepare('SELECT formato, cuerpo_texto FROM blog_posts LIMIT 1').all();
    return; // ya tiene todo
  } catch {
    /* falta algo: se intenta completar */
  }
  // D1 local no acepta varias sentencias en un exec: se borran los comentarios y se van una por una.
  const sentencias = BLOG_SCHEMA.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean);
  for (const sql of sentencias) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      console.log('[local] BLOG_SCHEMA: ' + String((e as any) && (e as any).message || e));
    }
  }
  try {
    await env.DB.exec('ALTER TABLE blog_posts ADD COLUMN formato TEXT NOT NULL DEFAULT \'texto\'');
  } catch {
    /* ya existe */
  }
  try {
    await env.DB.exec('ALTER TABLE blog_posts ADD COLUMN cuerpo_texto TEXT');
  } catch {
    /* ya existe */
  }
}

/* Los artículos que ya estaban publicados como archivo del repo se pasan UNA vez a
 * la base, para que el dueño los pueda editar desde el panel (antes solo se podían
 * ver). Corre en cada petición pero no cuesta nada cuando ya están: consulta por la
 * dirección y si existe no toca nada. La lista sale de worker/blog-archivos.ts. */
async function sembrarArticulos(env: Env) {
  let faltan: { archivo: string; texto: string }[] = [];
  try {
    const hay = await env.DB.prepare("SELECT slug FROM blog_posts").all();
    const slugs = new Set(((hay && hay.results) || []).map((r: any) => String(r.slug)));
    faltan = ARCHIVOS_BLOG.filter((a) => !slugs.has(a.archivo.replace(/\.(html?|md)$/, "")));
  } catch {
    return; // la tabla todavía no existe: el panel la crea
  }
  for (const item of faltan) {
    const slug = item.archivo.replace(/\.(html?|md)$/, "").split("/").pop() || "";
    const ficha = FICHAS[slug];
    const esHtml = /\.html$/i.test(item.archivo);
    const m = String(item.texto).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const mdTitulo = String(item.texto).match(/^title:\s*"?([^"\n]+)"?/m);
    const mdFecha = String(item.texto).match(/^date:\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2})/m);
    const mdResumen = String(item.texto).match(/^summary:\s*"?([^"\n]+)"?/m);
    const titular = ficha?.titulo || (mdTitulo ? mdTitulo[1] : m ? m[1].replace(/<[^>]+>/g, "").trim() : slug);
    let cuerpo = String(item.texto);
    if (!esHtml) {
      // El Markdown del repo trae su ficha al principio: el editor la pone aparte.
      cuerpo = cuerpo.replace(/^---[\s\S]*?---\s*/, "");
    }
    const fecha = (ficha?.fecha || (mdFecha ? mdFecha[1] : "2026-01-01")) + "T12:00:00.000Z";
    try {
      await env.DB.prepare(
        "INSERT INTO blog_posts (id, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, cuerpo_texto, formato, publicado, borrado, creado_en, actualizado_en) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?,?)"
      )
        .bind(
          "art" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          slug,
          "es",
          titular,
          ficha?.resumen || (mdResumen ? mdResumen[1] : ""),
          "Ricardo A. Sanjur A.",
          "",
          cuerpo,
          esHtml ? "" : cuerpo,
          esHtml ? "pagina" : "texto",
          fecha,
          fecha
        )
        .run();
    } catch (e) {
      console.log("[blog] no se pudo pasar el articulo " + slug + ": " + String((e as any) && (e as any).message || e));
    }
  }

  // Artículos que ya estaban en la base y se corrigieron como archivo del repo:
  // manda el archivo (es lo que está publicado en el código), sin pisar si alguien
  // los editó desde el panel DESPUÉS de ese archivo.
  for (const item of ARCHIVOS_BLOG) {
    const slug = item.archivo.replace(/\.(html?|md)$/, "").split("/").pop() || "";
    const ficha = FICHAS[slug];
    if (!ficha) continue;
    const esHtml = /\.html$/i.test(item.archivo);
    if (!esHtml) continue;
    try {
      const fila = await env.DB.prepare("SELECT cuerpo, actualizado_en FROM blog_posts WHERE slug = ? AND borrado = 0").bind(slug).first<{ cuerpo: string; actualizado_en: string }>();
      if (!fila) continue;
      const punto = Date.parse(ficha.fecha + "T23:59:59Z");
      if (!punto || Date.parse(String(fila.actualizado_en || "")) > punto) continue; // se editó después
      let cuerpo = String(item.texto);
      const mSt = cuerpo.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (mSt) cuerpo = cuerpo.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      if (cuerpo.trim() !== String(fila.cuerpo || "").trim()) {
        await env.DB.prepare("UPDATE blog_posts SET cuerpo = ? WHERE slug = ?").bind(cuerpo, slug).run();
      }
    } catch {
      /* si algo falla, se sigue mostrando lo que había */
    }
  }
}

/* GET /sitemap.xml -> todo lo que está publicado, incluidos los artículos del blog
 * de la base (el mapa que arma el sitio solo conoce los archivos del repo). */
async function handleSitemap(env: Env, url: URL): Promise<Response> {
  const origen = SITE_ORIGIN;
  const ruta = (r: string) => origen + r;
  const hoy = new Date().toISOString();
  const filas: { loc: string; lastmod: string }[] = [];
  const agregar = (loc: string, lastmod: string) => filas.push({ loc, lastmod });
  for (const [es, en] of [
    ['/', '/en/'], ['/services/', '/en/services/'], ['/about/', '/en/about/'],
    ['/blog/', '/en/blog/'], ['/contact/', '/en/contact/'],
  ]) {
    agregar(ruta(es), hoy);
    agregar(ruta(en), hoy);
  }
  try {
    const r = await env.DB.prepare(
      "SELECT slug, idioma, actualizado_en FROM blog_posts WHERE publicado = 1 AND borrado = 0 ORDER BY actualizado_en DESC"
    ).all<{ slug: string; idioma: string; actualizado_en: string }>();
    for (const p of (r && r.results) || []) {
      const base = p.idioma === 'en' ? '/en/blog/' : '/blog/';
      agregar(ruta(base + p.slug + '/'), String(p.actualizado_en || '').slice(0, 10) || hoy.slice(0, 10));
    }
  } catch {
    /* sin tabla: solo las páginas fijas */
  }
  const cuerpo = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    filas.map((f) => '  <url>\n    <loc>' + f.loc + '</loc>\n    <lastmod>' + f.lastmod + '</lastmod>\n  </url>').join('\n') +
    '\n</urlset>\n';
  return new Response(cuerpo, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

async function handleDescargaArchivo(request: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(request.url);
  const exp = Number(url.searchParams.get('e') || 0) || 0;
  const firma = String(url.searchParams.get('t') || '');
  if (!exp || Date.now() > exp * 1000) return notFoundPage('Ese enlace ya vencio.');
  const esperada = await firmaArchivo(env, id, exp);
  if (!firma || !constantTimeEqual(firma, esperada)) return notFoundPage('Enlace no valido.');

  const fila = await env.DB.prepare('SELECT nombre, r2_key, mime FROM contacto_archivos WHERE id = ?').bind(id).first();
  if (!fila) return notFoundPage('El archivo no existe.');
  let obj: any = null;
  try {
    obj = await env.PLANOS.get(String(fila.r2_key));
  } catch (e) {
    obj = null;
  }
  if (!obj || !obj.body) return notFoundPage('El archivo no esta disponible.');
  const nombre = String(fila.nombre || 'archivo');
  return new Response(obj.body, {
    headers: {
      'content-type': String(fila.mime || 'application/octet-stream'),
      'content-disposition': 'attachment; filename="' + nombre.replace(/"/g, '') + '"',
      'cache-control': 'private, no-store',
    },
  });
}

async function handleContactFiles(request: Request, env: Env): Promise<Response> {
  if (!env.PLANOS) return jsonResponse({ ok: false, error: 'sin_almacenamiento' }, 500);
  const url = new URL(request.url);
  const ref = String(str(url.searchParams.get('ref')) || '').toLowerCase();
  if (!/^[a-z0-9-]{8,64}$/.test(ref)) return jsonResponse({ ok: false, error: 'ref' }, 400);

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'form' }, 400);
  }
  const files = (form.getAll('archivos') as any[])
    .filter((f) => f && typeof f !== 'string' && typeof f.arrayBuffer === 'function')
    .slice(0, MAX_ARCHIVOS);
  if (files.length === 0) return jsonResponse({ ok: false, error: 'sin_archivos' }, 400);

  try {
    await ensureContactos(env);
  } catch (e) {
    return jsonResponse({ ok: false, error: 'base' }, 500);
  }

  const guardados: { nombre: string; tamano: number }[] = [];
  const rechazados: string[] = [];
  for (const file of files) {
    const nombre = sanitizeFileName(file.name);
    const ext = (nombre.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    if (EXT_PERMITIDAS.indexOf(ext) === -1) { rechazados.push(nombre); continue; }
    if (Number(file.size) > MAX_BYTES_ARCHIVO) { rechazados.push(nombre); continue; }
    try {
      const bytes = await file.arrayBuffer();
      const key = 'cotizaciones/' + ref + '/' + crypto.randomUUID() + '-' + nombre;
      const mime = file.type || 'application/octet-stream';
      await env.PLANOS.put(key, bytes, { httpMetadata: { contentType: mime } });
      await env.DB.prepare(
        'INSERT INTO contacto_archivos (id, ref, nombre, r2_key, mime, tamano, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), ref, nombre, key, mime, Number(file.size) || 0, new Date().toISOString()).run();
      guardados.push({ nombre, tamano: Number(file.size) || 0 });
    } catch (e) {
      rechazados.push(nombre);
    }
  }
  return jsonResponse({ ok: guardados.length > 0, guardados, rechazados }, guardados.length > 0 ? 201 : 400);
}

async function handleContact(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  let data: any = null;
  try {
    data = await request.json();
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== 'object') return jsonResponse({ ok: false, error: 'json' }, 400);

  const nombre = str(data.nombre) || '';
  const email = str(data.email) || '';
  const telefono = str(data.telefono) || '';
  const tema = str(data.tema) || '';
  const mensaje = str(data.mensaje) || '';
  if (!nombre || !mensaje) return jsonResponse({ ok: false, error: 'campos' }, 400);
  if (
    nombre.length > LIMITES_CONTACTO.nombre || email.length > LIMITES_CONTACTO.email ||
    telefono.length > LIMITES_CONTACTO.telefono || tema.length > LIMITES_CONTACTO.tema ||
    mensaje.length > LIMITES_CONTACTO.mensaje
  ) return jsonResponse({ ok: false, error: 'limites' }, 413);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse({ ok: false, error: 'email' }, 400);
  if (tema === 'cotizacion_copias_planos' && !email && !telefono) {
    return jsonResponse({ ok: false, error: 'contacto' }, 400);
  }

  const id = crypto.randomUUID();
  const ahora = new Date().toISOString();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 300);

  try {
    await ensureContactos(env);
    await env.DB.prepare(
      'INSERT INTO contactos (id, nombre, email, telefono, tema, mensaje, creado_en, ip, user_agent, avisado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
    ).bind(id, nombre, email, telefono, tema, mensaje, ahora, ip, ua).run();
  } catch (e) {
    console.log('[contacto] error guardando: ' + String((e as any) && (e as any).message || e));
    return jsonResponse({ ok: false, error: 'guardar' }, 500);
  }

  // Aviso por correo al correo del sitio. Best-effort: si falla, el mensaje ya
  // quedo en la base y se puede revisar/renotificar despues (avisado = 0).
  // Adjuntos que el cliente subio antes de enviar (mismo "ref"). Si no hay, lista vacia.
  let archivos: { nombre: string; tamano: number }[] = [];
  const ref = String(str((data as any).ref) || '').toLowerCase();
  if (/^[a-z0-9-]{8,64}$/.test(ref)) {
    try {
      const res = await env.DB.prepare('SELECT id, nombre, tamano FROM contacto_archivos WHERE ref = ? ORDER BY creado_en').bind(ref).all();
      archivos = (res.results || []).map((r: any) => ({ id: String(r.id || ''), nombre: String(r.nombre || ''), tamano: Number(r.tamano) || 0 }));
      // Se amarran al mensaje para poder rastrearlos despues.
      await env.DB.prepare('UPDATE contacto_archivos SET ref = ? WHERE ref = ?').bind('contacto:' + id, ref).run();
      await env.DB.prepare('ALTER TABLE contactos ADD COLUMN archivos INTEGER DEFAULT 0').run().catch(() => {});
      await env.DB.prepare('UPDATE contactos SET archivos = ? WHERE id = ?').bind(archivos.length, id).run().catch(() => {});
    } catch (e) {
      console.log('[contacto] no se pudieron leer los adjuntos: ' + String(e));
    }
  }

  // Links de descarga firmados (30 dias) para que el correo sea util sin adjuntos.
  if (archivos.length > 0) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    for (const a of archivos as any[]) {
      try {
        const firma = await firmaArchivo(env, a.id, exp);
        a.link = SITE_ORIGIN + '/mis-solicitudes/' + a.id + '?e=' + exp + '&t=' + encodeURIComponent(firma);
      } catch (e) { console.log('[contacto] no se pudo firmar el link del adjunto: ' + String(e)); }
    }
  }

  const aviso = await avisarContacto(env, { nombre, email, telefono, tema, mensaje, id, ahora, archivos });
  if (aviso.enviado) {
    try {
      await env.DB.prepare('UPDATE contactos SET avisado = 1 WHERE id = ?').bind(id).run();
    } catch (e) {
      console.log('[contacto] no se pudo marcar avisado: ' + String(e));
    }
  }

  return jsonResponse({ ok: true }, 201);
}

/* ============================ UI ============================ */

/* Panel del dueno: misma cara que RS ID (mismo azul, mismas tarjetas blancas,
 * misma tipografia) para que todo lo de la familia se sienta un solo producto. */
const CSS = [
  ':root{--brand:#2563EB;--cyan:#06B6D4;--violet:#8B5CF6;--ink:#0F172A;--mut:#667085;--line:#E4E7EC;',
  '--bg:#F6F8FB;--soft:#F1F5F9;--ok:#059669;--err:#DC2626;--warn:#B45309;',
  '--grad-btn:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);',
  '--shadow:0 10px 30px rgba(15,23,42,.07);--r:14px;--r-lg:22px}',
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.55;',
  'font-family:Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}',
  'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;',
  'background:radial-gradient(760px 340px at 12% -8%,rgba(37,99,235,.12),transparent 62%),',
  'radial-gradient(680px 320px at 92% 2%,rgba(6,182,212,.14),transparent 60%)}',
  'a{color:var(--brand);text-decoration:none}',
  'a:hover{text-decoration:underline}',
  'h1,h2{font-family:"Space Grotesk",Inter,"Segoe UI",Arial,sans-serif;letter-spacing:-.4px}',
  'h1{font-size:clamp(24px,5vw,30px);line-height:1.2;margin:0 0 6px}',
  'h1 span{background:linear-gradient(135deg,#2563EB,#06B6D4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}',
  'h2{font-size:18px;margin:0;line-height:1.3}',
  'p{margin:0 0 10px;color:#344054}',
  '.lead{color:var(--mut);margin:0}',
  '.muted{color:var(--mut)}',
  '.small{font-size:.86rem}',
  '.hint{font-size:.82rem;color:var(--mut);margin:6px 0 0}',
  '.ok{color:var(--ok)}',
  '.err{color:var(--err)}',
  /* barra superior */
  '.top{position:sticky;top:0;z-index:20;background:rgba(246,248,251,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}',
  '.top .in{max-width:960px;margin:0 auto;padding:14px 18px;display:flex;align-items:center;gap:10px}',
  '.logo{display:inline-flex;align-items:center;gap:11px;font-family:"Space Grotesk",Inter,sans-serif;font-weight:700;font-size:1.02rem;color:var(--ink);letter-spacing:-.3px}',
  '.logo:hover{text-decoration:none}',
  '.logo .mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;flex:0 0 auto;',
  'background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff;font-size:.8rem;font-weight:700;letter-spacing:.02em;box-shadow:0 6px 16px rgba(37,99,235,.28)}',
  '.logo small{color:var(--mut);font-weight:500;font-size:.86rem}',
  'main{max-width:960px;margin:0 auto;padding:26px 18px 80px}',
  /* bloques */
  '.card{background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);padding:22px;margin-top:16px;box-shadow:var(--shadow)}',
  '.card.okline{border-color:#B7E4CF}',
  '.card.errline{border-color:#F3C2C2}',
  '.sec{display:flex;gap:10px 14px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:6px}',
  '.sec .h{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.row{display:flex;gap:8px 10px;flex-wrap:wrap;align-items:center;justify-content:space-between}',
  '.pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#1D4ED8;background:#EAF1FE;border:1px solid #D6E4FD;border-radius:999px;padding:6px 11px;white-space:nowrap}',
  '.acc{margin-top:16px;background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}',
  '.acc>summary{cursor:pointer;padding:18px 22px;display:flex;align-items:center;gap:12px;justify-content:space-between;list-style:none}',
  '.acc>summary::-webkit-details-marker{display:none}',
  '.acc>summary .t{display:flex;flex-direction:column;gap:2px;font-family:"Space Grotesk",Inter,sans-serif;font-weight:600;font-size:1rem;letter-spacing:-.2px}',
  '.acc>summary .t small{color:var(--mut);font-weight:400;font-size:.83rem;font-family:Inter,sans-serif;letter-spacing:0}',
  '.acc>summary .chev{color:var(--mut);transition:transform .18s;flex:0 0 auto}',
  '.acc[open]>summary .chev{transform:rotate(180deg)}',
  '.acc[open]>summary{border-bottom:1px solid var(--line)}',
  '.acc>div{padding:18px 22px 22px}',
  /* botones */
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--grad-btn);color:#fff;border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;min-height:46px;box-shadow:0 6px 16px rgba(37,99,235,.22)}',
  '.btn:hover{text-decoration:none;filter:brightness(1.05)}',
  '.btn.ghost{background:#fff;border:1px solid var(--line);color:var(--ink);box-shadow:none}',
  '.btn.ghost:hover{border-color:#CBD5E1;background:var(--soft)}',
  '.btn.sm{padding:9px 14px;min-height:40px;font-size:.85rem;border-radius:11px}',
  '.btn.danger{color:var(--err);border-color:#F3C2C2}',
  '.btn.danger:hover{background:#FEF2F2;border-color:#F0B4B4}',
  '.btn:disabled{opacity:.65;cursor:progress}',
  'input,select,textarea{width:100%;padding:12px 13px;border-radius:12px;border:1px solid #D0D5DD;background:#fff;color:var(--ink);font:inherit;font-size:16px}',
  'input:focus,select:focus,textarea:focus{outline:3px solid rgba(37,99,235,.18);border-color:var(--brand)}',
  'input[type=file]{padding:11px;font-size:.92rem;color:var(--mut)}',
  'input[type=file]::file-selector-button{background:var(--soft);color:#1D4ED8;border:1px solid #D6E4FD;border-radius:10px;padding:9px 13px;margin-right:11px;font:inherit;font-weight:700;cursor:pointer}',
  'label{display:block;font-size:.86rem;font-weight:600;margin:16px 0 6px;color:#344054}',
  'label .muted{font-weight:400}',
  '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}',
  /* lista de planes del cliente */
  '.lista-planes{margin-top:12px}',
  '.plan{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--line);border-radius:16px;background:#FCFDFF;margin-top:10px}',
  '.plan:first-child{margin-top:6px}',
  '.plan-icono{flex:0 0 auto;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:.66rem;font-weight:700;letter-spacing:.04em;color:#1D4ED8;background:#EAF1FE;border:1px solid #D6E4FD}',
  '.plan-cuerpo{flex:1 1 auto;min-width:0}',
  '.plan-titulo{font-weight:600;line-height:1.35;overflow-wrap:anywhere}',
  '.plan-meta{font-size:.78rem;color:var(--mut);margin-top:3px}',
  '.plan-accion{flex:0 0 auto}',
  '.accion-zip{display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between}',
  '.accion-zip .btn{flex:0 0 auto}',
  /* datos */
  '.code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;font-size:.8rem;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:inline-block;max-width:100%;min-width:0;overflow-wrap:anywhere;word-break:break-word;color:#1D4ED8}',
  'a.code:hover{text-decoration:none;border-color:#BFD3FD;background:#EAF1FE}',
  '.stats-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}',
  '.stat{display:flex;flex-direction:column;gap:1px}',
  '.stat b{font-family:"Space Grotesk",Inter,sans-serif;font-size:1.4rem;line-height:1.2;font-weight:700}',
  '.stat span{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}',
  '.tipo-det{color:var(--mut);font-weight:500;text-transform:none;letter-spacing:0}',
  '.pill.tipos{color:#475467;background:var(--soft);border-color:var(--line)}',
  '.empty{text-align:center;padding:24px 10px;color:var(--mut);font-size:.92rem}',
  /* tabla escritorio */
  'table{width:100%;border-collapse:collapse;font-size:.92rem}',
  'th,td{text-align:left;padding:13px 9px;border-bottom:1px solid var(--line);vertical-align:top}',
  'tbody tr:last-child td{border-bottom:0}',
  'th{color:var(--mut);font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.07em}',
  'td strong{font-weight:600}',
  '.only-mobile{display:none}',
  /* movil: la tabla de clientes pasa a tarjetas */
  '@media(max-width:760px){',
  '.tabla-clientes thead,.tabla-certificados thead,.tabla-articulos thead{display:none}',
  '.tabla-clientes,.tabla-clientes tbody,.tabla-clientes tr,.tabla-clientes td{display:block;width:100%}',
  '.tabla-certificados,.tabla-certificados tbody,.tabla-certificados tr,.tabla-certificados td{display:block;width:100%}',
  '.tabla-certificados tr{border:1px solid var(--line);border-radius:16px;padding:15px;margin-top:12px;background:#FCFDFF}',
  '.tabla-certificados tr:first-child{margin-top:6px}',
  '.tabla-certificados td{border:0;padding:0;margin:0}',
  '.tabla-articulos,.tabla-articulos tbody,.tabla-articulos tr,.tabla-articulos td{display:block;width:100%}',
  '.tabla-articulos tr{border:1px solid var(--line);border-radius:16px;padding:15px;margin-top:12px;background:#FCFDFF}',
  '.tabla-articulos tr:first-child{margin-top:6px}',
  '.tabla-articulos td{border:0;padding:0;margin:0}',
  '.tabla-articulos td[data-l]:not(.acciones)::before{content:attr(data-l);display:block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin:10px 0 3px}',
  '.tabla-articulos td.acciones{display:flex;gap:8px;margin-top:12px}',
  '.tabla-articulos td.acciones .btn{flex:1}',
  '.tabla-certificados .code{display:block;font-size:.76rem;margin-top:4px}',
  '.tabla-certificados .labelc{margin:12px 0 3px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;font-size:.68rem}',
  '.acciones-movil{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
  '.acciones-movil .btn{flex:1 1 140px;min-height:40px;padding:9px 12px;font-size:.85rem}',
  '.plan{flex-wrap:wrap}',
  '.plan-accion{flex:1 1 100%;margin-top:2px}',
  '.plan-accion .btn{width:100%}',
  '.accion-zip .btn{width:100%}',
  '.tabla-clientes tr{border:1px solid var(--line);border-radius:16px;padding:15px;margin-top:12px;background:#FCFDFF}',
  '.tabla-clientes tr:first-child{margin-top:6px}',
  '.tabla-clientes td{border:0;padding:0;margin:0}',
  '.tabla-clientes td[data-l]:not(.noet)::before{content:attr(data-l);display:block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin:12px 0 3px}',
  '.tabla-clientes td:first-child::before,.tabla-clientes td:last-child::before{display:none}',
  '.tabla-clientes td:first-child{font-size:1.04rem}',
  '.tabla-clientes .stats-inline{display:flex;gap:28px;margin-top:10px}',
  '.tabla-clientes .stats-inline>div{font-weight:700}',
  '.tabla-clientes .stats-inline>div::before{content:attr(data-l);display:block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin-bottom:2px}',
  '.tabla-clientes td.noet::before{display:none}',
  '.tabla-clientes td:last-child{margin-top:14px}',
  '.tabla-clientes td:last-child .btn{width:100%}',
  '.tabla-clientes .code{display:block;font-size:.76rem}',
  '.only-desktop{display:none!important}',
  '.only-mobile{display:block}',
  '}',
  '@media(max-width:640px){.grid2{grid-template-columns:1fr}.stats-row{grid-template-columns:1fr 1fr;gap:12px 10px}',
  '.acc>summary .t small{display:none}',
  '.acc>summary .t{font-size:.98rem}',
  'main{padding:20px 14px 72px}.card{padding:18px 16px;border-radius:18px}.acc>summary{padding:16px 16px}.acc>div{padding:16px}h1{font-size:25px}}',
].join('\n');

export function page(title: string, body: string, status: number, cssExtra?: string): Response {
  const html = '<!doctype html>\n<html lang="es" data-theme="topoblue"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + esc(title) + ' | Topografia Especializada</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">' +
    '<style>' + CSS + (cssExtra ? '\n' + cssExtra : '') + '</style></head><body>' +
    '<header class="top"><div class="in">' + adminBarra() + '</div></header>' +
    '<main>' + body + '</main>\n' +
    '<script>(function(){var bs=document.querySelectorAll("[data-copy]");for(var i=0;i<bs.length;i++){(function(b){b.addEventListener("click",function(){var t=b.getAttribute("data-copy")||"";if(!(navigator.clipboard&&navigator.clipboard.writeText)){window.prompt("Copie el enlace",t);return;}navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent="Copiado";b.classList.add("ok");setTimeout(function(){b.textContent=o;},1600);});});})(bs[i]);}})();' +
    '(function(){var fs=document.querySelectorAll("form[data-busy]");for(var i=0;i<fs.length;i++){fs[i].addEventListener("submit",function(){var b=this.querySelector("button[type=submit]");if(b){b.disabled=true;b.textContent=this.getAttribute("data-busy")||"Guardando...";}});}})();</script>' +
    '</body></html>';
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* Desglose de tipos de archivo, ej. "3 (2 PDF, 1 DWG)".
 * Se cuenta por la extension del titulo; si no tiene, cuenta como PDF. */
function extDeMime(mime: string): string {
  const m = mime.toLowerCase();
  if (!m) return '';
  if (m.indexOf('pdf') > -1) return 'pdf';
  if (m.indexOf('zip') > -1) return 'zip';
  if (m.indexOf('jpeg') > -1) return 'jpg';
  if (m.indexOf('png') > -1) return 'png';
  if (m.indexOf('dwg') > -1) return 'dwg';
  const t = m.split('/')[1] || '';
  return /^[a-z0-9]{1,5}$/.test(t) ? t : '';
}

function tiposDeLista(titulos: unknown[]): string {
  const cuenta: Record<string, number> = {};
  for (let i = 0; i < titulos.length; i++) {
    const tipo = (extDe(titulos[i]) || 'pdf').toUpperCase();
    cuenta[tipo] = (cuenta[tipo] || 0) + 1;
  }
  const tipos = Object.keys(cuenta).sort(function (a, b) { return cuenta[b] - cuenta[a] || a.localeCompare(b); });
  return tipos.map(function (t) { return cuenta[t] + ' ' + t; }).join(', ');
}

function desgloseTipos(titulos: unknown[]): string {
  const det = tiposDeLista(titulos);
  return det ? titulos.length + ' <span class="tipo-det">(' + det + ')</span>' : '0';
}

// Barra superior del panel: marca + navegacion (visible siempre).
function adminBarra(): string {
  return '<a class="logo" href="/admin"><span class="mark">TE</span>Topografia Especializada <small>S.A.</small></a>';
}

function notFoundPage(message: string): Response {
  const aviso = '<div class="card" style="max-width:520px"><h1><span>Enlace no disponible</span></h1>' +
    '<p class="hint">' + esc(message || 'Este enlace no es valido o fue desactivado.') + '</p>' +
    '<p style="margin-top:16px"><a class="btn ghost" href="' + SITE_ORIGIN + '/">Ir al sitio</a></p></div>';
  return page('Enlace no disponible', aviso, 404);
}

/* ====================== pagina del cliente ====================== */

async function handleClient(token: string, env: Env): Promise<Response> {
  const client = await env.DB
    .prepare('SELECT id, nombre, activo FROM clients WHERE token = ?')
    .bind(token)
    .first();
  if (!client || Number(client.activo) !== 1) {
    return notFoundPage('Este enlace no es valido o fue desactivado.');
  }

  const res = await env.DB
    .prepare('SELECT id, titulo, descripcion, tamano, mime, creado_en, descargas FROM plans WHERE client_id = ? AND activo = 1 ORDER BY creado_en DESC')
    .bind(client.id)
    .all();
  const plans = (res && res.results) || [];

  let listHtml = '';
  if (plans.length === 0) {
    listHtml = '<div class="card"><div class="empty">Todavia no tiene planos disponibles. Si esperaba alguno, escriba al ingeniero Sanjur.</div></div>';
  } else {
    const tipos = tiposDeLista(plans.map(function (p: any) { return p.titulo; }));
    listHtml = '<div class="card"><div class="sec"><div class="h"><h2>Sus planos</h2>' +
      '<span class="pill">' + plans.length + (plans.length === 1 ? ' archivo' : ' archivos') + '</span>' +
      (tipos ? '<span class="pill tipos">' + tipos + '</span>' : '') + '</div></div>' +
      '<div class="lista-planes">';
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const href = '/mis-planos/' + encodeURIComponent(token) + '/plano/' + encodeURIComponent(String(p.id));
      const size = p.tamano ? formatBytes(Number(p.tamano)) : '';
      const when = dateFmt(p.creado_en);
      const meta = [when, size].filter(Boolean).join(' &middot; ');
      const ext = (extDe(p.titulo) || extDeMime(String(p.mime || '')) || 'PDF').toUpperCase();
      listHtml += '<div class="plan">' +
        '<div class="plan-icono">' + esc(ext) + '</div>' +
        '<div class="plan-cuerpo">' +
        '<div class="plan-titulo">' + esc(p.titulo || 'Plano') + '</div>' +
        (p.descripcion ? '<div class="muted small">' + esc(p.descripcion) + '</div>' : '') +
        (meta ? '<div class="plan-meta">' + meta + '</div>' : '') +
        '</div>' +
        '<div class="plan-accion"><a class="btn sm" href="' + esc(href) + '">Descargar</a></div>' +
        '</div>';
    }
    listHtml += '</div></div>';
  }

  const body = '<h1>Hola, <span>' + esc(client.nombre || 'cliente') + '</span></h1>' +
    '<p class="lead">Estos son los planos que el ingeniero preparo para usted. Cada archivo se descarga directo a su telefono o computadora.</p>' +
    (plans.length > 1 ? '<div class="card accion-zip"><div><div class="stat"><b>' + plans.length + '</b><span>Archivos disponibles</span></div>' +
      '<p class="hint" style="margin-top:4px">' + desgloseTipos(plans.map(function (p: any) { return p.titulo; })) +
      (plans.length > 1 ? ' &middot; bajelos todos juntos en un solo ZIP.' : '') + '</p></div>' +
      '<a class="btn" href="/mis-planos/' + encodeURIComponent(token) + '/zip">Descargar todo (ZIP)</a></div>' : '') +
    listHtml;
  return page('Mis planos', body, 200);
}

// GET /mis-planos/:token/plano/:id -> descarga desde R2 + log en downloads.
async function handleDownload(token: string, id: string, env: Env): Promise<Response> {
  const plan = await env.DB
    .prepare('SELECT p.id, p.client_id, p.r2_key, p.titulo, p.mime FROM plans p JOIN clients c ON c.id = p.client_id WHERE p.id = ? AND c.token = ? AND c.activo = 1')
    .bind(id, token)
    .first();
  if (!plan) return notFoundPage('El plano no existe o no pertenece a este enlace.');

  let obj: any = null;
  try {
    obj = await env.PLANOS.get(plan.r2_key);
  } catch (e) {
    obj = null;
  }
  if (!obj || !obj.body) return notFoundPage('El archivo no esta disponible.');

  const now = new Date().toISOString();
  try {
    await env.DB
      .prepare('UPDATE plans SET descargas = COALESCE(descargas, 0) + 1, ultima_descarga = ? WHERE id = ?')
      .bind(now, plan.id)
      .run();
    await env.DB
      .prepare('INSERT INTO downloads (id, plan_id, client_id, fecha) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), plan.id, plan.client_id, now)
      .run();
  } catch (e) {
    // El log no debe romper la descarga.
  }

  const filename = fileNameFromKey(plan.r2_key);
  const contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || plan.mime || 'application/octet-stream';
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('content-disposition',
    'attachment; filename="' + filename.replace(/"/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
  headers.set('cache-control', 'private, no-store');
  return new Response(obj.body, { status: 200, headers: headers });
}

/* ============================ zip (store) ============================ */

const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP sin compresion (store). Suficiente para juntar varios planos en un solo archivo.
function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    let len = 0;
    for (const q of parts) len += q.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const q of parts) { out.set(q, o); o += q.length; }
    return out;
  };
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = cat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes,
    );
    chunks.push(local, f.data);
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ));
    offset += local.length + size;
  }
  const cd = cat(...central);
  const eocd = cat(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  );
  return cat(...chunks, cd, eocd);
}

async function handleZip(token: string, env: Env): Promise<Response> {
  const client = await env.DB
    .prepare('SELECT id, nombre, activo FROM clients WHERE token = ?')
    .bind(token)
    .first();
  if (!client || Number(client.activo) !== 1) {
    return notFoundPage('Este enlace no es valido o fue desactivado.');
  }
  const res = await env.DB
    .prepare('SELECT id, r2_key FROM plans WHERE client_id = ? AND activo = 1 ORDER BY creado_en DESC')
    .bind(client.id)
    .all();
  const plans = (res && res.results) || [];
  const files: { name: string; data: Uint8Array }[] = [];
  const usados: Record<string, number> = {};
  for (const pl of plans) {
    const obj: any = await env.PLANOS.get(pl.r2_key).catch(() => null);
    if (!obj || !obj.body) continue;
    const buf = new Uint8Array(await new Response(obj.body).arrayBuffer());
    let name = fileNameFromKey(pl.r2_key) || ('plano-' + pl.id);
    if (usados[name] != null) {
      usados[name] += 1;
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? name.slice(0, dot) + ' (' + usados[name] + ')' + name.slice(dot) : name + ' (' + usados[name] + ')';
    } else {
      usados[name] = 0;
    }
    files.push({ name, data: buf });
  }
  if (!files.length) return notFoundPage('No hay archivos para descargar.');
  const zip = makeZip(files);
  const headers = new Headers();
  headers.set('content-type', 'application/zip');
  headers.set('content-disposition', 'attachment; filename="planos-' + sanitizeFileName(client.nombre || 'cliente') + '.zip"');
  headers.set('cache-control', 'private, no-store');
  return new Response(zip, { status: 200, headers });
}

/* ============================ panel ============================ */

function loginPage(error: string): Response {
  const body = '<div style="max-width:420px;margin:0 auto">' +
    '<h1><span>Panel de planos</span></h1><p class="lead">Acceso privado.</p>' +
    '<div class="card' + (error ? ' errline' : '') + '">' +
    (error ? '<p class="err small" style="margin:0 0 12px;font-weight:600">' + esc(error) + '</p>' : '') +
    '<form method="POST" action="/panel-planos/login">' +
    '<label for="clave">Contrasena</label>' +
    '<input type="password" id="clave" name="clave" required autocomplete="current-password">' +
    '<p style="margin-top:18px"><button class="btn" style="width:100%" type="submit">Entrar</button></p>' +
    '</form></div></div>';
  return page('Panel', body, error ? 401 : 200);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.PANEL_CLAVE || !env.PANEL_SECRET) {
    return page('Panel', '<div class="card errline"><h1><span>Panel no configurado</span></h1>' +
      '<p class="hint">Faltan los secretos PANEL_CLAVE / PANEL_SECRET.</p></div>', 500);
  }
  const form = await request.formData();
  const clave = String(form.get('clave') || '');
  if (await secretEquals(clave, env.PANEL_CLAVE)) {
    const headers = new Headers();
    headers.set('set-cookie', await issueCookie(env.PANEL_SECRET));
    headers.set('location', '/panel-planos/inicio');
    return new Response(null, { status: 303, headers: headers });
  }
  return loginPage('Contrasena incorrecta.');
}

// URL del RS ID a la que se manda al dueno, con la vuelta al panel de la topografia.
// ricardosanjur.com NO es subdominio de rsanjur.com, asi que el regreso se hace con
// un codigo de un solo uso, no con una cookie.
function entrarHref(): string {
  return 'https://id.rsanjur.com/id?volver=' + encodeURIComponent(SITE_ORIGIN + '/admin/entrar');
}

// Mensajes claros para el regreso del login (?error=...).
function adminAvisoDeError(code: string): string {
  const mapa: Record<string, string> = {
    sin_codigo: 'No llego el codigo de acceso. Vuelva a intentarlo desde el boton.',
    codigo_invalido: 'Ese codigo de acceso no es valido. Vuelva a intentarlo.',
    codigo_requerido: 'Falto el codigo de acceso. Vuelva a intentarlo.',
    codigo_usado: 'Ese codigo ya se uso (sirve una sola vez). Vuelva a intentarlo.',
    codigo_expirado: 'El codigo vencio (dura 60 segundos). Vuelva a intentarlo.',
    origen_invalido: 'No se pudo validar el origen del acceso.',
    origen_no_coincide: 'El codigo pertenece a otro sitio. Vuelva a intentarlo.',
    acceso_denegado: 'El acceso no esta autorizado (secreto de aplicacion incorrecto).',
    no_configurado: 'El panel no esta configurado para este tipo de acceso.',
    servicio_no_configurado: 'El servicio de acceso no esta configurado todavia.',
    demasiados_intentos: 'Demasiados intentos. Espere unos minutos.',
    canje_error: 'No se pudo verificar el acceso. Intente otra vez.',
    canje_fallido: 'No se pudo verificar el acceso. Intente otra vez.',
  };
  return mapa[code] || 'No se pudo completar el acceso. Intente otra vez.';
}

// Pantalla de acceso al panel con la cuenta RS ID (los clientes NO pasan por aqui).
function adminLoginPage(aviso: string, status: number): Response {
  const msg = aviso === 'sin_lista'
    ? 'El panel no tiene correos autorizados todavia. Falta cargar la lista blanca (ADMIN_EMAILS).'
    : aviso;
  const body = '<div style="max-width:460px;margin:0 auto">' +
    '<div class="sec" style="display:block;margin-bottom:2px"><h1><span>Panel de planos</span></h1></div>' +
    '<p class="lead">Acceso privado para el ingeniero y administradores.</p>' +
    '<div class="card' + (msg ? ' errline' : '') + '">' +
    (msg ? '<p class="err small" style="margin:0 0 12px;font-weight:600">' + esc(msg) + '</p>' : '') +
    '<h2>Entrar con mi cuenta rsanjur</h2>' +
    '<p class="muted small" style="margin-top:4px">Use su cuenta RS ID. El panel se abre solo si su correo esta en la lista de autorizados.</p>' +
    '<p style="margin-top:16px"><a class="btn" style="width:100%" href="' + esc(entrarHref()) + '">Entrar con mi cuenta rsanjur</a></p>' +
    '<p class="hint">RS ID le pedira su correo y le enviara un codigo. Al entrar, <strong>vuelve solo</strong> a este panel si su correo esta autorizado.</p>' +
    '<details style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px"><summary class="muted small" style="cursor:pointer">Acceso por token (respaldo)</summary>' +
    '<p class="hint" style="margin-top:8px">El enlace directo con token <span class="code">/admin/&lt;token&gt;</span> sigue funcionando como respaldo para quien ya lo tenga.</p>' +
    '</details></div></div>';
  return page('Panel', body, status || 200);
}

// GET /admin/entrar?rsid=<codigo> -> canjea el codigo con el RS ID y, si el correo
// esta autorizado, emite la cookie PROPIA del panel y abre el panel.
async function handleAdminEntrar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const codigo = str(url.searchParams.get('rsid'));
  if (!adminEmails(env).length) return adminLoginPage('sin_lista', 200);
  if (!codigo) return redirect('/admin?error=sin_codigo', 303);

  const r = await canjearRsid(env, codigo, SITE_ORIGIN);
  if (r.error || !r.email) {
    return redirect('/admin?error=' + encodeURIComponent(r.error || 'canje_fallido'), 303);
  }

  const email = r.email.trim().toLowerCase();
  if (adminEmails(env).indexOf(email) === -1) {
    return adminLoginPage('La cuenta ' + r.email + ' no esta autorizada para este panel.', 401);
  }
  const adminToken = String(env.ADMIN_TOKEN || '');
  if (!adminToken) return adminLoginPage('El panel no esta configurado (falta ADMIN_TOKEN).', 500);

  const headers = new Headers();
  headers.set('set-cookie', await issueAdminCookie(request, env, email));
  headers.set('location', '/admin');
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 303, headers: headers });
}

// GET /admin/salir -> cierra la sesion propia del panel.
function handleAdminSalir(request: Request, env: Env): Response {
  const headers = new Headers();
  headers.set('set-cookie', clearAdminCookie(request, env));
  headers.set('location', '/admin');
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 303, headers: headers });
}

async function handleInicio(request: Request, env: Env, tok: string, opts?: { salir?: boolean; blog?: boolean }): Promise<Response> {
  const url = new URL(request.url);
  const cRes = await env.DB
    .prepare('SELECT c.id, c.nombre, c.correo, c.telefono, c.token, c.activo, c.creado_en, ' +
      '(SELECT COUNT(*) FROM plans p WHERE p.client_id = c.id) AS planos, ' +
      '(SELECT COUNT(*) FROM downloads d WHERE d.client_id = c.id) AS descargas ' +
      'FROM clients c ORDER BY c.creado_en DESC')
    .all();
  const clients = (cRes && cRes.results) || [];

  /* Desglose de archivos por cliente: cuantos PDF, cuantos DWG, etc.
   * La mama pidio ver "2 (1 PDF, 1 DWG)" en vez de solo el numero. */
  const titulosPorCliente: Record<string, unknown[]> = {};
  try {
    const listaRes = await env.DB
      .prepare('SELECT client_id, titulo FROM plans WHERE activo = 1')
      .all();
    const lista = (listaRes && listaRes.results) || [];
    for (let i = 0; i < lista.length; i++) {
      const fila: any = lista[i];
      const cid = String(fila.client_id || '');
      (titulosPorCliente[cid] || (titulosPorCliente[cid] = [])).push(fila.titulo);
    }
  } catch (e) { /* si falla, se cae al numero simple */ }

  function desgloseDe(id: string, total: unknown): string {
    const titulos = titulosPorCliente[String(id)];
    if (!titulos || !titulos.length) return esc(total == null ? 0 : total);
    return desgloseTipos(titulos);
  }

  let rows = '';
  if (clients.length === 0) {
    rows = '<tr><td colspan="6"><div class="empty">Todavia no hay clientes. Cree el primero abajo.</div></td></tr>';
  } else {
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i];
      const link = SITE_ORIGIN + '/mis-planos/' + c.token;
      const active = Number(c.activo) === 1;
      rows += '<tr><td data-l="Cliente"><strong>' + esc(c.nombre || '') + '</strong>' +
        (c.correo ? '<div class="muted small">' + esc(c.correo) + '</div>' : '') +
        (c.telefono ? '<div class="muted small">' + esc(c.telefono) + '</div>' : '') +
        '<div class="only-desktop" style="margin-top:4px">' + (active ? '<span class="ok small">activo</span>' : '<span class="err small">revocado</span>') + '</div>' +
        '</td>' +
        '<td class="only-mobile noet"><div class="stats-inline"><div data-l="Planos">' + desgloseDe(String(c.id), c.planos) + '</div>' +
        '<div data-l="Descargas">' + esc(c.descargas) + '</div></div></td>' +
        '<td class="only-desktop">' + desgloseDe(String(c.id), c.planos) + '</td>' +
        '<td class="only-desktop">' + esc(c.descargas) + '</td>' +
        '<td class="link" data-l="Link del cliente"><a class="code" href="' + esc(link) + '">' + esc(link) + '</a></td>' +
        '<td><form method="POST" action="/admin/' + tok + '/revocar">' +
        '<input type="hidden" name="client_id" value="' + esc(c.id) + '">' +
        '<button class="btn ghost sm ' + (active ? 'danger' : '') + '" type="submit">' + (active ? 'Revocar' : 'Reactivar') + '</button>' +
        '</form></td></tr>';
    }
  }

  let options = '';
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    options += '<option value="' + esc(c.id) + '">' + esc(c.nombre || c.id) + '</option>';
  }

  // Certificados emitidos (modulo aditivo; el archivo no se guarda, solo la huella).
  let certs: any[] = [];
  try {
    await ensureCertificados(env);
    const certRes = await env.DB.prepare(
      'SELECT id, huella, nombre, descripcion, mime, tamano, emitido_en FROM certificados ORDER BY emitido_en DESC LIMIT 300',
    ).all();
    certs = (certRes && certRes.results) || [];
  } catch (e) { certs = []; }

  let certRows = '';
  if (certs.length === 0) {
    certRows = '<tr><td colspan="4"><div class="empty">Todavia no hay certificados emitidos.</div></td></tr>';
  } else {
    for (let i = 0; i < certs.length; i++) {
      const k = certs[i];
      const link = SITE_ORIGIN + '/certificado/' + k.id;
      certRows += '<tr><td data-l="Documento"><strong>' + esc(k.nombre || 'Documento') + '</strong>' +
        (k.descripcion ? '<div class="muted small">' + esc(k.descripcion) + '</div>' : '') +
        (k.tamano ? '<div class="muted small">' + esc(formatBytes(Number(k.tamano))) + '</div>' : '') +
        '<div class="only-mobile">' +
        '<div class="hint labelc">Huella SHA-256</div>' +
        '<span class="code" title="' + esc(k.huella) + '">' + esc(String(k.huella).slice(0, 12)) + '&hellip;</span>' +
        '<div class="hint labelc">Emitido</div>' +
        '<div class="muted small">' + esc(dateFmt(k.emitido_en)) + '</div>' +
        '<div class="hint labelc">Link publico</div>' +
        '<a class="code" href="' + esc(link) + '">/certificado/' + esc(k.id) + '</a>' +
        '<div class="acciones-movil"><a class="btn sm" href="' + esc(link) + '">Ver certificado</a>' +
        '<button class="btn ghost sm" type="button" data-copy="' + esc(link) + '">Copiar link</button></div>' +
        '</div></td>' +
        '<td class="only-desktop"><span class="code" title="' + esc(k.huella) + '">' + esc(String(k.huella).slice(0, 12)) + '&hellip;</span></td>' +
        '<td class="only-desktop muted small">' + esc(dateFmt(k.emitido_en)) + '</td>' +
        '<td class="only-desktop"><a class="code" href="' + esc(link) + '">/certificado/' + esc(k.id) + '</a>' +
        '<div style="margin-top:8px"><button class="btn ghost sm" type="button" data-copy="' + esc(link) + '">Copiar link</button></div></td></tr>';
    }
  }

  // Resultado de la subida: el certificado ya se emitio en la MISMA accion.
  // cert = ids nuevos, dup = ids que ya existian (misma huella, no se duplico).
  const certOk = str(url.searchParams ? url.searchParams.get('cert') : null);
  const dupOk = str(url.searchParams ? url.searchParams.get('dup') : null);
  const subidosN = url.searchParams ? str(url.searchParams.get('subidos')) : null;

  async function certMini(id: string): Promise<{ id: string; huella: string; nombre: string } | null> {
    try {
      const row = await env.DB.prepare('SELECT id, huella, nombre FROM certificados WHERE id = ?').bind(id).first();
      if (!row) return null;
      return { id: String(row.id), huella: String(row.huella || ''), nombre: String(row.nombre || 'Documento') };
    } catch (e) {
      return null;
    }
  }

  function certCard(c: { id: string; huella: string; nombre: string }, duplicado: boolean): string {
    const link = SITE_ORIGIN + '/certificado/' + c.id;
    let qr = '';
    try {
      qr = RSQR.svg(link, { size: 168, margin: 2, ecl: 'M', dark: '#0b1220', light: '#ffffff' });
    } catch (e) { qr = ''; }
    return '<details class="acc" style="margin-top:0"><summary><span class="t">' + esc(c.nombre) +
      '<small>' + (duplicado ? 'Ya tenia certificado (misma huella)' : 'Certificado creado automaticamente') + '</small></span>' +
      '<span class="chev">&#9662;</span></summary><div>' +
      '<div class="hint" style="margin-top:4px;font-weight:700;text-transform:uppercase;letter-spacing:.07em">Huella SHA-256</div>' +
      '<div class="code">' + esc(c.huella) + '</div>' +
      '<div style="margin-top:10px"><a class="code" href="' + esc(link) + '">/certificado/' + esc(c.id) + '</a></div>' +
      '<div class="row" style="margin-top:12px">' +
      '<a class="btn" href="' + esc(link) + '">Ver certificado</a>' +
      '<button class="btn ghost" type="button" data-copy="' + esc(link) + '">Copiar link</button></div>' +
      (qr ? '<div style="margin-top:12px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px;display:inline-block">' + qr + '</div>' : '') +
      '</div></details>';
  }

  let certBanner = '';
  if (certOk || dupOk) {
    const nuevosIds = (certOk || '').split(',').map((x) => x.trim()).filter(Boolean);
    const dupIds = (dupOk || '').split(',').map((x) => x.trim()).filter(Boolean);
    let tarjetas = '';
    for (let i = 0; i < nuevosIds.length; i++) {
      const c = await certMini(nuevosIds[i]);
      if (c) tarjetas += certCard(c, false);
    }
    for (let i = 0; i < dupIds.length; i++) {
      const c = await certMini(dupIds[i]);
      if (c) tarjetas += certCard(c, true);
    }
    if (tarjetas) {
      const n = nuevosIds.length;
      const d = dupIds.length;
      certBanner = '<div class="card okline">' +
        '<div class="sec"><div class="h"><h2>Plano subido y certificado emitido</h2><span class="pill">' + n + ' nuevo(s)</span></div></div>' +
        '<p class="hint" style="margin:0 0 8px">El certificado se creo en la misma accion: huella, link publico y QR listos. Comparta el enlace.' +
        (d ? ' ' + d + ' archivo(s) ya tenian certificado (misma huella): no se duplicaron, se muestra el vigente.' : '') + '</p>' +
        tarjetas + '</div>';
    }
  } else if (subidosN) {
    certBanner = '<div class="card okline"><p class="ok" style="margin:0">' +
      esc(subidosN) + ' archivo(s) subido(s).</p></div>';
  }

  /* Acciones de la sesion: solo con cuenta (no con el token suelto). */
  const acciones = (opts && opts.salir)
    ? '<a class="btn ghost sm" href="/admin/salir">Cerrar sesion</a>' +
      ((opts && opts.blog) ? '<a class="btn ghost sm" href="/admin/' + esc(tok) + '/blog">Blog</a>' : '')
    : '';

  const totalPlanos = clients.reduce(function (a: any, c: any) { return a + Number(c.planos || 0); }, 0);
  const totalDescargas = clients.reduce(function (a: any, c: any) { return a + Number(c.descargas || 0); }, 0);

  function desgloseResumen(): string {
    const titulos: unknown[] = [];
    const claves = Object.keys(titulosPorCliente);
    for (let i = 0; i < claves.length; i++) {
      const arr = titulosPorCliente[claves[i]];
      for (let j = 0; j < arr.length; j++) titulos.push(arr[j]);
    }
    if (!titulos.length) return '';
    const d = tiposDeLista(titulos);
    return d ? ' <span class="tipo-det">(' + d + ')</span>' : '';
  }

  const resumen = '<div class="card"><div class="stats-row">' +
    '<div class="stat"><b>' + clients.length + '</b><span>Clientes</span></div>' +
    '<div class="stat"><b>' + totalPlanos + '</b><span>Planos' + desgloseResumen() + '</span></div>' +
    '<div class="stat"><b>' + totalDescargas + '</b><span>Descargas</span></div>' +
    '<div class="stat"><b>' + certs.length + '</b><span>Certificados</span></div>' +
    '</div></div>';

  const tablaClientes = '<div class="card"><div class="sec"><div class="h"><h2>Clientes</h2>' +
    '<span class="pill">' + clients.length + ' registrados</span></div></div>' +
    '<div style="overflow-x:auto;margin-top:6px"><table class="tabla-clientes"><thead><tr><th>Cliente</th><th class="only-mobile">Planos y descargas</th><th class="only-desktop">Planos</th><th class="only-desktop">Descargas</th><th>Link del cliente</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';

  const tablaCerts = '<div class="card"><div class="sec"><div class="h"><h2>Certificados emitidos</h2>' +
    '<span class="pill">' + certs.length + ' total</span></div>' +
    '<p class="hint" style="margin:0">Cada certificado es una pagina publica con la huella SHA-256 del documento.</p></div>' +
    '<div style="overflow-x:auto;margin-top:6px"><table class="tabla-certificados"><thead><tr><th>Documento</th>' +
    '<th class="only-desktop">Huella</th><th class="only-desktop">Emitido</th><th class="only-desktop">Link publico</th></tr></thead><tbody>' +
    certRows + '</tbody></table></div></div>';

  const formCliente = '<details class="acc"' + (clients.length === 0 ? ' open' : '') + '><summary>' +
    '<span class="t">Nuevo cliente<small>Nombre obligatorio; correo y telefono son opcionales.</small></span><span class="chev">&#9662;</span></summary>' +
    '<div><form method="POST" action="/admin/' + tok + '/cliente" data-busy="Creando...">' +
    '<label for="n-nombre">Nombre</label><input id="n-nombre" name="nombre" required autocomplete="off" placeholder="Ej. Felix Abadia">' +
    '<div class="grid2"><div><label for="n-correo">Correo</label><input id="n-correo" name="correo" type="email" autocomplete="off" placeholder="cliente@correo.com"></div>' +
    '<div><label for="n-tel">Telefono</label><input id="n-tel" name="telefono" type="tel" autocomplete="off" placeholder="6000-0000"></div></div>' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Crear cliente</button></p></form></div></details>';

  const formPlano = '<details class="acc" open><summary>' +
    '<span class="t">Subir plano<small>Al subir se emite el certificado automaticamente (huella SHA-256 en la misma accion).</small></span><span class="chev">&#9662;</span></summary>' +
    '<div><form method="POST" action="/admin/' + tok + '/plano" enctype="multipart/form-data" data-busy="Subiendo y certificando...">' +
    '<label for="p-cliente">Cliente</label><select id="p-cliente" name="client_id" required>' + (options || '<option value="">Crea un cliente primero</option>') + '</select>' +
    '<label for="p-titulo">Titulo <span class="muted">(opcional)</span></label><input id="p-titulo" name="titulo" placeholder="Si lo dejas vacio se usa el nombre del archivo">' +
    '<label for="p-desc">Descripcion <span class="muted">(opcional)</span></label><textarea id="p-desc" name="descripcion" rows="2"></textarea>' +
    '<label for="p-arch">Archivos</label><input id="p-arch" type="file" name="archivos" multiple required accept=".pdf,.dwg,.dxf,.zip,.jpg,.jpeg,.png">' +
    '<p class="hint">PDF, DWG, DXF, ZIP o imagenes. Puedes elegir varios a la vez.</p>' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Subir y emitir certificado</button></p></form></div></details>';

  const formCert = '<details class="acc"><summary>' +
    '<span class="t">Certificar un archivo sin subirlo<small>Via secundaria: solo se guarda la huella, el archivo no se almacena.</small></span><span class="chev">&#9662;</span></summary>' +
    '<div><form method="POST" action="/admin/' + tok + '/certificado" enctype="multipart/form-data" data-busy="Emitiendo...">' +
    '<label for="c-arch">Documento</label><input id="c-arch" type="file" name="archivo" required>' +
    '<div class="grid2"><div><label for="c-nombre">Nombre visible <span class="muted">(opcional)</span></label><input id="c-nombre" name="nombre"></div>' +
    '<div><label for="c-desc">Cliente o descripcion <span class="muted">(opcional)</span></label><input id="c-desc" name="descripcion"></div></div>' +
    '<p style="margin-top:16px"><button class="btn ghost" type="submit">Emitir certificado</button></p></form></div></details>';

  const body = '<div class="sec"><h1><span>Admin de planos</span></h1><div class="row" style="gap:8px">' + acciones + '</div></div>' +
    '<p class="lead">Clientes, planos y certificados de Topografia Especializada.</p>' +
    certBanner + resumen + tablaClientes + formCliente + formPlano + formCert + tablaCerts;
  return page('Admin', body, 200);
}

async function handleCreateClient(request: Request, env: Env, tok: string): Promise<Response> {
  const form = await request.formData();
  const nombre = str(form.get('nombre'));
  if (!nombre) {
    return page('Admin', '<div class="card errline"><h1><span>Falta el nombre</span></h1>' +
      '<p class="hint">El cliente necesita un nombre para crearlo.</p>' +
      '<p style="margin-top:14px"><a class="btn ghost" href="/admin/' + tok + '">Volver</a></p></div>', 400);
  }
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, '');
  await env.DB
    .prepare('INSERT INTO clients (id, nombre, correo, telefono, token, activo, creado_en) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .bind(id, nombre, str(form.get('correo')), str(form.get('telefono')), token, new Date().toISOString())
    .run();
  return redirect('/admin/' + tok, 303);
}

async function handleUpload(request: Request, env: Env, ctx: Ctx, tok: string): Promise<Response> {
  const form = await request.formData();
  const back = '/admin/' + tok;
  const clientId = str(form.get('client_id'));
  const tituloBase = str(form.get('titulo'));
  const descripcion = str(form.get('descripcion'));
  const files = (form.getAll('archivos') as any[]).concat(form.getAll('archivo') as any[])
    .filter((f) => f && typeof f !== 'string' && typeof f.arrayBuffer === 'function');
  if (!clientId || files.length === 0) {
    return page('Admin', '<div class="card errline"><h1><span>Datos incompletos</span></h1>' +
      '<p class="hint">Elige un cliente y al menos un archivo.</p>' +
      '<p style="margin-top:14px"><a class="btn ghost" href="' + back + '">Volver</a></p></div>', 400);
  }
  const client = await env.DB.prepare('SELECT id, nombre FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) {
    return page('Admin', '<div class="card errline"><h1><span>Cliente no encontrado</span></h1>' +
      '<p class="hint">Ese cliente ya no existe. Vuelve a elegir uno en la lista.</p>' +
      '<p style="margin-top:14px"><a class="btn ghost" href="' + back + '">Volver</a></p></div>', 400);
  }
  const ahora = new Date().toISOString();
  try {
    await ensureCertificados(env);
  } catch (e) { /* el modulo de certificados es aditivo */ }
  let subidos = 0;
  const nuevos: string[] = [];      // ids de certificados creados en esta subida
  const existentes: string[] = [];  // ids de certificados que ya existian (misma huella)
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const safeName = sanitizeFileName(file.name);
    const key = 'planos/' + clientId + '/' + crypto.randomUUID() + '-' + safeName;
    const mime = file.type || 'application/octet-stream';
    const size = Number(file.size) || 0;
    const bytes = await file.arrayBuffer();
    const huella = await sha256BytesHex(bytes);
    const titulo = files.length === 1
      ? (tituloBase || safeName)
      : (tituloBase ? tituloBase + ' - ' + safeName : safeName);
    try {
      await env.PLANOS.put(key, bytes, { httpMetadata: { contentType: mime } });
      await env.DB
        .prepare('INSERT INTO plans (id, client_id, titulo, descripcion, r2_key, mime, tamano, descargas, creado_en, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)')
        .bind(crypto.randomUUID(), clientId, titulo, descripcion, key, mime, size, ahora)
        .run();
      subidos += 1;
    } catch (e) {
      // sigue con los demas archivos
    }
    // Certificado automatico en la MISMA accion. Si la huella ya existe, no se duplica.
    try {
      const prev = await env.DB.prepare('SELECT id FROM certificados WHERE huella = ? LIMIT 1').bind(huella).first();
      if (prev && prev.id) {
        existentes.push(String(prev.id));
      } else {
        const certId = nuevoIdCertificado();
        const descCert = descripcion || (client.nombre ? 'Cliente: ' + client.nombre : null);
        await env.DB
          .prepare('INSERT INTO certificados (id, huella, nombre, mime, tamano, descripcion, emisor, emitido_en, admin_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(certId, huella, titulo || safeName, mime, size, descCert, EMISOR + ' - ' + EMISOR_ORG, ahora, tok)
          .run();
        nuevos.push(certId);
      }
    } catch (e) {
      // el plano quedo subido; el certificado se puede emitir luego desde el panel
    }
  }
  return redirect(back + '?subidos=' + subidos + '&cert=' + nuevos.join(',') + '&dup=' + existentes.join(','), 303);
}

async function handleRevoke(request: Request, env: Env, tok: string): Promise<Response> {
  const form = await request.formData();
  const clientId = str(form.get('client_id'));
  if (clientId) {
    await env.DB
      .prepare('UPDATE clients SET activo = CASE WHEN activo = 1 THEN 0 ELSE 1 END WHERE id = ?')
      .bind(clientId)
      .run();
  }
  return redirect('/admin/' + tok, 303);
}

/* ==================== certificados verificables ==================== */
// Emite un certificado de un documento CUALQUIERA (PDF, DWG, JPG, ZIP, DOCX...).
// Solo se guarda su huella SHA-256 y los datos: el archivo NUNCA se sube ni se
// almacena en el sistema. Quien recibe el documento lo verifica en /verificar.

const EMISOR = 'Ing. Ricardo Sanjur';
const EMISOR_ORG = 'Topografia Especializada, S.A.';

let certificadosListo = false;
async function ensureCertificados(env: Env): Promise<void> {
  if (certificadosListo) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS certificados (id TEXT PRIMARY KEY, huella TEXT NOT NULL, ' +
    'nombre TEXT, mime TEXT, tamano INTEGER, descripcion TEXT, emisor TEXT, ' +
    'emitido_en TEXT NOT NULL, admin_token TEXT)',
  ).run();
  try {
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_certificados_huella ON certificados (huella)').run();
  } catch (e) { /* el indice es opcional */ }
  certificadosListo = true;
}

function huellaGrupos(h: unknown): string {
  return String(h || '').replace(/(.{8})/g, '$1 ').trim();
}

function nuevoIdCertificado(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function fechaLarga(value: unknown): string {
  const s = String(value || '');
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  try {
    return d.toLocaleString('es-PA', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Panama',
    });
  } catch (e) {
    return d.toISOString();
  }
}

// Paleta clara del sitio (tema topoblue light) para las paginas publicas nuevas.
const CERT_CSS = [
  ':root{--ink:#0f172a;--soft:#55627d;--line:rgba(37,99,235,.16);--primary:#2b5cff;--deep:#0a2fd6;--ok:#0b7a3b;--bad:#b42318}',
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;background:#f8f9fb;color:var(--ink);line-height:1.55;',
  'font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}',
  'a{color:var(--primary)}',
  '.top{border-bottom:1px solid rgba(0,0,0,.06);background:rgba(255,255,255,.92);',
  'backdrop-filter:blur(12px);position:sticky;top:0;z-index:5}',
  '.top .in{max-width:860px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:8px;font-weight:700}',
  '.top .in small{color:var(--soft);font-weight:500}',
  '.wrap{max-width:860px;margin:0 auto;padding:22px 18px 72px}',
  'h1{font-family:"Space Grotesk",Inter,ui-sans-serif,sans-serif;letter-spacing:-.01em;',
  'font-size:clamp(1.35rem,4.4vw,1.85rem);line-height:1.15;margin:16px 0 6px}',
  'h2{font-family:"Space Grotesk",Inter,ui-sans-serif,sans-serif;letter-spacing:-.01em;font-size:1.05rem;margin:0 0 6px}',
  '.soft{color:var(--soft)}',
  '.small{font-size:.9rem}',
  '.tiny{font-size:.78rem}',
  '.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace}',
  '.card{background:#fff;border:1px solid var(--line);border-radius:1.25rem;padding:20px;margin-top:16px;',
  'box-shadow:0 14px 36px -28px rgba(15,23,42,.5)}',
  '.badge{display:inline-flex;align-items:center;gap:7px;font-weight:700;font-size:.85rem;',
  'padding:6px 13px;border-radius:999px;border:1px solid #b7ebc9;background:#eafaf0;color:var(--ok)}',
  '.grid{display:grid;grid-template-columns:1.4fr .85fr;gap:22px;align-items:start}',
  '.label{font-family:"JetBrains Mono",monospace;font-size:.66rem;text-transform:uppercase;',
  'letter-spacing:.09em;color:var(--soft);margin-top:14px}',
  '.val{font-weight:600;font-size:.98rem;word-break:break-word}',
  '.hash{font-family:"JetBrains Mono",monospace;font-size:.78rem;word-break:break-all;',
  'background:#f2f5ff;border:1px solid var(--line);border-radius:.7rem;padding:9px 11px;color:#1c2b52}',
  '.qrbox{background:#fff;border:1px solid var(--line);border-radius:1rem;padding:14px;text-align:center}',
  '.qrbox svg{width:190px;height:190px;max-width:100%;display:block;margin:0 auto}',
  '.btn{display:inline-block;background:linear-gradient(180deg,var(--primary),var(--deep));color:#fff;',
  'border:0;border-radius:.7rem;padding:11px 18px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}',
  '.btn.ghost{background:#fff;border:1px solid var(--line);color:#243b6b}',
  '.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
  '@media(max-width:680px){.grid{grid-template-columns:1fr}}',
].join('\n');

function publicPage(title: string, body: string, status: number): Response {
  const html = '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<meta name="theme-color" content="#f8f9fb">' +
    '<title>' + esc(title) + ' | Topografia Especializada, S.A.</title>' +
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">' +
    '<style>' + CERT_CSS + '</style>\n</head>\n<body>' +
    '<header class="top"><div class="in">Topografia Especializada <small>S.A.</small></div></header>' +
    '<main class="wrap">' + body + '</main>\n</body>\n</html>';
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// GET /certificado/:id -> pagina publica con los datos + la huella + QR de si misma.
async function handleCertificado(id: string, env: Env): Promise<Response> {
  let c: any = null;
  try {
    await ensureCertificados(env);
    c = await env.DB.prepare(
      'SELECT id, huella, nombre, mime, tamano, descripcion, emisor, emitido_en ' +
      'FROM certificados WHERE id = ?',
    ).bind(id).first();
  } catch (e) {
    c = null;
  }
  if (!c) {
    const nf = '<h1>Certificado no encontrado</h1>' +
      '<p class="soft">Este codigo no corresponde a ningun certificado emitido, o fue retirado.</p>' +
      '<p style="margin-top:18px"><a class="btn ghost" href="/">Ir al sitio</a></p>';
    return publicPage('Certificado no encontrado', nf, 404);
  }

  const pageUrl = SITE_ORIGIN + '/certificado/' + encodeURIComponent(String(c.id));
  let qr = '';
  try {
    qr = RSQR.svg(pageUrl, { size: 190, margin: 2, ecl: 'M', dark: '#0b1220', light: '#ffffff' });
  } catch (e) { qr = ''; }

  const tamano = c.tamano ? formatBytes(Number(c.tamano)) : '';
  const verHref = '/verificar?h=' + encodeURIComponent(String(c.huella)) +
    (c.nombre ? '&n=' + encodeURIComponent(String(c.nombre)) : '') +
    '&id=' + encodeURIComponent(String(c.id));

  const body =
    '<span class="badge">&#10003; Documento certificado</span>' +
    '<h1>Certificado de documento</h1>' +
    '<p class="soft small" style="margin-top:0">Esta pagina acredita que el documento descrito abajo fue emitido tal cual por ' +
    esc(EMISOR) + '. Basta con comparar su huella para saber si alguien lo altero.</p>' +
    '<div class="card"><div class="grid"><div>' +
    '<div class="label">Documento</div><div class="val">' + esc(c.nombre || 'Documento') + '</div>' +
    (c.descripcion ? '<div class="label">Cliente / descripcion</div><div class="val">' + esc(c.descripcion) + '</div>' : '') +
    '<div class="label">Emitido</div><div class="val">' + esc(fechaLarga(c.emitido_en)) + '</div>' +
    '<div class="label">Emisor</div><div class="val">' + esc(c.emisor || EMISOR) + '</div>' +
    '<div class="label">Huella SHA-256</div>' +
    '<div class="hash">' + esc(huellaGrupos(c.huella)) + '</div>' +
    '<div class="label">Codigo de certificado</div>' +
    '<div class="val mono">' + esc(c.id) + (tamano ? ' <span class="soft small">(' + esc(tamano) + ')</span>' : '') + '</div>' +
    '</div><div>' +
    '<div class="qrbox">' + (qr || '<div class="soft small">QR no disponible</div>') +
    '<div class="tiny soft" style="margin-top:8px">Escanee para volver a esta pagina</div></div>' +
    '</div></div></div>' +
    '<div class="card"><h2>Como se comprueba</h2>' +
    '<p class="soft small" style="margin-top:0">Abra la verificacion, elija el archivo que recibio y su navegador calcula su ' +
    'huella SHA-256. Si coincide con la de arriba, el documento es el original; si no, fue alterado.</p>' +
    '<p><a class="btn" href="' + esc(verHref) + '">Verificar un archivo</a></p>' +
    '<p class="tiny soft" style="margin-bottom:0">El archivo nunca se sube a un servidor: la comparacion ocurre en su navegador.</p>' +
    '</div>';
  return publicPage('Certificado ' + c.id, body, 200);
}

// POST /admin/:tok/certificado -> calcula la huella y guarda los datos (sin el archivo).
async function handleEmitirCertificado(request: Request, env: Env, tok: string): Promise<Response> {
  const back = '/admin/' + tok;
  const form = await request.formData();
  const file: any = form.get('archivo');
  const descripcion = str(form.get('descripcion'));
  const nombreManual = str(form.get('nombre'));
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return page('Admin', '<div class="card errline"><h1><span>Falta el archivo</span></h1>' +
      '<p class="hint">Elige el documento a certificar.</p>' +
      '<p style="margin-top:14px"><a class="btn ghost" href="' + back + '">Volver</a></p></div>', 400);
  }
  try {
    await ensureCertificados(env);
    const bytes = await file.arrayBuffer();
    const huella = await sha256BytesHex(bytes);
    const id = nuevoIdCertificado();
    const nombre = nombreManual || sanitizeFileName(file.name) || 'documento';
    await env.DB.prepare(
      'INSERT INTO certificados (id, huella, nombre, mime, tamano, descripcion, emisor, emitido_en, admin_token) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, huella, nombre, file.type || 'application/octet-stream',
      Number(file.size) || bytes.byteLength, descripcion, EMISOR + ' - ' + EMISOR_ORG,
      new Date().toISOString(), tok).run();
    return redirect(back + '?cert=' + id, 303);
  } catch (e) {
    return page('Admin', '<div class="card errline"><h1><span>No se pudo emitir</span></h1>' +
      '<p class="hint">' + esc(String((e as any) && (e as any).message || e)) + '</p>' +
      '<p style="margin-top:14px"><a class="btn ghost" href="' + back + '">Volver</a></p></div>', 500);
  }
}

/* ============================ router ============================ */

export default {
  async fetch(
    request: Request & { cf?: { country?: string } },
    env: Env,
    ctx: Ctx,
  ): Promise<Response> {
    const url = new URL(request.url);
    // Primero se crean las tablas si faltan (en local) y luego se pasan los artículos
    // que estaban como archivo a la base, para que todos se puedan editar desde el panel.
    // El mapa del sitio se arma aquí (incluye los artículos de la base), no en el sitio.
    if (env.LOCAL_PRUEBA === '1') {
      await prepararBaseLocal(env);
      await sembrarArticulos(env);
    } else {
      await sembrarArticulos(env);
    }

    // Host canonico: apex -> www.
    if (url.hostname === 'ricardosanjur.com') {
      url.hostname = 'www.ricardosanjur.com';
      return Response.redirect(url.toString(), 301);
    }

    const method = request.method;
    let path = url.pathname;
    if (path.length > 1 && path.slice(-1) === '/') path = path.replace(/\/+$/, '');

    // El mapa del sitio se arma aquí (incluye los artículos de la base), no en el sitio.
    if (method === 'GET' && path === '/sitemap.xml') return handleSitemap(env, url);

    // Redirect por pais en "/" (sin bots, sin cookie lang).
    const ua = request.headers.get('User-Agent') ?? '';
    const isBot = /(googlebot|bingbot|bingpreview|duckduckbot|yandex|baiduspider|slurp|crawler|spider|bot)/i.test(ua);
    if (method === 'GET' && url.pathname === '/' && !hasLangCookie(request) && !isBot) {
      const country = request.cf?.country;
      if (country && !HISPANIC_COUNTRIES.has(country)) {
        return Response.redirect(new URL('/en/', url).toString(), 302);
      }
    }

    // Migracion desde el WordPress viejo.
    const isGone = GONE_PREFIXES.some(function (g) {
      return path === g || path.startsWith(g + '/');
    });
    if (isGone) {
      return new Response('410 Gone', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const legacyTarget = LEGACY_REDIRECTS[path] || legacyArchiveTarget(path);
    if (legacyTarget && legacyTarget !== url.pathname) {
      return redirect(legacyTarget, 301);
    }

    // Mis Planos (cliente).
    const mPlan = path.match(/^\/mis-planos\/([A-Za-z0-9_-]+)\/plano\/([^\/]+)$/);
    if (method === 'GET' && mPlan) {
      return handleDownload(mPlan[1], decodeURIComponent(mPlan[2]), env);
    }
    const mTok = path.match(/^\/mis-planos\/([A-Za-z0-9_-]+)$/);
    if (method === 'GET' && mTok) {
      return handleClient(mTok[1], env);
    }
    const mZip = path.match(/^\/mis-planos\/([A-Za-z0-9_-]+)\/zip$/);
    if (method === 'GET' && mZip) {
      return handleZip(mZip[1], env);
    }

    // Admin por token en la URL (sin login, sin cookies).
    const mAdmin = path.match(/^\/admin\/([A-Za-z0-9_-]{16,})(\/(cliente|plano|revocar|certificado|blog)(\/(nuevo|[A-Za-z0-9_-]{3,}))?)?$/);
    if (mAdmin) {
      const token = String(env.ADMIN_TOKEN || '');
      if (!token || !constantTimeEqual(mAdmin[1], token)) {
        return new Response('No encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const sub = mAdmin[2];
      if (!sub && method === 'GET') return handleInicio(request, env, mAdmin[1]);
      if (sub === '/cliente' && method === 'POST') return handleCreateClient(request, env, mAdmin[1]);
      if (sub === '/plano' && method === 'POST') return handleUpload(request, env, ctx, mAdmin[1]);
      // Blog: el papa escribe y publica desde el mismo panel (sin tocar codigo).
      const mBlog = path.match(/^\/admin\/([A-Za-z0-9_-]{16,})\/blog(?:\/(nuevo|[A-Za-z0-9_-]{3,}))?$/);
      if (mBlog) {
        const mBlogAccion = path.match(/^\/admin\/([A-Za-z0-9_-]{16,})\/blog\/(guardar|borrar)$/);
        if (mBlogAccion && method === 'POST') {
          if (mBlogAccion[2] === 'guardar') return handleBlogGuardar(request, env as any, mAdmin[1]);
          return handleBlogBorrar(request, env as any, mAdmin[1]);
        }
        if (method === 'GET') {
          const aviso = str(url.searchParams.get('aviso'));
          const sub2 = mBlog[2];
          if (!sub2) return handleBlogLista(env as any, mAdmin[1], aviso);
          return handleBlogForm(env as any, mAdmin[1], sub2, aviso);
        }
      }
      if (sub === '/revocar' && method === 'POST') return handleRevoke(request, env, mAdmin[1]);
      if (sub === '/certificado' && method === 'POST') return handleEmitirCertificado(request, env, mAdmin[1]);
    }

    // Regreso del login del RS ID: canjea el codigo y abre la sesion propia del panel.
    if (method === 'GET' && path === '/admin/entrar') return handleAdminEntrar(request, env);
    if (method === 'GET' && path === '/admin/salir') return handleAdminSalir(request, env);

    // Acceso al panel con la cuenta RS ID (id.rsanjur.com), sin pegar el token en la URL.
    // El acceso por token (/admin/<token>) sigue intacto como respaldo.
    if (path === '/admin') {
      if (method !== 'GET') {
        return new Response('No encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (!adminEmails(env).length) return adminLoginPage('sin_lista', 200);
      const adminToken = String(env.ADMIN_TOKEN || '');
      const email = await adminAutorizado(request, env);
      // Con sesion valida: el panel se abre aqui mismo (sin token en la URL).
      if (email && adminToken) return handleInicio(request, env, adminToken, { salir: true, blog: true });
      if (email && !adminToken) return adminLoginPage('El panel no esta configurado (falta ADMIN_TOKEN).', 500);
      const err = str(url.searchParams.get('error'));
      const aviso = err ? adminAvisoDeError(err) : '';
      const hayCookie = !!readCookie(request, RS_ID_COOKIE) || !!readCookie(request, ADMIN_COOKIE);
      if (aviso) return adminLoginPage(aviso, 401);
      return adminLoginPage(hayCookie ? 'Su correo no esta autorizado para el panel.' : '', hayCookie ? 401 : 200);
    }

    // Certificado publico por id (pagina que abre el QR; sin clave, noindex).
    const mCert = path.match(/^\/certificado\/([A-Za-z0-9_-]{6,40})$/);
    if (method === 'GET' && mCert) {
      return handleCertificado(mCert[1], env);
    }

    // Formulario de contacto del sitio (antes devolvia 405 y se perdian los mensajes).
    if (path === '/api/contact') {
      if (method === 'POST') return handleContact(request, env, ctx);
      return jsonResponse({ ok: false, error: 'method' }, 405);
    }

    // Descarga de un adjunto de cotizacion desde el correo (link firmado y con caducidad).
    const mAdj = path.match(/^\/mis-solicitudes\/([A-Za-z0-9-]{8,64})$/);
    if (method === 'GET' && mAdj) return handleDescargaArchivo(request, env, mAdj[1]);

    // Adjuntos de una solicitud de cotizacion (van aparte del texto a proposito).
    if (path === '/api/contact/files') {
      if (method === 'POST') return handleContactFiles(request, env);
      return jsonResponse({ ok: false, error: 'method' }, 405);
    }

    // Alias del formulario de cotizacion. El formulario de Servicios ya no sube
    // archivos y manda todo por /api/contact, pero una pagina cacheada todavia
    // puede apuntar aqui: se responde igual en vez del 405 que dejaba al cliente
    // con "Hubo un error" y el mensaje perdido.
    if (path === '/api/quote') {
      if (method === 'POST') return handleContact(request, env, ctx);
      return jsonResponse({ ok: false, error: 'method' }, 405);
    }

    /* Blog publico: lo que el papa publica desde el panel vive en D1 y se sirve
     * desde aca. Si no hay nada en la base (o la tabla no existe todavia), cae
     * al sitio estatico, que sigue sirviendo los articulos .md del repo. */
    if (method === 'GET' && (path === '/blog-api' || path === '/blog-api/')) {
      return handleBlogIndex(env as any, str(url.searchParams.get('idioma')) === 'en' ? 'en' : 'es');
    }
    /* Blog: el dueño publica desde el panel y sale igual que con el sitio.
     * - /blog y /blog/<dirección> los arma la página (menú, pie y tarjetas).
     * - Con ?r=1 (la página ya se armó) el worker le suma los artículos de la
     *   base: la misma tarjeta y, en el artículo, una pestaña de confianza.
     * - /blog/<dirección>/<archivo> = foto o archivo subido (R2).
     */
    if (method === 'GET' && /^\/blog(\/[a-z0-9-]{3,80})?$/.test(path)) {
      const slug = path === '/blog' ? '' : path.split('/').pop()!;
      const tarjeta = slug ? await handleBlogPostHtml(env as any, 'es', slug) : await handleBlogTarjeta(env as any, 'es', slug);
      if (tarjeta === null && slug) {
        // No está en la base: el artículo estático del repo (o 404 si no existe).
        return env.ASSETS.fetch(request);
      }
      // La página del sitio arma el marco (menú, pie, tarjetas del repo) y aquí se
      // le agrega lo que vive en la base: la tarjeta nueva o el artículo completo.
      // Al sitio se le pide /blog/ (la página en su estado normal): pedir /blog/<slug>
      // traería el 404, porque ese artículo no existe como archivo.
      // /blog/ pedido internamente como navegación vuelve con el 404 del sitio: se pide
      // directamente blog/index.html, que es la página de verdad.
      // Sin caché de la CDN del sitio: la página se arma en cada visita (si no,
      // un artículo corregido seguía mostrando el viejo durante un día).
      let html = await (await env.ASSETS.fetch(new Request(url.origin + '/blog/index.html', {
        headers: request.headers,
        cf: { cacheEverything: false, cacheTtl: 0 },
      } as RequestInit))).text();
      if (html.indexOf('<html') < 0) {
        html = await (await env.ASSETS.fetch(new Request(url.origin + '/blog/' + url.search, { headers: request.headers }))).text();
      }
      html = html.split(url.origin + '/_astro/').join('/_astro/');
      if (tarjeta) {
        if (slug) {
          // Un artículo: va ARRIBA, en el lugar de la portada del índice (si quedara
          // abajo, la portada "Noticias y Artículos" aparecería en medio).
          const hero = html.indexOf('<section class="relative h-[50vh]');
          const abre = hero > -1 ? hero : html.lastIndexOf('</header>') + '</header>'.length;
          const cierra = html.lastIndexOf('</main>');
          html = html.slice(0, abre) + NUBE_CSS + tarjeta + (cierra > abre ? html.slice(cierra) : '');
          // El artículo tiene su propio diseño: que respire como en el resto del sitio.
          html = html.replace('<body', '<body class="nube-articulo"');
        } else {
          // El índice: el artículo de la base REEMPLAZA a su tarjeta del repo (no se
          // repite) y todo queda con la misma cara del sitio. Va primero, que es lo más
          // nuevo. La tarjeta del repo se reconoce por su link /blog/<dirección>/.
          const deLaBase = new Set<string>();
          for (const m of tarjeta.matchAll(/data-slug="([a-z0-9-]+)"/g)) deLaBase.add(m[1]);
          for (const slugBase of deLaBase) {
            const link = '<a href="/blog/' + slugBase + '/"';
            let desde = 0;
            while (true) {
              const i = html.indexOf(link, desde);
              if (i < 0) break;
              const abre = html.lastIndexOf('<article', i);
              const cierra = abre > -1 ? html.indexOf('</article>', i) : -1;
              if (abre > -1 && cierra > -1) {
                html = html.slice(0, abre) + html.slice(cierra + '</article>'.length);
                desde = abre;
              } else {
                desde = i + link.length;
              }
            }
          }
          let fin = html.indexOf('<div class="grid grid-cols-1 md:grid-cols-2');
          if (fin > -1) {
            fin = html.indexOf('>', fin) + 1;
          } else {
            fin = html.lastIndexOf('</main>');
          }
          if (fin < 0) fin = html.indexOf('</body>');
          if (fin < 0) html += NUBE_CSS + tarjeta;
          else html = html.slice(0, fin) + NUBE_CSS + tarjeta + html.slice(fin);
        }
      }
      const salida = html;
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' };
      if (slug) headers['x-robots-tag'] = 'noindex';
      return new Response(salida, { headers });
    }
    // Fotos y archivos que el dueño subió con su artículo (viven en R2, carpeta del artículo).
    const mBlogFoto = path.match(/^\/blog\/([a-z0-9-]{3,80})\/([A-Za-z0-9._-]{1,120})$/);
    if (method === 'GET' && mBlogFoto && !/^(index\.html)?$/.test(mBlogFoto[2])) {
      return handleBlogArchivo(env as any, mBlogFoto[1], mBlogFoto[2]);
    }
    const mBlogPub = path.match(/^\/blog-api\/([a-z0-9-]{3,80})\/?$/);
    if (method === 'GET' && mBlogPub) {
      const r = await handleBlogPost(env as any, str(url.searchParams.get('idioma')) === 'en' ? 'en' : 'es', mBlogPub[1]);
      if (r) return r;
    }

    return env.ASSETS.fetch(request);
  },
};
