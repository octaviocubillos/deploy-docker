#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const { NodeSSH } = require('node-ssh');
const args = require('minimist')(process.argv.slice(2));

// --- Lógica Principal ---
async function main() {
    const configFile = args.file;
    if (!configFile) {
        console.error('\x1b[31mError: Debes especificar un archivo de configuración con --file=ruta/al/archivo.json\x1b[0m');
        console.log('Usa --help para más información.');
        process.exit(1);
    }
    
    if (args.help || args.h) {
        showHelp();
        process.exit(0);
    }

    const config = loadConfig(configFile);
    
    if (config.remote) {
        await deployRemote(config);
    } else {
        deployLocal(config);
    }
}

// --- Flujos de Despliegue (Local y Remoto) ---
// (Aquí pegamos las funciones deployLocal y deployRemote de la respuesta anterior)
async function deployRemote(config) {
    console.log(`🚀 Iniciando despliegue REMOTO a '${config.remote.host}'...`);
    const ssh = new NodeSSH();
    const { finalEnvContent } = buildEnvironment(config);
    const remotePath = config.remote.path;
    const remoteEnvPath = `${remotePath}/.env.deploy`;
    const archiveName = 'deploy.tar.gz';

    try {
        console.log('🔌 Conectando al servidor...');
        await ssh.connect({
            host: config.remote.host,
            username: config.remote.user,
            privateKeyPath: config.remote.privateKeyPath,
        });

        console.log(`📦 Comprimiendo '${config.buildDir}'...`);
        await compressDirectory(config.buildDir, archiveName);
        await ssh.execCommand(`mkdir -p ${remotePath}`);
        
        console.log(`📤 Subiendo '${archiveName}' a '${remotePath}'...`);
        await ssh.putFile(path.resolve(archiveName), `${remotePath}/${archiveName}`);

        console.log(`🗜️  Descomprimiendo en el servidor...`);
        await ssh.execCommand(`tar -xzf ${archiveName} -C ${remotePath}`);
        
        if (finalEnvContent) {
            console.log('🔒 Escribiendo variables de entorno en el servidor...');
            await ssh.execCommand(`echo "${finalEnvContent.replace(/"/g, '\\"')}" > ${remoteEnvPath}`);
        }

        console.log('🐳 Ejecutando comandos de Docker remotamente...');
        const dockerCommand = buildDockerCommand(config, true);
        const result = await ssh.execCommand(dockerCommand);

        if (result.stderr) console.error('\x1b[31mError remoto de Docker:\x1b[0m', result.stderr);
        else console.log(result.stdout);

        console.log(`\n🎉 ¡Éxito! El servicio '${config.name}' está en ejecución en '${config.remote.host}'.`);

    } catch (error) {
        console.error('\x1b[31mError durante el despliegue remoto:\x1b[0m', error);
    } finally {
        console.log('🧹 Limpiando...');
        if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
        await ssh.execCommand(`rm ${remotePath}/${archiveName} ${finalEnvContent ? remoteEnvPath : ''} 2>/dev/null || true`);
        ssh.dispose();
    }
}

function deployLocal(config) {
    console.log(`🚀 Iniciando despliegue LOCAL...`);
    run(`docker -v`);
    const { name, port, volume, buildDir } = config;

    if (!fs.existsSync(buildDir) || !fs.existsSync(path.join(buildDir, 'package.json'))) {
        console.error(`\x1b[31mError: La carpeta '${buildDir}' no existe o le falta package.json.\x1b[0m`); process.exit(1);
    }

    const volumeExists = run(`docker volume ls -q -f name=${volume}`);
    if (!volumeExists) run(`docker volume create ${volume}`);
    
    const volumeHasCode = run(`docker run --rm -v "${volume}:/app" alpine ls /app/package.json 2>/dev/null || echo "false"`).includes('package.json');
    if (!volumeHasCode) run(`docker run --rm -v "${path.resolve(buildDir)}:/origen" -v "${volume}:/destino" alpine sh -c "cp -a /origen/. /destino/"`);

    const oldContainer = run(`docker ps -a -q -f name=${name}`);
    if (oldContainer) { run(`docker stop ${name}`); run(`docker rm ${name}`); }

    const finalCommand = buildDockerCommand(config).join(' ');
    run(finalCommand);

    console.log(`\n🎉 ¡Éxito! El servicio '${name}' está en ejecución localmente.`);
    console.log(`   URL: http://localhost:${port}`);
}

