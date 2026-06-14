# Production deploy

Guía corta para publicar OpenWA con Docker Compose, dashboard y API bajo un mismo dominio.

## Quick path

1. Clonar el repositorio en el servidor.
2. Copiar `.env.example` a `.env`.
3. Completar `.env` con valores reales, sin commitear secretos.
4. Levantar el stack:

```bash
docker compose --profile postgres --profile with-dashboard --profile with-proxy up -d --build
```

5. Verificar:

```bash
curl https://app.whatsapp-api.hss.ar/api/health
```

## Configuración HSS esperada

```env
NODE_ENV=production
BASE_URL=https://app.whatsapp-api.hss.ar
DASHBOARD_URL=https://app.whatsapp-api.hss.ar
CORS_ORIGINS=https://app.whatsapp-api.hss.ar

DATABASE_TYPE=postgres
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=openwa
DATABASE_USERNAME=openwa
DATABASE_PASSWORD=CAMBIAR_EN_PRODUCCION
DATABASE_SYNCHRONIZE=false

REDIS_ENABLED=false
ENABLE_SWAGGER=false
API_MASTER_KEY=CAMBIAR_EN_PRODUCCION
```

## Rutas públicas

| Ruta | Servicio |
|---|---|
| `/` | Dashboard |
| `/api/*` | Backend API |
| `/socket.io/*` | WebSocket en tiempo real |

Ejemplos:

```text
https://app.whatsapp-api.hss.ar/api/health
https://app.whatsapp-api.hss.ar/api/sessions
https://app.whatsapp-api.hss.ar/api/sessions/:sessionId/messages
```

## Reverse proxy externo

El `docker-compose.yml` expone Traefik en `127.0.0.1:${DASHBOARD_PORT:-2886}`.

Eso es correcto si Nginx/Cloudflare Tunnel/Caddy corre en el mismo servidor y reenvía:

```text
https://app.whatsapp-api.hss.ar -> http://127.0.0.1:2886
```

Si querés publicar el puerto directamente sin proxy externo, hay que cambiar el binding de Traefik. No lo hagas por impulso: es más seguro mantenerlo local y poner un reverse proxy delante.

## Checklist antes de subir

- [ ] `.env` no está trackeado por git.
- [ ] `API_MASTER_KEY` real solo está en el servidor.
- [ ] `DATABASE_PASSWORD` real solo está en el servidor.
- [ ] `DATABASE_SYNCHRONIZE=false`.
- [ ] `ENABLE_SWAGGER=false`.
- [ ] `CORS_ORIGINS` apunta solo al dominio público.
- [ ] Redis sigue apagado si no se va a usar cola/cache.
- [ ] El volumen `postgres-data` se respalda.
- [ ] El volumen `openwa-data` se respalda porque guarda sesiones de WhatsApp, plugins y media local.

## Comandos útiles

```bash
docker compose ps
docker compose logs -f openwa-api
docker compose logs -f openwa-dashboard
docker compose restart openwa-api
docker compose --profile postgres --profile with-dashboard --profile with-proxy pull
```

No uses esto en producción salvo que quieras borrar datos:

```bash
docker compose down -v
```

`-v` elimina volúmenes como `postgres-data` y `openwa-data`.

## Nota importante sobre historial

Los mensajes se guardan en la tabla `messages` desde que la sesión está activa y el backend los captura. No se importa automáticamente todo el historial viejo de WhatsApp.
