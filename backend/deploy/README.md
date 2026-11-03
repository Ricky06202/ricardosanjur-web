# Servicio privado de ortomosaicos

Este despliegue añade únicamente `/opt/ricardosanjur-mapas`, el proyecto Docker `rsanjur-mapas` y las unidades
`ricardosanjur-mapas-reload.{path,service}`. No comparte volúmenes, nombres de contenedor, DNS ni túneles con
PropTech, Orbit, Cotiza u otros servicios.

## Componentes

- `api`: API Hono interna; valida cada MBTiles con SQLite, guarda el archivo en el volumen persistente y solo lo
  registra en TileServer GL cuando el mapa pasa a publicado.
- `tileserver`: `maptiler/tileserver-gl:v5.7.0`, solo accesible en la red Docker del proyecto y con URL pública fija.
- `tunnel`: `cloudflare/cloudflared:2026.10.7`, conectado al túnel remoto dedicado.
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

El tamaño máximo de subida actual es 90 000 000 bytes (90 MB) por archivo. No hay límite de cantidad en la galería;
archivar un mapa lo oculta y lo descarga de la configuración activa, pero conserva el archivo original.
