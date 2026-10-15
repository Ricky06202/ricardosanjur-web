// Cloudflare Worker: redirect por pais en "/" + area privada "Mis Planos".
// Bindings: ASSETS (sitio estatico), DB (D1: clients/plans/downloads), PLANOS (R2).
// Secretos: PANEL_CLAVE (contrasena del panel), PANEL_SECRET (firma de cookie).
// Solo usa las tablas clients, plans y downloads de la D1 compartida, mas la tabla
// aditiva certificados (huella SHA-256 de documentos, pagina publica y verificacion).

import RSQR from './qr.js';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  DB: any;
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
  contactosListo = true;
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// A donde llegan los mensajes del sitio: el correo que la pagina ya publica.
const DESTINO_CONTACTO = 'gerencia@ricardosanjur.com';

function escCorreo(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Aviso por correo. BEST-EFFORT: si falla, el mensaje YA quedo en la base.
async function avisarContacto(env: Env, d: { nombre: string; email: string; telefono: string; tema: string; mensaje: string; id: string; ahora: string }) {
  if (!env.EMAIL) return { enviado: false, error: 'sin_binding_email' };
  const filas = [
    ['Nombre', d.nombre],
    ['Correo', d.email || '-'],
    ['Telefono', d.telefono || '-'],
    ['Tema', d.tema || '-'],
    ['Recibido', d.ahora],
  ].map(([k, v]) => '<tr><td style="padding:6px 14px 6px 0;color:#777;vertical-align:top">' + escCorreo(k) + '</td><td style="padding:6px 0;font-weight:600">' + escCorreo(v) + '</td></tr>').join('');
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827">' +
      '<h2 style="margin:0 0 4px">Nuevo mensaje del sitio</h2>' +
      '<p style="margin:0 0 16px;color:#777">Topografia Especializada — ricardosanjur.com</p>' +
      '<table style="border-collapse:collapse">' + filas + '</table>' +
      '<div style="margin-top:18px;padding:16px;background:#F3F6FF;border-left:3px solid #2b5cff;white-space:pre-wrap">' + escCorreo(d.mensaje) + '</div>' +
      '<p style="margin-top:18px;color:#777;font-size:13px">Para responder, escribile a <a href="mailto:' + escCorreo(d.email) + '">' + escCorreo(d.email) + '</a>.</p>' +
    '</div>';
  const text = 'Nuevo mensaje del sitio\n\nNombre: ' + d.nombre + '\nCorreo: ' + (d.email || '-') +
    '\nTelefono: ' + (d.telefono || '-') + '\nTema: ' + (d.tema || '-') + '\n\n' + d.mensaje +
    '\n\n---\nRespondele a ' + (d.email || '-') + '.';
  try {
    const res = await env.EMAIL.send({
      to: DESTINO_CONTACTO,
      from: 'Topografia Ricardosanjur <no-reply@ricardosanjur.com>',
      subject: 'Nuevo mensaje del sitio: ' + String(d.nombre || '').slice(0, 80),
      html: html,
      text: text,
    });
    return { enviado: true, messageId: (res && res.messageId) || null };
  } catch (e) {
    console.log('[contacto] EMAIL.send fallo: ' + String((e as any) && (e as any).message || e));
    return { enviado: false, error: 'envio_fallo' };
  }
}

async function handleContact(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  let data: any = null;
  try {
    data = await request.json();
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== 'object') return jsonResponse({ ok: false, error: 'json' }, 400);

  const nombre = str(data.nombre);
  const email = str(data.email);
  const telefono = str(data.telefono);
  const tema = str(data.tema);
  const mensaje = str(data.mensaje);
  if (!nombre || !mensaje) return jsonResponse({ ok: false, error: 'campos' }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse({ ok: false, error: 'email' }, 400);

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
  const aviso = await avisarContacto(env, { nombre, email, telefono, tema, mensaje, id, ahora });
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

const CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  'body{min-height:100vh;background:#05070f;color:#e7ecf7;font-family:Inter,ui-sans-serif,system-ui,sans-serif;',
  'background-image:radial-gradient(1100px 620px at 12% -8%,rgba(43,92,255,.28),transparent 60%),radial-gradient(900px 560px at 100% 0%,rgba(0,212,255,.16),transparent 55%);}',
  'a{color:#8fb0ff}',
  '.brand{font-weight:700;letter-spacing:.02em;padding:20px;font-size:1rem}',
  '.brand small{color:#93a0bd;font-weight:500}',
  'main{max-width:980px;margin:0 auto;padding:24px 20px 80px}',
  'h1{font-size:clamp(1.5rem,4vw,2.2rem);margin:0 0 8px}',
  'h1 span{background:linear-gradient(100deg,#fff,#9db4ff 45%,#5b83ff);-webkit-background-clip:text;background-clip:text;color:transparent}',
  'h2{font-size:1.1rem;margin:0 0 4px}',
  '.muted{color:#93a0bd}',
  '.card{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid rgba(150,175,255,.14);border-radius:1.25rem;padding:20px;margin-top:18px;backdrop-filter:blur(12px)}',
  '.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between}',
  '.plan{border:1px solid rgba(150,175,255,.16);border-radius:1rem;padding:16px;margin-top:12px;background:rgba(10,16,32,.5)}',
  '.btn{display:inline-block;background:linear-gradient(180deg,#2b5cff,#0a2fd6);color:#fff;border:0;border-radius:.7rem;padding:11px 18px;font-weight:600;text-decoration:none;cursor:pointer;font:inherit}',
  '.btn.ghost{background:transparent;border:1px solid rgba(150,175,255,.3);color:#cfe0ff}',
  '.pill{font-size:.78rem;color:#9db4ff;border:1px solid rgba(150,175,255,.25);border-radius:999px;padding:3px 10px}',
  'input,select,textarea{width:100%;padding:11px 12px;border-radius:.7rem;border:1px solid rgba(150,175,255,.22);background:rgba(5,7,15,.7);color:#e7ecf7;font:inherit}',
  'label{display:block;font-size:.85rem;margin:12px 0 6px;color:#aebbdc}',
  '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
  'table{width:100%;border-collapse:collapse;font-size:.92rem}',
  'th,td{text-align:left;padding:10px 8px;border-bottom:1px solid rgba(150,175,255,.12);vertical-align:top}',
  'th{color:#93a0bd;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}',
  '.err{color:#ff9b9b}',
  '.ok{color:#7ee0b0}',
  '.code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.82rem;background:rgba(5,7,15,.7);border:1px solid rgba(150,175,255,.2);border-radius:.6rem;padding:5px 9px;display:inline-block;word-break:break-all}',
  '@media(max-width:640px){.grid2{grid-template-columns:1fr}}',
].join('\n');

function page(title: string, body: string, status: number): Response {
  const html = '<!doctype html>\n<html lang="es" data-theme="topoblue"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + esc(title) + ' | Topografia Especializada</title>' +
    '<style>' + CSS + '</style></head><body>' +
    '<header class="brand">Topografia Especializada <small>S.A.</small></header>' +
    '<main>' + body + '</main></body></html>';
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function notFoundPage(message: string): Response {
  const body = '<h1><span>No encontrado</span></h1>' +
    '<p class="muted">' + esc(message || 'Este enlace no es valido o fue desactivado.') + '</p>' +
    '<p><a class="btn ghost" href="' + SITE_ORIGIN + '/">Ir al sitio</a></p>';
  return page('No encontrado', body, 404);
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
    listHtml = '<div class="card"><p class="muted">Aun no tiene planos disponibles.</p></div>';
  } else {
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const href = '/mis-planos/' + encodeURIComponent(token) + '/plano/' + encodeURIComponent(String(p.id));
      const size = p.tamano ? formatBytes(Number(p.tamano)) : '';
      const when = dateFmt(p.creado_en);
      const meta = [when, size].filter(Boolean).join(' - ');
      listHtml += '<div class="plan"><div class="row"><div>' +
        '<strong>' + esc(p.titulo || 'Plano') + '</strong>' +
        (p.descripcion ? '<div class="muted">' + esc(p.descripcion) + '</div>' : '') +
        (meta ? '<div class="muted" style="font-size:.82rem">' + esc(meta) + '</div>' : '') +
        '</div><a class="btn" href="' + esc(href) + '">Descargar</a></div></div>';
    }
  }

  const body = '<h1>Hola, <span>' + esc(client.nombre || 'cliente') + '</span></h1>' +
    '<p class="muted">Estos son sus planos disponibles. Cada enlace descarga el archivo.</p>' +
    (plans.length > 1 ? '<p style="margin:14px 0"><a class="btn" href="/mis-planos/' + encodeURIComponent(token) + '/zip">Descargar todo (ZIP)</a></p>' : '') +
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
  const body = '<h1><span>Panel de planos</span></h1>' +
    '<p class="muted">Acceso privado.</p>' +
    '<div class="card" style="max-width:420px">' +
    (error ? '<p class="err">' + esc(error) + '</p>' : '') +
    '<form method="POST" action="/panel-planos/login">' +
    '<label for="clave">Contrasena</label>' +
    '<input type="password" id="clave" name="clave" required autocomplete="current-password">' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Entrar</button></p>' +
    '</form></div>';
  return page('Panel', body, error ? 401 : 200);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.PANEL_CLAVE || !env.PANEL_SECRET) {
    return page('Panel', '<h1><span>Panel no configurado</span></h1><p class="muted">Faltan los secretos PANEL_CLAVE / PANEL_SECRET.</p>', 500);
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
  const body = '<h1><span>Panel de planos</span></h1>' +
    '<p class="muted">Acceso privado para el ingeniero y administradores.</p>' +
    '<div class="card" style="max-width:480px">' +
    (msg ? '<p class="err">' + esc(msg) + '</p>' : '') +
    '<h2>Entrar con mi cuenta rsanjur</h2>' +
    '<p class="muted" style="margin-top:0">Use su cuenta RS ID. El panel se abre solo si su correo esta en la lista de autorizados.</p>' +
    '<p style="margin-top:16px"><a class="btn" href="' + esc(entrarHref()) + '">Entrar con mi cuenta rsanjur</a></p>' +
    '<p class="muted" style="font-size:.82rem">RS ID le pedira su correo y le enviara un codigo. Al entrar, <strong>vuelve solo</strong> a este panel si su correo esta autorizado.</p>' +
    '</div>' +
    '<div class="card" style="max-width:480px"><details><summary class="muted" style="cursor:pointer">Acceso por token (respaldo)</summary>' +
    '<p class="muted" style="font-size:.86rem;margin-bottom:0">El enlace directo con token <span class="code">/admin/&lt;token&gt;</span> sigue funcionando como respaldo para quien ya lo tenga.</p>' +
    '</details></div>';
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

async function handleInicio(request: Request, env: Env, tok: string, opts?: { salir?: boolean }): Promise<Response> {
  const url = new URL(request.url);
  const cRes = await env.DB
    .prepare('SELECT c.id, c.nombre, c.correo, c.telefono, c.token, c.activo, c.creado_en, ' +
      '(SELECT COUNT(*) FROM plans p WHERE p.client_id = c.id) AS planos, ' +
      '(SELECT COUNT(*) FROM downloads d WHERE d.client_id = c.id) AS descargas ' +
      'FROM clients c ORDER BY c.creado_en DESC')
    .all();
  const clients = (cRes && cRes.results) || [];

  let rows = '';
  if (clients.length === 0) {
    rows = '<tr><td colspan="5" class="muted">Sin clientes todavia.</td></tr>';
  } else {
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i];
      const link = SITE_ORIGIN + '/mis-planos/' + c.token;
      const active = Number(c.activo) === 1;
      rows += '<tr><td><strong>' + esc(c.nombre || '') + '</strong>' +
        (c.correo ? '<div class="muted" style="font-size:.8rem">' + esc(c.correo) + '</div>' : '') +
        (c.telefono ? '<div class="muted" style="font-size:.8rem">' + esc(c.telefono) + '</div>' : '') +
        '</td>' +
        '<td>' + esc(c.planos) + '</td>' +
        '<td>' + esc(c.descargas) + '</td>' +
        '<td><a class="code" href="' + esc(link) + '">' + esc(link) + '</a>' +
        '<div style="margin-top:6px">' + (active ? '<span class="ok">activo</span>' : '<span class="err">revocado</span>') + '</div></td>' +
        '<td><form method="POST" action="/admin/' + tok + '/revocar">' +
        '<input type="hidden" name="client_id" value="' + esc(c.id) + '">' +
        '<button class="btn ghost" type="submit">' + (active ? 'Revocar' : 'Reactivar') + '</button>' +
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
    certRows = '<tr><td colspan="4" class="muted">Sin certificados emitidos todavia.</td></tr>';
  } else {
    for (let i = 0; i < certs.length; i++) {
      const k = certs[i];
      const link = SITE_ORIGIN + '/certificado/' + k.id;
      certRows += '<tr><td><strong>' + esc(k.nombre || 'Documento') + '</strong>' +
        (k.descripcion ? '<div class="muted" style="font-size:.8rem">' + esc(k.descripcion) + '</div>' : '') +
        (k.tamano ? '<div class="muted" style="font-size:.78rem">' + esc(formatBytes(Number(k.tamano))) + '</div>' : '') +
        '</td>' +
        '<td><span class="code" title="' + esc(k.huella) + '">' + esc(String(k.huella).slice(0, 12)) + '&hellip;</span></td>' +
        '<td class="muted" style="font-size:.84rem">' + esc(dateFmt(k.emitido_en)) + '</td>' +
        '<td><a class="code" href="' + esc(link) + '">/certificado/' + esc(k.id) + '</a>' +
        '<div style="margin-top:6px"><button class="btn ghost" type="button" data-copy="' + esc(link) + '">Copiar link</button></div></td></tr>';
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
    return '<div class="plan">' +
      '<strong>' + esc(c.nombre) + '</strong>' +
      (duplicado
        ? '<div class="ok" style="font-size:.84rem">Ya tenia certificado (misma huella). No se duplico.</div>'
        : '<div class="ok" style="font-size:.84rem">Certificado creado automaticamente.</div>') +
      '<div class="muted" style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;margin-top:10px">Huella SHA-256</div>' +
      '<div class="code">' + esc(c.huella) + '</div>' +
      '<div style="margin-top:10px"><a class="code" href="' + esc(link) + '">/certificado/' + esc(c.id) + '</a></div>' +
      '<div class="row" style="margin-top:12px">' +
      '<a class="btn" href="' + esc(link) + '">Ver certificado</a>' +
      '<button class="btn ghost" type="button" data-copy="' + esc(link) + '">Copiar link</button></div>' +
      (qr ? '<div style="margin-top:12px;background:#fff;border-radius:.7rem;padding:10px;display:inline-block">' + qr + '</div>' : '') +
      '</div>';
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
      certBanner = '<div class="card" style="border-color:rgba(120,255,190,.35)">' +
        '<div class="row"><h2>Plano subido y certificado emitido</h2><span class="pill">' + n + ' nuevo(s)</span></div>' +
        '<p class="muted" style="margin-top:-4px">El certificado se creo en la misma accion: huella, link publico y QR listos. Comparta el enlace.' +
        (d ? ' ' + d + ' archivo(s) ya tenian certificado (misma huella): no se duplicaron, se muestra el vigente.' : '') + '</p>' +
        '<div class="grid2">' + tarjetas + '</div></div>';
    }
  } else if (subidosN) {
    certBanner = '<div class="card" style="border-color:rgba(120,255,190,.3)"><p class="ok" style="margin:0">' +
      esc(subidosN) + ' archivo(s) subido(s).</p></div>';
  }

  const salirLink = (opts && opts.salir)
    ? ' <a class="pill" href="/admin/salir" style="text-decoration:none">Cerrar sesion</a>'
    : '';
  const body = '<h1><span>Admin de planos</span>' + salirLink + '</h1>' +
    '<p class="muted">Clientes, planos y descargas.</p>' +
    certBanner +
    '<div class="card"><div class="row"><h2>Clientes</h2><span class="pill">' + clients.length + ' registrados</span></div>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Cliente</th><th>#Planos</th><th>#Descargas</th><th>Link del cliente</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="card"><h2>Nuevo cliente</h2><form method="POST" action="/admin/' + tok + '/cliente"><div class="grid2">' +
    '<div><label>Nombre</label><input name="nombre" required></div>' +
    '<div><label>Correo</label><input name="correo" type="email"></div>' +
    '<div><label>Telefono</label><input name="telefono"></div>' +
    '</div><p style="margin-top:16px"><button class="btn" type="submit">Crear cliente</button></p></form></div>' +
    '<div class="card"><h2>Subir plano y emitir certificado</h2>' +
    '<p class="muted" style="margin-top:-6px">Al guardar se calcula la huella SHA-256 de cada archivo y <strong>el certificado se crea automaticamente</strong> en la misma accion: sin segundo paso. Puedes elegir varios archivos a la vez.</p>' +
    '<form method="POST" action="/admin/' + tok + '/plano" enctype="multipart/form-data">' +
    '<label>Cliente</label><select name="client_id" required>' + (options || '<option value="">Crea un cliente primero</option>') + '</select>' +
    '<label>Titulo (opcional: si lo dejas vacio se usa el nombre del archivo)</label><input name="titulo">' +
    '<label>Descripcion (opcional)</label><textarea name="descripcion" rows="2"></textarea>' +
    '<label>Archivos (PDF / DWG / ZIP - selecciona varios con Ctrl o manteniendo)</label><input type="file" name="archivos" multiple required>' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Subir plano y emitir certificado</button></p></form></div>' +
    '<div class="card"><div class="row"><h2>Certificados emitidos</h2><span class="pill">' + certs.length + ' total</span></div>' +
    '<p class="muted" style="margin-top:-4px">Cada certificado es una pagina publica con la huella SHA-256 del documento. Comparta el enlace: cualquiera verifica el archivo sin subirlo.</p>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Documento</th><th>Huella</th><th>Emitido</th><th>Link publico</th></tr></thead><tbody>' +
    certRows + '</tbody></table></div></div>' +
    '<div class="card"><h2>Certificar un archivo sin subirlo (opcional)</h2>' +
    '<p class="muted" style="margin-top:-4px">Via secundaria para certificar un archivo que no se sube al portal. Cualquier archivo (PDF, DWG, JPG, ZIP, DOCX...): se calcula su huella SHA-256 y <strong>el archivo no se guarda</strong> en el sistema. El camino normal es subir el plano arriba.</p>' +
    '<form method="POST" action="/admin/' + tok + '/certificado" enctype="multipart/form-data">' +
    '<label>Documento</label><input type="file" name="archivo" required>' +
    '<label>Nombre visible (opcional: si lo deja vacio se usa el nombre del archivo)</label><input name="nombre">' +
    '<label>Cliente o descripcion (opcional)</label><input name="descripcion">' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Emitir certificado</button></p></form></div>' +
    '<script>(function(){var bs=document.querySelectorAll("[data-copy]");for(var i=0;i<bs.length;i++){(function(b){b.addEventListener("click",function(){var t=b.getAttribute("data-copy")||"";if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent="Copiado";setTimeout(function(){b.textContent=o;},1500);});}});})(bs[i]);}})();</script>';
  return page('Admin', body, 200);
}

async function handleCreateClient(request: Request, env: Env, tok: string): Promise<Response> {
  const form = await request.formData();
  const nombre = str(form.get('nombre'));
  if (!nombre) {
    return page('Admin', '<h1><span>Falta el nombre</span></h1><p><a class="btn ghost" href="/admin/' + tok + '">Volver</a></p>', 400);
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
    return page('Admin', '<h1><span>Datos incompletos</span></h1><p class="muted">Elige un cliente y al menos un archivo.</p><p><a class="btn ghost" href="' + back + '">Volver</a></p>', 400);
  }
  const client = await env.DB.prepare('SELECT id, nombre FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) {
    return page('Admin', '<h1><span>Cliente no encontrado</span></h1><p><a class="btn ghost" href="' + back + '">Volver</a></p>', 400);
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
    return page('Admin', '<h1><span>Falta el archivo</span></h1><p class="muted">Elige el documento a certificar.</p>' +
      '<p><a class="btn ghost" href="' + back + '">Volver</a></p>', 400);
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
    return page('Admin', '<h1><span>No se pudo emitir</span></h1><p class="muted">' +
      esc(String((e as any) && (e as any).message || e)) + '</p>' +
      '<p><a class="btn ghost" href="' + back + '">Volver</a></p>', 500);
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

    // Host canonico: apex -> www.
    if (url.hostname === 'ricardosanjur.com') {
      url.hostname = 'www.ricardosanjur.com';
      return Response.redirect(url.toString(), 301);
    }

    const method = request.method;
    let path = url.pathname;
    if (path.length > 1 && path.slice(-1) === '/') path = path.replace(/\/+$/, '');

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
    const mAdmin = path.match(/^\/admin\/([A-Za-z0-9_-]{16,})(\/(cliente|plano|revocar|certificado))?$/);
    if (mAdmin) {
      const token = String(env.ADMIN_TOKEN || '');
      if (!token || !constantTimeEqual(mAdmin[1], token)) {
        return new Response('No encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const sub = mAdmin[2];
      if (!sub && method === 'GET') return handleInicio(request, env, mAdmin[1]);
      if (sub === '/cliente' && method === 'POST') return handleCreateClient(request, env, mAdmin[1]);
      if (sub === '/plano' && method === 'POST') return handleUpload(request, env, ctx, mAdmin[1]);
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
      if (email && adminToken) return handleInicio(request, env, adminToken, { salir: true });
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

    return env.ASSETS.fetch(request);
  },
};
