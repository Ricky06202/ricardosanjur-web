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

## 2) Acceso con la cuenta RS ID (id.rsanjur.com)

El ingeniero puede entrar al panel con su **cuenta RS ID** sin pegar el token en la URL:

- Va a `https://www.ricardosanjur.com/admin`.
- Si no tiene sesion, ve **"Entrar con mi cuenta rsanjur"** (lo manda a `id.rsanjur.com`).
- Con sesion RS ID **y su correo en la lista blanca**, el panel se abre solo
  (redirige a `/admin/<token>`).
- Sin sesion, o con un correo **no autorizado**, se muestra el login con aviso claro:
  **nunca se filtra el panel**.

El acceso por token (`/admin/<token>`) sigue **intacto** como respaldo: los links
existentes no se rompen. Los **clientes** siguen entrando a sus planos igual
(`/mis-planos/<token>`), sin cambios.

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

### Como valida la sesion

La cookie `rs_id` (firmada por RS ID, `Domain=.rsanjur.com`) se verifica de dos formas:

1. **Con `RS_ID_SESSION_SECRET`** (opcional): se valida la firma HMAC localmente, igual
   que el worker rs-id (mismo esquema `v1.<payload>.<firma>`). Requiere usar EXACTAMENTE
   el mismo secreto del worker `rs-id`.
2. **Sin secreto (por defecto)**: se consulta `GET https://id.rsanjur.com/api/auth/yo`
   reenviando la cookie; si responde `autenticado: true`, se toma su `email`.

Con el metodo 2 no hay que compartir secretos. Solo se lee el correo; la sesion de RS ID
no se toca.

## Verificacion local (opcional)

```sh
npx --yes wrangler@4 dev --port 8787 \
  --var ADMIN_TOKEN:<token-de-prueba-16+> \
  --var ADMIN_EMAILS:<correo-autorizado> \
  --var RS_ID_SESSION_SECRET:<secreto-de-prueba>
```

Con la cookie `rs_id` firmada con ese secreto y un correo de la lista, `/admin` redirige
al panel; sin cookie o con correo no autorizado, muestra el login.
