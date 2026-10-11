# Plan — "Mis Planos" (Topografía Especializada S.A.)

## Infra (decidido)
- **D1**: base dedicada `topografia-planos-db` (uuid `6d3a71a3-f89b-449b-8306-db1437bd2ea6`), en la cuenta 66f8699b… .
  - La cuenta estaba en el tope del plan free (10/10 DBs). Se **borró** `eventos-comiboxch-db` (solo la referenciaba `backend_v3_backup`; el backend activo de comibox es `eventos-boxeo-backend-v2`) y se creó esta.
  - **Respaldo** del DB borrado: `backups/eventos-comiboxch-db-20261011.sql` (local) y en R2 `topografia-planos-media/_backups/`.
- **R2**: bucket dedicado `topografia-planos-media`.
- **Worker**: rutas nuevas dentro de `ricardosanjur-web` (mismo deploy).
- **Panel**: contraseña en secreto del Worker (`PANEL_CLAVE`) + `PANEL_SECRET` para firmar cookie.

## Modelo (D1) — creado
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
