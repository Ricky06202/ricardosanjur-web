# Plan — "Mis Planos" (Topografía Especializada S.A.)

## Infra (decidido)
- **D1**: se reutiliza `eventos-comiboxch-db` (uuid `05166ffb-f486-4407-b16d-5989655f2280`).
  - Solo lo referencia \`backend_v3_backup\` en el repo de comibox (el backend ACTIVO usa `eventos-boxeo-backend-v2`).
  - Se agregan tablas NUEVAS; no se toca nada existente.
  - Motivo: la cuenta está en el tope del plan free (10/10 DBs) → no se puede crear una nueva.
- **R2**: bucket dedicado `topografia-planos-media` (para los PDF/DWG/ZIP).
- **Worker**: rutas nuevas dentro de `ricardosanjur-web` (mismo deploy).
- **Panel**: protegido por contraseña en secreto del Worker (`PANEL_CLAVE`).

## Modelo (D1)
- `clients`: id, nombre, correo, telefono, **token**, activo, creado_en
- `plans`: id, client_id, titulo, descripcion, r2_key, mime, tamano, descargas, ultima_descarga, creado_en
- `downloads`: id, plan_id, client_id, fecha
- índices: `plans(client_id)`, `clients(token)`

## Rutas
- `GET /mis-planos/:token` → lista de planos del cliente
- `GET /mis-planos/:token/plano/:id` → descarga desde R2 + registra en downloads
- `GET /panel-planos` (login) · `POST /panel-planos/login`
- `GET /panel-planos/inicio` → clientes + subir plano
- `POST /panel-planos/cliente` · `POST /panel-planos/plano` · `POST /panel-planos/revocar`

## Fases
- **F0** · DB + migración + bucket — *(hecho)*
- **F1** · Worker: acceso por token, listado y descarga con log — *~1-2 h*
- **F2** · Página del cliente `/mis-planos/:token` — *~1 h*
- **F3** · Panel del papá: login, alta de cliente, subir plano, link + WhatsApp — *~2 h*
- **F4** · Pulido: i18n ES/EN, `noindex`, pruebas — *~1 h*

## Notas
- `/mis-planos` y `/panel-planos` llevan `noindex` (no deben aparecer en Google).
- Link del cliente: `ricardosanjur.com/mis-planos/<token>`.
