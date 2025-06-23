#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const { NodeSSH } = require('node-ssh');
const semver = require('semver');
const args = require('minimist')(process.argv.slice(2));

// --- Lógica Principal ---
async function main() {
    const forceDeploy = args.force || args.f || false;
    const recreateDeploy = args.rm || false;

    if (args.help || args.h) {
        showHelp();
        process.exit(0);
    }
    
    const configFile = args.file;
    if (!configFile) {
        console.error('\x1b[31mError: Debes especificar un archivo de configuración con --file=ruta/al/archivo.json\x1b[0m');
        console.log('Usa --help para más información.');
        process.exit(1);
    }

    const config = loadConfig(configFile);
    if (!config.version) {
        console.error(`\x1b[31mError: El campo 'version' es obligatorio en el archivo de configuración.\x1b[0m`);
        process.exit(1);
    }

    if (config.remote) {
        await deployRemote(config, forceDeploy, recreateDeploy);
    } else {
        await deployLocal(config, forceDeploy, recreateDeploy);
    }
}

// --- Flujos de Despliegue ---
async function deployLocal(config, force = false, recreate = false) {
    console.log(`🚀 Iniciando despliegue LOCAL para tipo '${config.deployType}'...`);
    const { name: baseName, version, port, buildDir, main: entrypoint } = config;
    const finalContainerName = `${baseName}-${version}`;
    const finalVolumeName = `${baseName}-data-${version}`;
    config.name = finalContainerName;
    config.volume = finalVolumeName;

    const buildPackageJsonPath = path.join(buildDir, 'package.json');
    let packageJsonWasCreated = false;

    try {
        await checkProductionVersion(config, force, recreate);

        if (recreate) {
            console.log(`\x1b[33m--rm flag detectado. Eliminando completamente la versión ${version}...\x1b[0m`);
            run(`docker stop ${finalContainerName} 2>/dev/null || true`);
            run(`docker rm ${finalContainerName} 2>/dev/null || true`);
            run(`docker volume rm ${finalVolumeName} 2>/dev/null || true`);
            console.log(' -> Limpieza completa finalizada.');
        } else if (force) {
            console.log(`\x1b[33m--force flag detectado. Archivando versión existente ${version}...\x1b[0m`);
            const oldContainer = run(`docker ps -a -q -f name=^${finalContainerName}$`);
            if (oldContainer) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const archiveName = `${finalContainerName}-old-${timestamp}`;
                console.log(` -> Renombrando contenedor '${finalContainerName}' a '${archiveName}'...`);
                run(`docker stop ${finalContainerName}`);
                run(`docker rename ${finalContainerName} ${archiveName}`);
                console.log(`\x1b[33m   -> Nota: El volumen antiguo '${finalVolumeName}' no se puede renombrar y queda disponible para recuperación manual.\x1b[0m`);
            }
        }
        
        const checkFile = config.deployType === 'static' ? 'index.html' : entrypoint;
        if (!fs.existsSync(buildDir) || !fs.existsSync(path.join(buildDir, checkFile))) {
            console.error(`\x1b[31mError: La carpeta '${buildDir}' o su archivo principal '${checkFile}' no existen.\x1b[0m`);
            process.exit(1);
        }

        await stopAllOtherVersions(baseName, finalContainerName);
        await ensureVolumeExists(finalVolumeName);
        if (config.dockerOptions && config.dockerOptions.networks) {
            await ensureNetworksExist(config.dockerOptions.networks);
        }
        
        const { finalEnv } = buildEnvironment(config);
        if (config.deployType === 'node') {
            performTokenReplacement(config, finalEnv);
            console.log(`- Limpiando y preparando package.json para producción...`);
            const cleanPackageJsonContent = createCleanPackageJson(config);
            fs.writeFileSync(buildPackageJsonPath, cleanPackageJsonContent);
            packageJsonWasCreated = true;
        }
        
        const volumeHasCode = run(`docker run --rm -v "${finalVolumeName}:/app" alpine ls /app/${checkFile} 2>/dev/null || true`).includes(checkFile);
        if (!volumeHasCode) {
            console.log("-> El volumen está vacío. Copiando código...");
            run(`docker run --rm -v "${path.resolve(buildDir)}:/origen" -v "${finalVolumeName}:/destino" alpine sh -c "cp -a /origen/. /destino/"`);
        } else {
            console.log("-> El volumen ya contiene código. Saltando copia.");
        }
        
        const finalCommand = buildDockerCommand(config).join(' ');
        console.log('▶️  Lanzando el nuevo contenedor...');
        run(finalCommand);
        
        console.log(`\n✅ Lanzamiento de ${finalContainerName} exitoso.`);
        await pruneOldVersions(config);
        console.log(`\n🎉 ¡Éxito! El servicio '${finalContainerName}' está en ejecución localmente.`);
        console.log(`   URL: http://localhost:${port}`);

    } catch (error) {
        console.error(`\x1b[31m${error.message}\x1b[0m`);
        process.exit(1);
    } finally {
        if (packageJsonWasCreated) {
            fs.unlinkSync(buildPackageJsonPath);
        }
    }
}

