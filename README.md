# Deploy Docker CLI

Una herramienta de línea de comandos para desplegar aplicaciones Node.js en contenedores Docker, tanto en un entorno local como en servidores remotos vía SSH.

## Características

- Despliegue local y remoto.
- Configuración a través de archivos JSON.
- Soporte para variables de entorno desde archivos `.env` y objetos JSON.
- Transferencia de archivos segura y automatizada vía SSH.
- Control total sobre los parámetros de `docker run` (recursos, red, etc.).

## Instalación

```bash
npm install -g @octavio.cubillos/deploy-docker
