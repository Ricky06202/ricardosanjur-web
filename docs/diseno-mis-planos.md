# Mis Planos — diseño (v0)

Sistema para que los clientes de **Topografía Especializada S.A.** vean y descarguen sus planos, **sin contraseñas**.

## Idea
Tu papá sube un plano, lo asigna a un cliente, y le manda por **WhatsApp un link personal**. El cliente abre el link y ve SOLO sus planos.

## Modelo de datos (D1)
- **clients**: id, nombre, correo (opcional), telefono (opcional), token (del link), activo, creado_en
- **plans**: id, client_id, titulo, descripcion, r2_key, tamano, mime, creado_en, descargas, ultima_descarga
- **downloads** (log): id, plan_id, client_id, fecha
- **admin**: contraseña en secreto del Worker (o Cloudflare Access)

## Rutas
- GET /mis-planos/:token → página del cliente con SUS planos
- GET /mis-planos/:token/plano/:id → descarga desde R2 + registra
- GET /panel-planos → login (contraseña)
- GET /panel-planos/inicio → clientes + subir plano
- POST /panel-planos/cliente → crear cliente (genera token)
- POST /panel-planos/plano → subir a R2 + asignar a cliente

## Flujo
1. Papá crea cliente → copia / reenvía el link por WhatsApp
2. Cliente abre el link → ve sus planos → descarga
3. Papá ve quién bajó qué y puede revocar el acceso

## Stack
Cloudflare Workers + D1 + R2. Cliente sin contraseña; panel protegido por contraseña.