async function deployRemote(config, force = false, recreate = false) {
    console.log(`🚀 Iniciando despliegue REMOTO para tipo '${config.deployType}' a '${config.remote.host}'...`);
    const { name: baseName, version, remote, buildDir, main: entrypoint } = config;
    const remoteBasePath = remote.path || `~/apps/${baseName}`;
    const finalContainerName = `${baseName}-${version}`;
    const finalVolumeName = `${baseName}-data-${version}`;
    config.name = finalContainerName;
    config.volume = finalVolumeName;

    const ssh = new NodeSSH();
    const archiveName = 'deploy.tar.gz';
    const buildPackageJsonPath = path.join(buildDir, 'package.json');
    let packageJsonWasCreated = false;
    let remoteEnvPath = null;

    try {
        const connectionConfig = { host: remote.host, username: remote.user };
        if (remote.privateKeyPath) { connectionConfig.privateKeyPath = remote.privateKeyPath; } 
        else if (remote.password) { connectionConfig.password = remote.password; } 
        else { throw new Error('Debe proporcionar "privateKeyPath" o "password".'); }
        await ssh.connect(connectionConfig);

        await checkProductionVersion(config, force, recreate, ssh);
        
        if (recreate) {
            console.log(`\x1b[33m--rm flag detectado. Eliminando completamente la versión ${version} en el servidor remoto...\x1b[0m`);
            await ssh.execCommand(`docker stop ${finalContainerName} && docker rm ${finalContainerName}`, { onStderr: () => {} });
            await ssh.execCommand(`docker volume rm ${finalVolumeName}`, { onStderr: () => {} });
        } else if (force) {
            console.log(`\x1b[33m--force flag detectado. Archivando versión existente ${version} en el servidor remoto...\x1b[0m`);
            const { stdout: oldContainer } = await ssh.execCommand(`docker ps -a -q -f name=^${finalContainerName}$`);
            if (oldContainer) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const archiveName = `${finalContainerName}-old-${timestamp}`;
                await ssh.execCommand(`docker stop ${finalContainerName} && docker rename ${finalContainerName} ${archiveName}`);
                console.log(`\x1b[33m   -> Contenedor renombrado a '${archiveName}'. El volumen antiguo '${finalVolumeName}' queda disponible.\x1b[0m`);
            }
        }
        
        await stopAllOtherVersions(baseName, finalContainerName, ssh);
        await ensureVolumeExists(finalVolumeName, ssh);
        if (config.dockerOptions.networks) await ensureNetworksExist(config.dockerOptions.networks, ssh);

        const { finalEnv, finalEnvContent } = buildEnvironment(config);
        if (config.deployType === 'node') {
            performTokenReplacement(config, finalEnv);
            console.log(`- Limpiando y preparando package.json para producción...`);
            const cleanPackageJsonContent = createCleanPackageJson(config);
            fs.writeFileSync(buildPackageJsonPath, cleanPackageJsonContent);
            packageJsonWasCreated = true;
        }
        
        const { stdout: volumeHasCode } = await ssh.execCommand(`docker run --rm -v "${finalVolumeName}:/app" alpine ls /app/${entrypoint} 2>/dev/null`);
        if (!volumeHasCode.includes(entrypoint)) {
            console.log("-> El volumen remoto está vacío. Subiendo código...");
            await compressDirectory(buildDir, archiveName);
            const remoteTempDir = `/tmp/deploy-${Date.now()}`;
            await ssh.execCommand(`mkdir -p ${remoteTempDir}`);
            await ssh.putFile(path.resolve(archiveName), `${remoteTempDir}/${archiveName}`);
            await ssh.execCommand(`tar -xzf ${archiveName} -C ${remoteTempDir}`, { cwd: remoteTempDir });
            const copyToVolumeCmd = `docker run --rm -v "${remoteTempDir}:/origen" -v "${finalVolumeName}:/destino" alpine sh -c "cp -a /origen/. /destino/"`;
            await ssh.execCommand(copyToVolumeCmd);
            await ssh.execCommand(`rm -rf ${remoteTempDir}`);
        } else {
            console.log("-> El volumen remoto ya contiene código. Saltando subida.");
        }
        
        if (finalEnvContent && config.deployType === 'node') {
            remoteEnvPath = `${remoteBasePath}/.env.deploy.tmp`;
            console.log(`🔒 Escribiendo variables de entorno en el servidor: ${remoteEnvPath}`);
            const escapedContent = finalEnvContent.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            await ssh.execCommand(`cat <<'EOF' > ${remoteEnvPath}\n${escapedContent}\nEOF`);
        }

        const dockerCommand = buildDockerCommand(config, true, remoteEnvPath);
        await ssh.execCommand(dockerCommand);
        console.log(`\n✅ Lanzamiento de ${finalContainerName} exitoso.`);
        await pruneOldVersions(config, ssh);
        console.log(`\n🎉 ¡Éxito! El servicio '${finalContainerName}' está en ejecución en '${remote.host}'.`);

    } catch (error) {
        console.error(`\x1b[31m${error.message}\x1b[0m`);
    } finally {
        if (packageJsonWasCreated) {
            fs.unlinkSync(buildPackageJsonPath);
        }
        if (remoteEnvPath) { await ssh.execCommand(`rm ${remoteEnvPath} 2>/dev/null || true`); }
        if (fs.existsSync(archiveName)) { fs.unlinkSync(archiveName); }
        ssh.dispose();
    }
}


