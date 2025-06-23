# Herramienta de Despliegue Docker (deploy-docker)

![Versión](https://img.shields.io/badge/version-1.0.3-blue.svg)
![Licencia](https://img.shields.io/npm/l/@octavio.cubillos/deploy-docker)

**Deploy-docker** es una herramienta de línea de comandos (CLI) potente y flexible diseñada para automatizar y estandarizar el despliegue de aplicaciones en contenedores Docker. Permite gestionar el ciclo de vida completo de tus despliegues, desde entornos locales de desarrollo hasta servidores remotos de producción, con un único archivo de configuración.

Soporta despliegues de **Node.js** y sitios **estáticos (HTML/CSS/JS) con Nginx**, gestión de versiones, rotación de despliegues antiguos y un sistema de configuración robusto basado en archivos JSON.

---

## Características Principales

* **Despliegue Multi-Entorno**: Despliega en tu máquina local o en servidores remotos vía SSH.
* **Soporte para Múltiples Tipos de Aplicación**: Despliega servicios de Node.js o sitios web estáticos con Nginx de forma nativa.
* **Gestión de Versiones**: Cada despliegue es versionado, permitiendo un control granular y evitando colisiones.
* **Rotación Automática**: Limpia automáticamente las versiones más antiguas, manteniendo tu servidor ordenado y liberando espacio.
* **Configuración Declarativa**: Define toda tu infraestructura y configuración en un simple archivo JSON.
* **Validaciones de Seguridad para Producción**: Evita el re-despliegue de la misma versión o el despliegue de versiones más antiguas en entornos de producción.
* **Flexibilidad Avanzada**: Control total sobre los parámetros de Docker, variables de entorno, redes, volúmenes y más.
* **Automatización Inteligente**: Crea redes y volúmenes si no existen, y optimiza el `package.json` para producción.

---

## Instalación

Puedes instalar la herramienta globalmente para uso general o localmente como una dependencia de desarrollo para mayor consistencia en equipos. La versión actual es **1.0.3**.

**Global:**
```bash
npm install -g @octavio.cubillos/deploy-docker@1.0.3
```

**Local:**
```bash
npm install @octavio.cubillos/deploy-docker@1.0.3 --save-dev
```

---

## Uso Básico

El comando se ejecuta apuntando a un archivo de configuración `.json` que define el despliegue.

**Si está instalado globalmente:**
```bash
deploy-docker --file=ruta/a/tu/config.json
```

**Si está instalado localmente, úsalo a través de los scripts de `package.json`:**
```json
// package.json
"scripts": {
  "deploy:prod": "deploy-docker --file=prod.deploy.json"
}
```
Y luego ejecuta:
```bash
npm run deploy:prod
```

### Flags de Línea de Comandos

* `--file=<ruta>`: **(Obligatorio)** Ruta al archivo de configuración.
* `-f, --force`: **(Opcional)** Anula las validaciones de producción y fuerza un despliegue de la misma versión. **No elimina datos**, sino que renombra el contenedor antiguo como un backup.
* `--rm`: **(Opcional)** La opción "destructiva". Elimina por completo el contenedor y el volumen de la versión que estás intentando desplegar antes de crear uno nuevo. Ideal para un inicio limpio.
* `-h, --help`: Muestra el mensaje de ayuda.

---

## El Archivo de Configuración (`.deploy.json`)

Este archivo es el corazón de la herramienta. A continuación, se muestra una referencia completa de todas las opciones disponibles.

### Referencia Completa

| Clave | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `name` | string | **Sí** | El nombre base de tu aplicación. |
| `version` | string | **Sí** | La versión semántica del despliegue (ej. "1.2.3"). |
| `port` | number | **Sí** | Puerto en el host que se mapeará al puerto del contenedor. |
| `deployType` | string | No | El tipo de aplicación. Opciones: `"node"` (defecto), `"static"`. |
| `main` | string | No | Archivo de entrada de la app. Defecto: `index.js` (para node) o `index.html` (para static). |
| `buildDir` | string | No | Carpeta local con los archivos compilados. Defecto: `"build"`. |
| `keepVersions` | number | No | Número de versiones antiguas a conservar. Defecto: 4. |
| `customCommand` | string | No | **(Solo para Node)** Comando personalizado para iniciar la app (ej. `pm2-runtime start`). |
| `envFile` | string | No | Ruta a un archivo `.env` local para cargar variables de entorno. |
| `env` | object | No | Un objeto para definir o sobrescribir variables de entorno. |
| `remote` | object | No | Si esta clave existe, activa el despliegue remoto. |
| `remote.host` | string | **Sí** | IP o dominio del servidor remoto. |
| `remote.user` | string | **Sí** | Usuario para la conexión SSH. |
| `remote.path` | string | No | Ruta base en el servidor para los despliegues. Defecto: `~/apps/<name>`. |
| `remote.privateKeyPath`| string | Sí (o `password`) | Ruta a tu clave SSH privada local. |
| `remote.password` | string | Sí (o `privateKeyPath`) | Contraseña para la conexión SSH (menos seguro). |
| `dockerOptions` | object | No | Objeto para pasar parámetros avanzados a `docker run`. |
| `dockerOptions.user`| string | No | Usuario para ejecutar el proceso dentro del contenedor (ej. "node"). |
| `dockerOptions.restart`| string | No | Política de reinicio (ej. "unless-stopped"). |
| `dockerOptions.cpus` | string | No | Límite de CPU (ej. "0.5"). |
| `dockerOptions.memory`| string | No | Límite de memoria (ej. "512m"). |
| `dockerOptions.hostname`| string | No | Nombre de host del contenedor. |
| `dockerOptions.networks`| array | No | Lista de redes Docker a las que conectar. |
| `dockerOptions.labels`| array | No | Lista de etiquetas para el contenedor. |

---

## Ejemplos de Configuración

### 1. Ejemplos Mínimos (Solo Campos Obligatorios)

Estos ejemplos muestran cómo desplegar con la menor configuración posible, confiando en los valores por defecto de la herramienta.

**Despliegue Mínimo de Node.js (Local):**
```json
{
  "name": "mi-app-simple",
  "version": "1.0.0",
  "port": 3000
}
```
*La herramienta asumirá `deployType: "node"`, `buildDir: "build"`, `main: "index.js"`, etc.*

**Despliegue Mínimo Estático (Remoto):**
```json
{
  "name": "mi-landing-simple",
  "version": "1.0.0",
  "deployType": "static",
  "port": 8080,
  "remote": {
    "host": "IP_O_DOMINIO_DEL_SERVIDOR",
    "user": "usuario",
    "privateKeyPath": "~/.ssh/id_rsa"
  }
}
```
*La herramienta asumirá `buildDir: "build"`, `main: "index.html"`, usará la imagen de Nginx por defecto y generará la ruta remota automáticamente.*

### 2. Ejemplos Completos

Estos ejemplos muestran configuraciones más realistas y detalladas.

**Despliegue Remoto de Producción (Node.js con PM2):**
```json
{
  "name": "backend-principal",
  "version": "1.5.2",
  "deployType": "node",
  "main": "server.js",
  "port": 80,
  "keepVersions": 5,
  "customCommand": "pm2-runtime start server.js --name backend-principal",
  "remote": {
    "host": "198.51.100.10",
    "user": "deployer",
    "privateKeyPath": "~/.ssh/id_rsa_prod"
  },
  "dockerOptions": {
    "user": "node",
    "restart": "unless-stopped",
    "memory": "1g",
    "networks": ["backend-net"]
  },
  "envFile": ".env.prod",
  "env": {
    "NODE_ENV": "production"
  }
}
```

**Despliegue Remoto de un Sitio Estático (HTML/CSS/JS):**
```json
{
  "name": "pagina-web-principal",
  "version": "2.0.1",
  "deployType": "static",
  "buildDir": "public",
  "port": 8080,
  "remote": {
    "host": "198.51.100.20",
    "user": "deployer",
    "password": "mi_password_segura"
  },
  "dockerOptions": {
    "restart": "unless-stopped",
    "labels": [
      "traefik.enable=true",
      "traefik.http.routers.landing.rule=Host(`www.miempresa.com`)"
    ]
  }
}
```

---

## Prerrequisitos

- **Máquina Local**: Node.js y NPM instalados.
- **Servidor Remoto**: Docker instalado y el servicio en ejecución. Acceso SSH configurado (por clave o contraseña).

---

## Licencia

Este proyecto está bajo la Licencia MIT.
