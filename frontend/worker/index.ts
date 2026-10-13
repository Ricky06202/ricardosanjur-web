// Cloudflare Worker: redirect por pais en "/" + area privada "Mis Planos".
// Bindings: ASSETS (sitio estatico), DB (D1: clients/plans/downloads), PLANOS (R2).
// Secretos: PANEL_CLAVE (contrasena del panel), PANEL_SECRET (firma de cookie).
// Solo usa las tablas clients, plans y downloads de la D1 compartida.

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  DB: any;
  PLANOS: any;
  PANEL_CLAVE?: string;
  PANEL_SECRET?: string;
  ADMIN_TOKEN?: string;
  LEADS_WEBHOOK?: string;
}

// Contexto del worker (para ctx.waitUntil en avisos best-effort).
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

/* ====================== avisos a Discord (LEADS) ====================== */
// Best-effort: si LEADS_WEBHOOK falta o Discord falla, el sitio funciona igual.
// Nunca se envia telefono, cedula ni correo completo.

function nombreParcial(nombre: unknown): string {
  const partes = String(nombre == null ? '' : nombre).trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return 'Cliente';
  if (partes.length === 1) return partes[0];
  return partes[0] + ' ' + partes[1].charAt(0).toUpperCase() + '.';
}

function extracto(texto: unknown, max: number): string {
  const s = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

async function avisarLeads(env: Env, texto: string): Promise<void> {
  const url = env.LEADS_WEBHOOK || '';
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(texto).slice(0, 1900) }),
    });
    console.log('[leads] aviso HTTP ' + res.status);
  } catch (e) {
    console.log('[leads] error: ' + String((e as any) && (e as any).message || e));
  }
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

  const aviso = '📩 Nuevo contacto — ' + nombreParcial(nombre) +
    ' · ' + (tema || 'sin tema') + ' · ' + extracto(mensaje, 120);
  ctx.waitUntil(avisarLeads(env, aviso));
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

async function handleInicio(request: Request, env: Env, tok: string): Promise<Response> {
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

  const body = '<h1><span>Admin de planos</span></h1>' +
    '<p class="muted">Clientes, planos y descargas.</p>' +
    '<div class="card"><div class="row"><h2>Clientes</h2><span class="pill">' + clients.length + ' registrados</span></div>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Cliente</th><th>#Planos</th><th>#Descargas</th><th>Link del cliente</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="card"><h2>Nuevo cliente</h2><form method="POST" action="/admin/' + tok + '/cliente"><div class="grid2">' +
    '<div><label>Nombre</label><input name="nombre" required></div>' +
    '<div><label>Correo</label><input name="correo" type="email"></div>' +
    '<div><label>Telefono</label><input name="telefono"></div>' +
    '</div><p style="margin-top:16px"><button class="btn" type="submit">Crear cliente</button></p></form></div>' +
    '<div class="card"><h2>Subir planos</h2>' +
    '<p class="muted" style="margin-top:-6px">Puedes elegir varios archivos a la vez.</p>' +
    '<form method="POST" action="/admin/' + tok + '/plano" enctype="multipart/form-data">' +
    '<label>Cliente</label><select name="client_id" required>' + (options || '<option value="">Crea un cliente primero</option>') + '</select>' +
    '<label>Titulo (opcional: si lo dejas vacio se usa el nombre del archivo)</label><input name="titulo">' +
    '<label>Descripcion (opcional)</label><textarea name="descripcion" rows="2"></textarea>' +
    '<label>Archivos (PDF / DWG / ZIP - selecciona varios con Ctrl o manteniendo)</label><input type="file" name="archivos" multiple required>' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Subir archivos</button></p></form></div>';
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
  let subidos = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const safeName = sanitizeFileName(file.name);
    const key = 'planos/' + clientId + '/' + crypto.randomUUID() + '-' + safeName;
    const mime = file.type || 'application/octet-stream';
    const size = Number(file.size) || 0;
    const bytes = await file.arrayBuffer();
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
  }
  if (subidos > 0) {
    const aviso = '📐 Nuevo plano subido — ' + nombreParcial(client.nombre) +
      ' · ' + subidos + ' archivo(s)' + (descripcion ? ' · ' + extracto(descripcion, 80) : '');
    ctx.waitUntil(avisarLeads(env, aviso));
  }
  return redirect(back + '?subidos=' + subidos, 303);
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
    const mAdmin = path.match(/^\/admin\/([A-Za-z0-9_-]{16,})(\/(cliente|plano|revocar))?$/);
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
    }

    // Formulario de contacto del sitio (antes devolvia 405 y se perdian los mensajes).
    if (path === '/api/contact') {
      if (method === 'POST') return handleContact(request, env, ctx);
      return jsonResponse({ ok: false, error: 'method' }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