// --- Funciones de Ayuda y Gestión ---

function createCleanPackageJson(config) {
    const rootPackageJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(rootPackageJsonPath)) {
        console.warn(`\x1b[33mAdvertencia: No se encontró el package.json raíz. Se creará uno básico.\x1b[0m`);
        return JSON.stringify({
            name: config.name.split('-').slice(0, -1).join('-'),
            version: config.version,
            description: "Paquete de despliegue autogenerado.",
            main: config.main,
            dependencies: {}
        }, null, 2);
    }

    const originalPkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));

    const cleanPkg = {
        name: originalPkg.name,
        version: originalPkg.version,
        description: originalPkg.description || "Despliegue de " + originalPkg.name,
        main: originalPkg.main || config.main,
        dependencies: originalPkg.dependencies || {}
    };

    return JSON.stringify(cleanPkg, null, 2);
}

function showHelp() {
    console.log(`
    deploy-docker - Herramienta CLI para despliegues en Docker.

    Uso:
      deploy-docker --file=<ruta_al_json> [-f | --force] [--rm]

    Opciones:
      --file=<ruta>  (Obligatorio) Ruta al archivo de configuración del despliegue.
      -f, --force      (Opcional) Fuerza el despliegue de una versión existente en producción
                     renombrando el contenedor antiguo como un backup. No elimina datos.
      --rm           (Opcional) Elimina completamente el contenedor y volumen de la
                     versión actual antes de desplegar. Acción destructiva.
      -h, --help     Muestra esta ayuda.
    `);
}

function buildDockerCommand(config, isRemote = false, remoteEnvPath = null) {
    if (config.deployType === 'static') {
        return buildStaticDockerCommand(config, isRemote);
    }
    return buildNodeDockerCommand(config, isRemote, remoteEnvPath);
}