// --- Funciones de Ayuda ---
// (Aquí pegamos el resto de funciones: buildEnvironment, buildDockerCommand, loadConfig, run, compressDirectory)
function buildEnvironment(config) {
    const finalEnv = new Map();
    if (config.envFile && fs.existsSync(config.envFile)) {
        const fileContent = fs.readFileSync(config.envFile, 'utf-8');
        fileContent.split('\n').forEach(line => {
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
    return { finalEnvContent };
}

function buildDockerCommand(config, isRemote = false) {
    const { name, port, volume, image, dockerOptions, envFile } = config;
    const { finalEnvContent } = buildEnvironment(config);
    const remotePath = config.remote ? config.remote.path : '';
    const remoteEnvPath = `${remotePath}/.env.deploy`;

    let dockerRunCmd = [`docker run -d`, `--name "${name}"`, `-p "${port}:3000"`, `-v "${volume}:/app"`, `-w /app`];
    
    if (dockerOptions.cpus) dockerRunCmd.push(`--cpus "${dockerOptions.cpus}"`);
    if (dockerOptions.memory) dockerRunCmd.push(`--memory "${dockerOptions.memory}"`);
    if (dockerOptions.restart) dockerRunCmd.push(`--restart "${dockerOptions.restart}"`);
    if (dockerOptions.hostname) dockerRunCmd.push(`--hostname "${dockerOptions.hostname}"`);
    if (dockerOptions.networks) dockerOptions.networks.forEach(net => dockerRunCmd.push(`--network "${net}"`));
    if (dockerOptions.addHost) dockerOptions.addHost.forEach(host => dockerRunCmd.push(`--add-host "${host}"`));
    if (dockerOptions.labels) dockerOptions.labels.forEach(label => dockerRunCmd.push(`--label "${label}"`));

    // Si hay variables de entorno, las pasamos a través de un env-file temporal
    if (finalEnvContent) {
        const envPath = isRemote ? remoteEnvPath : path.resolve('.env.deploy.local');
        if (!isRemote) fs.writeFileSync(envPath, finalEnvContent);
        dockerRunCmd.push(`--env-file "${envPath}"`);
    }

    dockerRunCmd.push(`"${image}"`);
    dockerRunCmd.push(`sh -c "if [ ! -d 'node_modules' ]; then npm install; fi; node index.js"`);

    const dockerRunStr = dockerRunCmd.join(' ');
    
    let commands = [];
    commands.push(`docker ps -a -q -f name=${name} | xargs -r docker stop`);
    commands.push(`docker ps -a -q -f name=${name} | xargs -r docker rm`);
    commands.push(dockerRunStr);
    
    return commands.join(' && ');
}

function loadConfig(configFile) {
    const configPath = path.resolve(configFile);
    if (!fs.existsSync(configPath)) {
        console.error(`\x1b[31mError: El archivo de configuración '${configPath}' no existe.\x1b[0m`); process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const defaults = { image: 'node:lts-slim', dockerOptions: {}, buildDir: 'build' };
    return { ...defaults, ...config };
}

function run(command) {
    console.log(`\x1b[36m$ ${command}\x1b[0m`);
    try {
        return execSync(command, { stdio: 'pipe' }).toString().trim();
    } catch (error) {
        console.error(`\x1b[31mError ejecutando localmente:\x1b[0m ${error.message}`); process.exit(1);
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

function showHelp() {
    console.log(`
    deploy-docker - Herramienta CLI para despliegues en Docker.

    Uso:
      deploy-docker --file=<ruta_al_json>

    Ejemplo:
      deploy-docker --file=prod.deploy.json

    El archivo JSON de configuración define todos los parámetros del despliegue,
    incluyendo si es local o remoto.
    `);
}

// Iniciar la ejecución
main();
