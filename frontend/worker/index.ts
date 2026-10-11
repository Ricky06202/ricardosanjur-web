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
}

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

async function handleInicio(request: Request, env: Env): Promise<Response> {
  const guard = await requireSession(request, env);
  if (guard) return guard;

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
        '<td><form method="POST" action="/panel-planos/revocar">' +
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

  const body = '<h1><span>Panel de planos</span></h1>' +
    '<p class="muted">Clientes, planos y descargas.</p>' +
    '<div class="card"><div class="row"><h2>Clientes</h2><span class="pill">' + clients.length + ' registrados</span></div>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Cliente</th><th>#Planos</th><th>#Descargas</th><th>Link del cliente</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="card"><h2>Nuevo cliente</h2><form method="POST" action="/panel-planos/cliente"><div class="grid2">' +
    '<div><label>Nombre</label><input name="nombre" required></div>' +
    '<div><label>Correo</label><input name="correo" type="email"></div>' +
    '<div><label>Telefono</label><input name="telefono"></div>' +
    '</div><p style="margin-top:16px"><button class="btn" type="submit">Crear cliente</button></p></form></div>' +
    '<div class="card"><h2>Subir plano</h2><form method="POST" action="/panel-planos/plano" enctype="multipart/form-data">' +
    '<label>Cliente</label><select name="client_id" required>' + (options || '<option value="">Crea un cliente primero</option>') + '</select>' +
    '<label>Titulo</label><input name="titulo" required>' +
    '<label>Descripcion (opcional)</label><textarea name="descripcion" rows="2"></textarea>' +
    '<label>Archivo (PDF / DWG / ZIP)</label><input type="file" name="archivo" required>' +
    '<p style="margin-top:16px"><button class="btn" type="submit">Subir plano</button></p></form></div>';
  return page('Panel', body, 200);
}

async function handleCreateClient(request: Request, env: Env): Promise<Response> {
  const guard = await requireSession(request, env);
  if (guard) return guard;
  const form = await request.formData();
  const nombre = str(form.get('nombre'));
  if (!nombre) {
    return page('Panel', '<h1><span>Falta el nombre</span></h1><p><a class="btn ghost" href="/panel-planos/inicio">Volver</a></p>', 400);
  }
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, '');
  await env.DB
    .prepare('INSERT INTO clients (id, nombre, correo, telefono, token, activo, creado_en) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .bind(id, nombre, str(form.get('correo')), str(form.get('telefono')), token, new Date().toISOString())
    .run();
  return redirect('/panel-planos/inicio', 303);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const guard = await requireSession(request, env);
  if (guard) return guard;
  const form = await request.formData();
  const clientId = str(form.get('client_id'));
  const titulo = str(form.get('titulo'));
  const file = form.get('archivo');
  if (!clientId || !titulo || !file || typeof file === 'string') {
    return page('Panel', '<h1><span>Datos incompletos</span></h1><p class="muted">Cliente, titulo y archivo son obligatorios.</p><p><a class="btn ghost" href="/panel-planos/inicio">Volver</a></p>', 400);
  }
  const client = await env.DB.prepare('SELECT id FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) {
    return page('Panel', '<h1><span>Cliente no encontrado</span></h1><p><a class="btn ghost" href="/panel-planos/inicio">Volver</a></p>', 400);
  }
  const safeName = sanitizeFileName((file as any).name);
  const key = 'planos/' + clientId + '/' + crypto.randomUUID() + '-' + safeName;
  const mime = (file as any).type || 'application/octet-stream';
  const size = Number((file as any).size) || 0;
  const bytes = await (file as any).arrayBuffer();
  await env.PLANOS.put(key, bytes, { httpMetadata: { contentType: mime } });
  await env.DB
    .prepare('INSERT INTO plans (id, client_id, titulo, descripcion, r2_key, mime, tamano, descargas, creado_en, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)')
    .bind(crypto.randomUUID(), clientId, titulo, str(form.get('descripcion')), key, mime, size, new Date().toISOString())
    .run();
  return redirect('/panel-planos/inicio', 303);
}

async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const guard = await requireSession(request, env);
  if (guard) return guard;
  const form = await request.formData();
  const clientId = str(form.get('client_id'));
  if (clientId) {
    await env.DB
      .prepare('UPDATE clients SET activo = CASE WHEN activo = 1 THEN 0 ELSE 1 END WHERE id = ?')
      .bind(clientId)
      .run();
  }
  return redirect('/panel-planos/inicio', 303);
}

/* ============================ router ============================ */

export default {
  async fetch(
    request: Request & { cf?: { country?: string } },
    env: Env,
  ): Promise<Response> {
    const url = new URL(request.url);
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

    // Panel.
    if (path === '/panel-planos' && method === 'GET') return loginPage('');
    if (path === '/panel-planos/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/panel-planos/inicio' && method === 'GET') return handleInicio(request, env);
    if (path === '/panel-planos/cliente' && method === 'POST') return handleCreateClient(request, env);
    if (path === '/panel-planos/plano' && method === 'POST') return handleUpload(request, env);
    if (path === '/panel-planos/revocar' && method === 'POST') return handleRevoke(request, env);

    return env.ASSETS.fetch(request);
  },
};