function buildStaticDockerCommand(config, isRemote) {
    const { name, port, volume, dockerOptions } = config;
    const image = config.image;

    let dockerRunCmd = [
        `docker run -d`,
        `--name "${name}"`,
        `-p "${port}:80"`,
        `-v "${volume}:/usr/share/nginx/html:ro"`,
    ];

    if (dockerOptions.restart) dockerRunCmd.push(`--restart "${dockerOptions.restart}"`);
    if (dockerOptions.networks) (dockerOptions.networks || []).forEach(net => dockerRunCmd.push(`--network "${net}"`));
    if (dockerOptions.labels) (dockerOptions.labels || []).forEach(label => dockerRunCmd.push(`--label "${label}"`));
    if (dockerOptions.memory) dockerRunCmd.push(`--memory "${dockerOptions.memory}"`);
    if (dockerOptions.cpus) dockerRunCmd.push(`--cpus "${dockerOptions.cpus}"`);
    
    dockerRunCmd.push(`"${image}"`);
    const dockerRunStr = dockerRunCmd.join(' ');
    
    if (isRemote) {
        return `docker ps -a -q -f name=${name} | xargs -r docker stop && docker ps -a -q -f name=${name} | xargs -r docker rm && ${dockerRunStr}`;
    }
    return dockerRunCmd;
}

function buildNodeDockerCommand(config, isRemote = false, remoteEnvPath = null) {
    const { name, port, volume, image, dockerOptions, main: entrypoint, customCommand } = config;
    const { finalEnvContent } = buildEnvironment(config);
    let dockerRunCmd = [`docker run -d`, `--name "${name}"`, `-p "${port}:3000"`, `-v "${volume}:/app"`, `-w /app`];

    if (dockerOptions.cpus) dockerRunCmd.push(`--cpus "${dockerOptions.cpus}"`);
    if (dockerOptions.memory) dockerRunCmd.push(`--memory "${dockerOptions.memory}"`);
    if (dockerOptions.restart) dockerRunCmd.push(`--restart "${dockerOptions.restart}"`);
    if (dockerOptions.hostname) dockerRunCmd.push(`--hostname "${dockerOptions.hostname}"`);
    if (dockerOptions.user) dockerRunCmd.push(`--user "${dockerOptions.user}"`);
    if (dockerOptions.networks) dockerOptions.networks.forEach(net => dockerRunCmd.push(`--network "${net}"`));
    if (dockerOptions.addHost) dockerRunCmd.addHost.forEach(host => dockerRunCmd.push(`--add-host "${host}"`));
    if (dockerOptions.labels) dockerOptions.labels.forEach(label => dockerRunCmd.push(`--label "${label}"`));
    
    if (finalEnvContent) {
        const envPath = isRemote ? remoteEnvPath : path.resolve('.env.deploy.local');
        if (!isRemote) fs.writeFileSync(envPath, finalEnvContent);
        if (envPath) dockerRunCmd.push(`--env-file "${envPath}"`);
    }
    
    dockerRunCmd.push(`"${image}"`);
    
    const finalExecCommand = customCommand || `sh -c "if [ ! -d 'node_modules' ]; then npm install; fi; node ${entrypoint}"`;
    dockerRunCmd.push(finalExecCommand);

    const dockerRunStr = dockerRunCmd.join(' ');
    if (isRemote) {
        return `docker ps -a -q -f name=${name} | xargs -r docker stop && docker ps -a -q -f name=${name} | xargs -r docker rm && ${dockerRunStr}`;
    }
    return dockerRunCmd;
}

function loadConfig(configFile) {
    const configPath = path.resolve(configFile);
    if (!fs.existsSync(configPath)) {
        console.error(`\x1b[31mError: El archivo de configuración '${configPath}' no existe.\x1b[0m`);
        process.exit(1);
    }
    
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const baseDefaults = {
        deployType: 'node',
        dockerOptions: {},
        buildDir: 'build'
    };
    
    let config = { ...baseDefaults, ...userConfig };

    const typeDefaults = {
        main: config.deployType === 'static' ? 'index.html' : 'index.js',
        image: config.deployType === 'static' ? 'nginx:alpine' : 'node:lts-slim'
    };
    
    config = { ...baseDefaults, ...typeDefaults, ...userConfig };

    return config;
}

