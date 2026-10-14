# Subir plano + certificado (un solo paso) y acceso con RS ID

## 1) Subir plano y emitir certificado en la MISMA accion

Antes eran dos pasos (subir el plano / emitir el certificado aparte). Ahora, en el
panel del ingeniero (`/admin/<token>`), el formulario **"Subir plano y emitir
certificado"** hace todo de una vez:

1. Sube el archivo a R2 y lo asigna al cliente (tabla `plans`).
2. Calcula la huella **SHA-256** del archivo.
3. **Crea la fila del certificado automaticamente** (tabla `certificados`) con el
   nombre del documento, el cliente/descripcion, la fecha y el emisor.

Al guardar, la **misma pantalla** muestra el resultado: confirmacion, la huella, el
link publico `/certificado/<id>`, el **boton de copiar** y el **QR**. No hay segunda
pantalla ni segundo paso.

**Si el archivo ya estaba certificado** (misma huella SHA-256): NO se duplica. Se
avisa en el resultado ("Ya tenia certificado (misma huella). No se duplico.") y se
muestra el certificado vigente con su link y QR.

La opcion **"Certificar un archivo sin subirlo (opcional)"** se mantiene como via
secundaria (para certificar un archivo que no se sube al portal), pero dejo de ser el
camino normal.

## 2) Acceso con la cuenta RS ID (id.rsanjur.com) - SSO cross-domain

**Problema de raiz:** `ricardosanjur.com` **NO es subdominio de `rsanjur.com`**
(son dos dominios registrables distintos). La cookie de sesion de RS ID se emite con
`Domain=.rsanjur.com`, asi que el navegador **nunca la manda** a
`ricardosanjur.com`. Por eso el acceso no puede depender de esa cookie: se usa un
**codigo de un solo uso** que viaja en la URL de vuelta.

Flujo:

1. El ingeniero va a `https://www.ricardosanjur.com/admin`.
2. Sin sesion, ve **"Entrar con mi cuenta rsanjur"**, que enlaza a
   `https://id.rsanjur.com/id?volver=<https://www.ricardosanjur.com/admin/entrar>`.
3. En RS ID entra con su correo + codigo de 6 digitos (o Google). Si ya tenia sesion
   RS ID, el RS ID lo devuelve de una.
4. RS ID emite un **codigo de un solo uso** (TTL 60 s, guardado hasheado en D1, atado
   al **origen** de vuelta) y redirige a `/admin/entrar?rsid=<codigo>`.
5. `/admin/entrar` (server-side) canjea el codigo llamando a
   `POST https://id.rsanjur.com/api/auth/canjear` con el secreto de app. Si el correo
   esta en `ADMIN_EMAILS`, emite la **cookie propia del panel** (`admin_sesion`,
   `Domain=.ricardosanjur.com`, firmada con `ADMIN_SESSION_SECRET`) y abre el panel.
   Correo no autorizado: **401**. Codigo invalido/usado/expirado: vuelve al login con
   aviso.

Seguridad del canje (`/api/auth/canjear`):

- Exige el **secreto compartido de app** (cabecera `X-RSID-App-Secret =
  RS_ID_CANJE_SECRET`); sin el, responde `403`.
- El codigo es de **un solo uso**, **expira en 60 s** y esta **atado al origen**
  (campo `origen`): un codigo de otro sitio no sirve.
- Devuelve lo minimo: `{ok, email, cuenta_id}`. Nunca la wallet ni datos de mas.
- `volver` solo acepta dominios de la lista blanca (`*.rsanjur.com`,
  `*.ricardosanjur.com`, `*.strydpanama.com`, `comiboxchiriqui.com`,
  `*.workers.dev`, `localhost`). Si no esta en la lista, se **ignora** (nunca se
  redirige a un sitio arbitrario).

El acceso por token (`/admin/<token>`) sigue **intacto** como respaldo: los links
existentes no se rompen. Los **clientes** siguen entrando a sus planos igual
(`/mis-planos/<token>`), sin cambios. El panel muestra un enlace **Cerrar sesion**
(`/admin/salir`) cuando se entro con la sesion propia.

### Lista blanca de correos (ADMIN_EMAILS)

Es configurable por var/secret (separada por comas). Si esta **vacia, nadie entra**
(la pantalla avisa que falta configurarla):

```sh
cd frontend
npx --yes wrangler@4 secret put ADMIN_EMAILS
# pegar, por ejemplo:  correo1@dominio.com,correo2@dominio.com
```

Alternativa como var (no secreta) en `wrangler.jsonc`:
`"vars": { "ADMIN_EMAILS": "correo1@dominio.com,correo2@dominio.com" }`.

Para agregar el correo del ingeniero, basta volver a correr `secret put` con la lista
completa (el correo del dueno + el del ingeniero).

### Secretos del worker (los nuevos)

| Secret | Para que |
|---|---|
| `RS_ID_CANJE_SECRET` | secreto compartido con el worker `rs-id` para llamar a `/api/auth/canjear` |
| `ADMIN_SESSION_SECRET` | firma de la cookie propia `admin_sesion` (si falta, usa `PANEL_SECRET`) |

### Como valida la sesion

1. **Cookie propia `admin_sesion`** (la via normal): firmada con
   `ADMIN_SESSION_SECRET` y con `Domain=.ricardosanjur.com`, asi que **si viaja**
   dentro de este dominio. Es la que emite `/admin/entrar`.
2. **Compatibilidad**: si no hay cookie propia, se mira la cookie `rs_id` (validandola
   localmente con `RS_ID_SESSION_SECRET` o consultando `GET /api/auth/yo`). Esta via
   solo sirve dentro de `*.rsanjur.com`; para dominios externos aplica el SSO.

## Verificacion local (opcional)

```sh
npx --yes wrangler@4 dev --port 8787 \
  --var ADMIN_TOKEN:<token-de-prueba-16+> \
  --var ADMIN_EMAILS:<correo-autorizado> \
  --var RS_ID_SESSION_SECRET:<secreto-de-prueba>
```

Con la cookie `rs_id` firmada con ese secreto y un correo de la lista, `/admin` redirige
al panel; sin cookie o con correo no autorizado, muestra el login.
