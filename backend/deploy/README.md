# Servicio privado de ortomosaicos

Este instalador mantiene únicamente `/opt/ricardosanjur-mapas` y las unidades
`ricardosanjur-mapas-reload.{path,service}`. El conversor CAD es un proyecto Compose independiente, documentado en
`backend/cad-converter/README.md`; comparte solo la red Docker privada necesaria para que Hono lo alcance y tiene un
instalador separado para que las actualizaciones CAD no reinicien TileServer ni interactúen con MBTiles.

## Componentes

- `api`: API Hono interna; valida cada MBTiles con SQLite, guarda el archivo en el volumen persistente y solo lo
  registra en TileServer GL cuando el mapa pasa a publicado.
- `tileserver`: `maptiler/tileserver-gl:v5.7.0`, solo accesible en la red Docker del proyecto y con URL pública fija.
- `tunnel`: `cloudflare/cloudflared:2026.10.7`, conectado al túnel remoto dedicado.
- `cad-converter-api`: FastAPI + GDAL/LibreDWG/Poppler en el proyecto Compose separado `cad-converter`. No publica
  puertos del host; solo se llama mediante Hono (`/internal/cad/*`) después de validar el secreto del Worker.
- systemd observa `data/config.json` y manda `SIGHUP` exclusivamente al contenedor `rsanjur-mapas-tileserver`.
  `SIGHUP` hace que TileServer GL recargue el catálogo sin exponer el Docker socket al API.

## Secretos (fuera de Git)

Crear, mediante el canal de provisión autorizado, estos archivos en `/opt/ricardosanjur-mapas/secrets/`:

- `maps-backend-secret`: al menos 32 bytes aleatorios; el mismo valor debe configurarse como secreto Worker
  `MAPAS_BACKEND_SECRET`.
- `cloudflare-tunnel-token`: token del túnel `ricardosanjur-ortomosaicos`.

Permisos recomendados en el host: directorio `0700 root:root`, archivos `0600 root:root` antes de arrancar el
instalador. El instalador cambia los archivos a `0444` dentro de ese directorio solo para que los usuarios no root
de los contenedores puedan leerlos; el directorio padre continúa siendo inaccesible desde el host para otros usuarios.
No subirlos a Git, no pegarlos en los logs y no incluirlos en un comando visible.

## Primera instalación y actualizaciones

Copiar `backend/` de este repositorio a `/opt/ricardosanjur-mapas/app/` **sin reemplazar** `data/` ni `secrets/`.
Luego ejecutar como root:

```bash
bash /opt/ricardosanjur-mapas/app/deploy/install-vps.sh
```

El instalador conserva cualquier `config.json` ya existente y nunca ejecuta `docker compose down`, borra volúmenes
ni elimina archivos MBTiles. Comprueba los contenedores con:

```bash
docker compose --project-directory /opt/ricardosanjur-mapas -f /opt/ricardosanjur-mapas/compose.yaml ps
systemctl status ricardosanjur-mapas-reload.path
```

El instalador de esta sección solo administra el stack de mapas existente. Para desplegar o actualizar el conversor,
ejecute **por separado**:

```bash
bash /opt/ricardosanjur-mapas/app/cad-converter/install-vps.sh
```

Ese instalador solo levanta/actualiza `cad-converter-api`, crea sus directorios privados con UID `10001` y exige que
ya exista la red `rsanjur-mapas_mapas`; no ejecuta Compose en el proyecto de mapas. **No agregar `ports:`, no abrir
el 8090 en el host ni enrutarlo desde Nginx Proxy Manager**: Cotiza ya usa ese puerto y la aplicación debe llegar
por el proxy interno autenticado. Los originales y exportaciones se guardan fuera del directorio de MBTiles. Los
ZIP se validan antes de extraer; no se usa `chmod 777`.

El Worker muestra las herramientas CAD/GIS únicamente a una sesión administrativa RS ID autorizada. Las capas
GeoJSON quedan privadas y se dibujan sobre el visor; no se publican automáticamente. El servicio limita entradas y
salidas a 90 MB, los PDF a 40 páginas y las imágenes a 150/300 DPI. Consulte `backend/cad-converter/README.md` para
formatos, verificación y limitaciones de LibreDWG.

El tamaño máximo de subida actual es 90 000 000 bytes (90 MB) por archivo. No hay límite de cantidad en la galería;
archivar un mapa lo oculta y lo descarga de la configuración activa, pero conserva el archivo original. El panel
permite eliminar permanentemente solo mapas archivados: borra la ficha de D1 y el MBTiles del VPS; el API rechaza
el borrado si el mapa todavía figura activo en TileServer.