function run(command) {
    try {
        return execSync(command, { stdio: 'pipe' }).toString().trim();
    } catch (error) {
        return "";
    }
}

function compressDirectory(source, out) {
    if (!fs.existsSync(source)) {
        console.error(`\x1b[31mError: El directorio a comprimir '${source}' no existe.\x1b[0m`);
        process.exit(1);
    }
    const archive = archiver('tar', { gzip: true });
    const stream = fs.createWriteStream(out);
    return new Promise((resolve, reject) => {
        archive.directory(source, false).on('error', err => reject(err)).pipe(stream);
        stream.on('close', () => resolve());
        archive.finalize();
    });
}

async function ensureVolumeExists(volumeName, ssh = null) {
    if (!volumeName) return;
    console.log(`- Verificando volumen '${volumeName}'...`);
    const execute = ssh ? (cmd) => ssh.execCommand(cmd) : (cmd) => Promise.resolve({ stdout: run(cmd) });
    const checkCmd = `docker volume ls -q -f name=^${volumeName}$`;
    const { stdout: exists } = await execute(checkCmd);
    if (!exists) {
        console.log(` -> Creando volumen...`);
        const createCmd = `docker volume create ${volumeName}`;
        await execute(createCmd);
    } else {
        console.log(` -> El volumen ya existe.`);
    }
}

async function ensureNetworksExist(networks = [], ssh = null) {
    if (networks.length === 0) return;
    console.log('- Verificando redes Docker...');
    const execute = ssh ? (cmd) => ssh.execCommand(cmd) : (cmd) => Promise.resolve({ stdout: run(cmd) });
    for (const network of networks) {
        const checkCmd = `docker network ls -q -f name=^${network}$`;
        const { stdout: exists } = await execute(checkCmd);
        if (!exists) {
            console.log(` -> Creando red '${network}'...`);
            const createCmd = `docker network create ${network}`;
            await execute(createCmd);
        } else {
            console.log(` -> La red '${network}' ya existe.`);
        }
    }
}

function performTokenReplacement(config, finalEnv) {
    const entrypoint = config.main;
    const entrypointFile = path.join(config.buildDir, entrypoint);
    if (!fs.existsSync(entrypointFile)) {
        console.warn(`\x1b[33mAdvertencia: No se encontró '${entrypointFile}' para reemplazo de tokens.\x1b[0m`);
        return;
    }
    console.log(`- Reemplazando tokens en '${entrypointFile}'...`);
    let content = fs.readFileSync(entrypointFile, 'utf-8');
    const envName = finalEnv.get('NODE_ENV') || 'undefined';
    const newContent = content.replace(/\*env/g, envName);
    fs.writeFileSync(entrypointFile, newContent, 'utf-8');
}

function buildEnvironment(config) {
    const finalEnv = new Map();
    if (config.envFile && fs.existsSync(config.envFile)) {
        fs.readFileSync(config.envFile, 'utf-8').split('\n').forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('#')) {
                const [key, ...valueParts] = trimmedLine.split('=');
                if (key) finalEnv.set(key, valueParts.join('='));
            }
        });
    }
    if (config.env && typeof config.env === 'object') {
        for (const [key, value] of Object.entries(config.env)) {
            finalEnv.set(key, String(value));
        }
    }
    let finalEnvContent = '';
    for (const [key, value] of finalEnv.entries()) {
        finalEnvContent += `${key}=${value}\n`;
    }
    return { finalEnv, finalEnvContent };
}

async function checkProductionVersion(config, force, recreate, ssh = null) {
    const { finalEnv } = buildEnvironment(config);
    const nodeEnv = finalEnv.get('NODE_ENV');
    if (nodeEnv !== 'production') return;

    console.log(`- Validando versión para PRODUCCIÓN...`);

    if (force || recreate) {
        console.log(`\x1b[33m  -> Saltando validación por flag --force o --rm.\x1b[0m`);
        return;
    }
    
    const { name: baseName, version: newVersion } = config;
    const execute = ssh ? (cmd) => ssh.execCommand(cmd) : (cmd) => Promise.resolve({ stdout: run(cmd) });
    const listCmd = `docker ps -a --format "{{.Names}}" --filter "name=^${baseName}-"`;
    const { stdout: allVersionsOutput } = await execute(listCmd);

    if (!allVersionsOutput) {
        console.log('  -> No existen versiones previas.');
        return;
    }

    const deployedVersions = allVersionsOutput.split('\n').filter(Boolean).map(name => name.replace(`${baseName}-`, ''));
    
    if (deployedVersions.includes(newVersion)) {
        throw new Error(`¡Bloqueado! La versión '${newVersion}' ya está desplegada en producción. Usa --force o --rm para anular.`);
    }

    const latestDeployedVersion = deployedVersions.reduce((latest, v) => (semver.gt(v, latest) ? v : latest), '0.0.0');

    if (!semver.gt(newVersion, latestDeployedVersion)) {
        throw new Error(`¡Bloqueado! La nueva versión '${newVersion}' no es mayor que la última desplegada ('${latestDeployedVersion}').`);
    }
    console.log(`\x1b[32m  -> Verificación de versión exitosa.\x1b[0m`);
}

async function stopAllOtherVersions(baseName, currentContainerName, ssh = null) {
    console.log(`- Buscando otras versiones de '${baseName}' para detener...`);
    const execute = ssh ? (cmd) => ssh.execCommand(cmd) : (cmd) => Promise.resolve({ stdout: run(cmd) });
    const listCmd = `docker ps -a --format "{{.Names}}" --filter "name=^${baseName}-"`;
    const { stdout: runningContainers } = await execute(listCmd);

    if (runningContainers) {
        const containersToStop = runningContainers.split('\n').filter(name => name && name !== currentContainerName);
        if (containersToStop.length > 0) {
            const containerIds = containersToStop.join(' ');
            console.log(` -> Deteniendo contenedores antiguos: ${containerIds}`);
            await execute(`docker stop ${containerIds}`);
        } else {
             console.log(` -> No hay otras versiones para detener.`);
        }
    } else {
        console.log(` -> No se encontraron otras versiones.`);
    }
}

async function pruneOldVersions(config, ssh = null) {
    const { name: baseName, version: currentVersion } = config;
    const keepVersions = config.keepVersions || 4;
    console.log(`🧹 Limpiando versiones antiguas, manteniendo las últimas ${keepVersions}...`);
    
    const execute = ssh ? (cmd) => ssh.execCommand(cmd) : (cmd) => Promise.resolve({ stdout: run(cmd) });
    const listCmd = `docker ps -a --format "{{.Names}}\\t{{.CreatedAt}}" --filter "name=^${baseName}-"`;
    const { stdout: allVersionsOutput } = await execute(listCmd);
    
    if (!allVersionsOutput) {
        console.log(' -> No se encontraron versiones antiguas.');
        return;
    }

    const versions = allVersionsOutput.split('\n').map(line => {
            const [name, createdAt] = line.split('\t');
            return { name, createdAt: new Date(createdAt) };
        })
        .filter(v => v.name && v.name !== `${baseName}-${currentVersion}`)
        .sort((a, b) => b.createdAt - a.createdAt);

    if (versions.length > keepVersions) {
        const versionsToPrune = versions.slice(keepVersions);
        console.log(` -> Se encontraron ${versions.length} versiones antiguas. Se eliminarán ${versionsToPrune.length}.`);

        for (const version of versionsToPrune) {
            const oldContainerName = version.name;
            const oldVersionTag = oldContainerName.replace(`${baseName}-`, '');
            const oldVolumeName = `${baseName}-data-${oldVersionTag}`;
            
            console.log(`   - Eliminando versión antigua: ${oldContainerName}`);
            await execute(`docker rm ${oldContainerName}`);
            console.log(`   - Eliminando volumen asociado: ${oldVolumeName}`);
            await execute(`docker volume rm ${oldVolumeName}`);
        }
    } else {
        console.log(` -> No se requiere limpieza.`);
    }
}

// Iniciar la ejecución
main();
