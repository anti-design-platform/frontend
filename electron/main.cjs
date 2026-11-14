const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, execSync, execFileSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

console.log('[Electron] main.cjs loaded');

function desktopLog(category, level, message, extra = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${category}] [${level}] ${message}`);
  if (extra && Object.keys(extra).length > 0) {
    console.log(JSON.stringify(extra, null, 2));
  }
}

function configureElectronRuntime() {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');

  if (app.isPackaged) return;

  // Suppress verbose dev-only CSP warning in development
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  // Use standard Electron cache location instead of custom storage
  // This avoids permission issues with sandbox
  const appDataPath = app.getPath('userData');
  const cacheRoot = path.join(appDataPath, 'Cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  app.setPath('userData', appDataPath);
  app.setPath('cache', cacheRoot);
  // Don't set custom runtime path - use Electron defaults
}

function loadEnvFile() {
  const candidates = [
    path.join(process.resourcesPath || '', '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(getProjectRoot(), '.env'),
  ];
  const envPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!envPath) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (err) {
    console.error('Failed to load .env file:', err);
  }
}

function getProjectRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  // When running npm run dev from the 'frontend' directory, process.cwd() is .../frontend.
  // The actual project root containing backend, .venv, etc. is the parent folder.
  const current = process.cwd();
  if (fs.existsSync(path.join(current, '..', 'backend')) && fs.existsSync(path.join(current, '..', '.venv'))) {
    return path.resolve(current, '..');
  }
  if (!fs.existsSync(path.join(current, 'backend')) && fs.existsSync(path.join(__dirname, '..', '..', 'backend'))) {
    return path.resolve(__dirname, '..', '..');
  }
  return current;
}

function getStorageRoot() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'storage');
  }
  return path.join(getProjectRoot(), 'storage');
}

function ensureStorageDirectories() {
  const storageRoot = getStorageRoot();
  const uploadsDir = path.join(storageRoot, 'uploads');
  const outputsDir = path.join(storageRoot, 'outputs');
  const tempDir = path.join(storageRoot, 'temp');

  for (const dir of [uploadsDir, outputsDir, tempDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  process.env.STORAGE_UPLOAD_DIR = uploadsDir;
  process.env.STORAGE_OUTPUT_DIR = outputsDir;
  process.env.STORAGE_TEMP_DIR = tempDir;

  desktopLog('storage', 'INFO', 'Storage directories ready', {
    root: storageRoot,
    uploads: uploadsDir,
    outputs: outputsDir,
    temp: tempDir,
  });

  return storageRoot;
}

const VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
let mainWindow = null;
let packagedRendererUrl = null;

const RENDERER_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function startPackagedRenderer() {
  const distDir = path.join(__dirname, '..', 'dist');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const requested = decodeURIComponent(requestUrl.pathname);
      const relative = path.normalize(requested).replace(/^([/\\])+/, '');
      let filePath = path.join(distDir, relative === '.' ? 'index.html' : relative);
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (path.extname(requested)) {
          res.writeHead(404);
          res.end();
          return;
        }
        filePath = path.join(distDir, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': RENDERER_MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}
const pythonChildProcesses = [];
const backendStatus = {
  vite: { url: VITE_DEV_SERVER_URL, healthy: false },
  main_backend: { url: 'http://127.0.0.1:8000/api/v1/health', healthy: false },
  ai_server_2d: { url: 'http://127.0.0.1:8001/health', healthy: false },
  edit_server: { url: 'http://127.0.0.1:8002/health', healthy: false },
  nesting_worker: { url: 'http://127.0.0.1:8003/health', healthy: false },
  database: { healthy: false, path: null },
  checkedAt: null,
};

function resolvePythonCommand() {
  if (process.env.PYTHON_PATH && process.env.PYTHON_PATH.trim()) {
    return process.env.PYTHON_PATH.trim();
  }
  const projectPython = path.join(getProjectRoot(), '.venv', 'Scripts', 'python.exe');
  if (process.platform === 'win32' && fs.existsSync(projectPython)) {
    return projectPython;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function isServiceCompatible(url, revision) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).api_revision === revision); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function stopStaleUvicornOnPort(port) {
  if (process.platform === 'win32') {
    try {
      const netstatOut = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const lines = netstatOut.split('\n');
      const pidsToKill = new Set();
      for (const line of lines) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(Number(pid)) && Number(pid) > 0) {
            pidsToKill.add(pid);
          }
        }
      }
      for (const pid of pidsToKill) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, timeout: 2000, stdio: 'ignore' });
        } catch {}
      }
      return true;
    } catch (err) {
      desktopLog('services', 'WARN', 'Could not replace stale Python service', { port, message: err.message });
      return false;
    }
  } else {
    try {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function startPythonUvicornService(serviceLabel, options) {
  if (process.env.SKIP_PYTHON_SERVICES === '1') {
    desktopLog('services', 'INFO', `Skipping ${serviceLabel} (SKIP_PYTHON_SERVICES=1)`);
    return null;
  }

  const { cwd, port, modulePath, extraEnv = {} } = options;
  if (!fs.existsSync(cwd)) {
    desktopLog('services', 'WARN', `${serviceLabel} directory missing`, { path: cwd });
    return null;
  }

  // In development it is common to start the APIs separately for tests.
  // Never start a duplicate child: Windows reports that as WinError 10013.
  if (await isPortInUse(port)) {
    if (options.apiRevision && options.healthUrl && !(await isServiceCompatible(options.healthUrl, options.apiRevision))) {
      desktopLog('services', 'WARN', `${serviceLabel} is stale; replacing the old uvicorn process`, { port, expected: options.apiRevision });
      if (!stopStaleUvicornOnPort(port)) return null;
      for (let attempt = 0; attempt < 10 && await isPortInUse(port); attempt += 1) {
        await sleep(300);
      }
      if (await isPortInUse(port)) {
        desktopLog('services', 'ERROR', `${serviceLabel} port remained occupied after stale-process cleanup`, { port });
        return null;
      }
    } else {
      desktopLog('services', 'INFO', `${serviceLabel} is already listening; reusing it`, { port });
      return null;
    }
  }

  const pythonCmd = resolvePythonCommand();
  const args = ['-m', 'uvicorn', modulePath, '--host', '127.0.0.1', '--port', String(port)];
  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    args.push('--reload');
  }

  desktopLog('services', 'INFO', `Starting ${serviceLabel}`, { port, cwd, module: modulePath });

  const child = spawn(pythonCmd, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${serviceLabel}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${serviceLabel}] ${chunk}`));
  child.on('error', (err) => {
    desktopLog('services', 'ERROR', `${serviceLabel} process error`, { message: err.message });
  });
  child.on('exit', (code, signal) => {
    desktopLog('services', 'INFO', `${serviceLabel} exited`, { code, signal });
  });

  pythonChildProcesses.push(child);
  return child;
}

async function startAllPythonServices(projectRoot) {
  await startPythonUvicornService('main_backend', {
    cwd: projectRoot,
    port: 8000,
    modulePath: 'backend.app.main:app',
    extraEnv: { PYTHONPATH: projectRoot },
    healthUrl: 'http://127.0.0.1:8000/api/v1/health',
    apiRevision: '2d-contract-v2-paddle',
  });

  await startPythonUvicornService('ai_server_2d', {
    cwd: path.join(projectRoot, 'ai_server_2d'),
    port: 8001,
    modulePath: 'app.main:app',
    healthUrl: 'http://127.0.0.1:8001/health',
    apiRevision: '2d-contract-v2',
  });

  await startPythonUvicornService('edit_server', {
    cwd: path.join(projectRoot, 'core', 'edit_server'),
    port: 8002,
    modulePath: 'app.main:app',
  });

  await startPythonUvicornService('nesting_worker', {
    cwd: path.join(projectRoot, 'core', 'nesting_worker'),
    port: 8003,
    modulePath: 'app.main:app',
  });
}

function stopAuxiliaryPythonServices() {
  for (const proc of pythonChildProcesses) {
    try {
      if (proc && !proc.killed) proc.kill();
    } catch (err) {
      desktopLog('services', 'WARN', 'Failed to stop Python child process', { message: err.message });
    }
  }
  pythonChildProcesses.length = 0;
}

function pingHealth(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupHealthChecks(projectRoot) {
  const dbPath = path.join(projectRoot, 'cad_studio.db');
  backendStatus.database.path = dbPath;
  backendStatus.database.healthy = fs.existsSync(dbPath) || process.env.NODE_ENV === 'development';

  const maxAttempts = 3; // Reduced to 3 (4.5 seconds total)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    backendStatus.vite.healthy = await pingHealth(VITE_DEV_SERVER_URL);
    backendStatus.main_backend.healthy = await pingHealth(backendStatus.main_backend.url);
    // Only check critical services for startup - others can start later
    backendStatus.ai_server_2d.healthy = await pingHealth(backendStatus.ai_server_2d.url);
    backendStatus.edit_server.healthy = await pingHealth(backendStatus.edit_server.url);
    backendStatus.nesting_worker.healthy = await pingHealth(backendStatus.nesting_worker.url);
    backendStatus.checkedAt = new Date().toISOString();

    const summary = Object.entries(backendStatus)
      .filter(([key]) => key !== 'checkedAt')
      .map(([key, value]) => `${key}=${value.healthy ? 'ok' : 'down'}`)
      .join(', ');

    desktopLog('health', 'INFO', `Startup health check (${attempt}/${maxAttempts}): ${summary}`);

    // Only require vite and main_backend for startup - other services can load asynchronously
    const criticalReady =
      backendStatus.vite.healthy &&
      backendStatus.main_backend.healthy;

    if (criticalReady) break;
    await sleep(1500);
  }
}

function createWindow() {
  desktopLog('lifecycle', 'INFO', 'Creating main BrowserWindow');

  const preloadPath = path.join(__dirname, 'preload.cjs');
  const isDev = !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, '..', 'src', 'assets', 'anti-design-logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
      webSecurity: true,
    },
    // A hidden window can remain invisible forever when a renderer import fails.
    // Show the native shell immediately and let the renderer report its own error.
    show: true,
    backgroundColor: '#0f172a',
  });

  if (isDev) {
    desktopLog('lifecycle', 'INFO', 'Loading renderer (dev mode)');
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    desktopLog('lifecycle', 'INFO', 'Loading packaged renderer', { url: packagedRendererUrl });
    mainWindow.loadURL(packagedRendererUrl);
  }

  mainWindow.once('ready-to-show', () => {
    desktopLog('lifecycle', 'INFO', 'Renderer ready to show');
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    desktopLog('lifecycle', 'INFO', 'Renderer did-finish-load');
    mainWindow?.show();
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelName = ['verbose', 'info', 'warning', 'error'][level] || 'log';
    desktopLog('renderer', levelName.toUpperCase(), message, { line, source: sourceId });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    desktopLog('renderer', 'ERROR', 'Renderer process stopped', details);
  });

  mainWindow.webContents.on('did-fail-load', (_event, _code, _desc, validatedURL) => {
    if (isDev && validatedURL.startsWith('http://127.0.0.1:5173')) {
      desktopLog('lifecycle', 'WARN', 'Vite not ready yet — retrying in 1.5s');
      setTimeout(() => {
        if (mainWindow) mainWindow.loadURL(VITE_DEV_SERVER_URL);
      }, 1500);
    }
  });

  // A visible fallback is preferable to a silent, permanently hidden desktop app.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      desktopLog('lifecycle', 'WARN', 'Renderer did not become ready in time; showing window anyway');
      mainWindow.show();
    }
  }, 5000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIPCHandlers() {
  ipcMain.handle('get-system-info', () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    projectRoot: getProjectRoot(),
    storageRoot: getStorageRoot(),
  }));

  ipcMain.handle('open-external', (_event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle('show-message-box', (_event, options) => {
    return dialog.showMessageBox(mainWindow, options);
  });

  ipcMain.handle('dialog:openFile', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: options.filters || [
        { name: 'CAD Files', extensions: ['dxf', 'stl', 'step', 'stp', 'obj', 'iges', 'igs'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      ...options,
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_event, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'export.dxf',
      filters: [
        { name: 'DXF', extensions: ['dxf'] },
        { name: 'STL', extensions: ['stl'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  /**
   * fs:saveGeneratedFile
   * Opens a native Save-As dialog, then writes the provided file bytes (or
   * copies from an absolute source path) to the chosen destination.
   *
   * Payload: { sourcePath?: string, base64Data?: string, defaultName: string }
   *   - sourcePath  : absolute path on disk — preferred when available
   *   - base64Data  : raw base64-encoded file bytes (fallback when no path)
   *   - defaultName : suggested filename shown in the dialog
   *
   * Returns: { saved: true, destPath } | { saved: false } | { error: string }
   */
  ipcMain.handle('fs:saveGeneratedFile', async (_event, { sourcePath, base64Data, textData, defaultName }) => {
    try {
      const ext = (defaultName || 'file').split('.').pop()?.toLowerCase() || '*';
      const filters = ext === 'dxf'
        ? [{ name: 'DXF Files', extensions: ['dxf'] }, { name: 'All Files', extensions: ['*'] }]
        : ext === 'stl'
          ? [{ name: 'STL Files', extensions: ['stl'] }, { name: 'All Files', extensions: ['*'] }]
          : [{ name: 'All Files', extensions: ['*'] }];

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName || (ext === 'stl' ? 'model.stl' : 'blueprint.dxf'),
        filters,
      });

      if (result.canceled || !result.filePath) return { saved: false };

      const dest = result.filePath;
      const projectRoot = getProjectRoot();

      // 1. Try resolving physical source path on disk
      let resolvedSource = null;
      if (sourcePath) {
        const candidates = [
          sourcePath,
          path.resolve(sourcePath),
          path.join(projectRoot, sourcePath),
          path.join(projectRoot, 'backend', sourcePath),
          path.join(projectRoot, 'backend', 'storage', 'outputs', path.basename(sourcePath)),
          path.join(projectRoot, 'storage', 'outputs', path.basename(sourcePath)),
          path.join(getStorageRoot(), 'outputs', path.basename(sourcePath)),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            resolvedSource = candidate;
            break;
          }
        }
      }

      // 1.1 Fallback: If not found by name, find the most recently generated output file matching extension
      if (!resolvedSource && !textData && !base64Data) {
        const searchDirs = [
          path.join(projectRoot, 'backend', 'storage', 'outputs'),
          path.join(projectRoot, 'storage', 'outputs'),
          path.join(getStorageRoot(), 'outputs'),
        ];
        let newestFile = null;
        let newestMtime = 0;

        for (const dir of searchDirs) {
          if (fs.existsSync(dir)) {
            const findFiles = (d) => {
              try {
                for (const item of fs.readdirSync(d)) {
                  const full = path.join(d, item);
                  const stat = fs.statSync(full);
                  if (stat.isDirectory()) {
                    findFiles(full);
                  } else if (stat.isFile() && (ext === '*' || full.toLowerCase().endsWith('.' + ext))) {
                    if (stat.mtimeMs > newestMtime) {
                      newestMtime = stat.mtimeMs;
                      newestFile = full;
                    }
                  }
                }
              } catch {}
            };
            findFiles(dir);
          }
        }

        if (newestFile) {
          resolvedSource = newestFile;
          desktopLog('storage', 'INFO', `Found latest output fallback: ${newestFile}`);
        }
      }

      if (resolvedSource) {
        fs.copyFileSync(resolvedSource, dest);
        desktopLog('storage', 'INFO', `File copied from ${resolvedSource} to ${dest}`);
        return { saved: true, destPath: dest };
      }

      // 2. Plain text data (e.g. raw DXF content)
      if (textData && typeof textData === 'string' && textData.trim()) {
        fs.writeFileSync(dest, textData, 'utf8');
        desktopLog('storage', 'INFO', `Raw text written to ${dest}`);
        return { saved: true, destPath: dest };
      }

      // 3. Base64 data (or check if base64Data is actually plain text)
      if (base64Data && typeof base64Data === 'string') {
        const cleanB64 = base64Data.includes(';base64,') ? base64Data.split(';base64,')[1] : base64Data;
        if (cleanB64.startsWith('0\n') || cleanB64.startsWith('0\r\n') || cleanB64.includes('SECTION')) {
          // It's raw DXF text mistakenly passed as base64
          fs.writeFileSync(dest, cleanB64, 'utf8');
        } else {
          const buf = Buffer.from(cleanB64, 'base64');
          fs.writeFileSync(dest, buf);
        }
        desktopLog('storage', 'INFO', `Base64 payload written to ${dest}`);
        return { saved: true, destPath: dest };
      }

      // 4. Remote URL or Cloud Server Fallback: Download file directly via HTTP/HTTPS
      if (sourcePath && typeof sourcePath === 'string') {
        const backendOrigin = (process.env.VITE_API_ORIGIN || 'http://127.0.0.1:8000').replace(/\/+$/, '');
        let targetDownloadUrl = null;

        if (sourcePath.startsWith('http://') || sourcePath.startsWith('https://')) {
          targetDownloadUrl = sourcePath;
        } else {
          // It's a cloud server path like /opt/backend/storage/outputs/... or storage/outputs/...
          const clean = sourcePath.replace(/\\/g, '/').replace(/^\/+/, '');
          if (clean.includes('storage/outputs/')) {
            const rel = clean.split('storage/outputs/')[1];
            targetDownloadUrl = `${backendOrigin}/static/outputs/${rel}`;
          } else if (clean.includes('outputs/')) {
            const rel = clean.split('outputs/')[1];
            targetDownloadUrl = `${backendOrigin}/static/outputs/${rel}`;
          } else {
            targetDownloadUrl = `${backendOrigin}/api/v1/files/download?file_path=${encodeURIComponent(sourcePath)}`;
          }
        }

        if (targetDownloadUrl) {
          desktopLog('storage', 'INFO', `Attempting remote download from ${targetDownloadUrl} to ${dest}`);
          const downloadSuccess = await new Promise((resolve) => {
            const client = targetDownloadUrl.startsWith('https') ? https : http;
            const fileStream = fs.createWriteStream(dest);
            const req = client.get(targetDownloadUrl, (res) => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                  fileStream.close(() => resolve(true));
                });
              } else {
                fileStream.close();
                fs.unlink(dest, () => {});
                desktopLog('storage', 'WARN', `Remote download failed with status ${res.statusCode}`);
                resolve(false);
              }
            });
            req.on('error', (err) => {
              fileStream.close();
              fs.unlink(dest, () => {});
              desktopLog('storage', 'ERROR', `Remote download request error: ${err.message}`);
              resolve(false);
            });
            req.setTimeout(30000, () => {
              req.destroy();
              fileStream.close();
              fs.unlink(dest, () => {});
              resolve(false);
            });
          });

          if (downloadSuccess && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            desktopLog('storage', 'INFO', `File successfully downloaded and saved to ${dest}`);
            return { saved: true, destPath: dest };
          }
        }
      }

      return { error: 'Could not find the generated file on disk or in memory.' };
    } catch (err) {
      desktopLog('storage', 'ERROR', 'Save generated file failed', { error: err.message });
      return { error: err.message || String(err) };
    }
  });

  ipcMain.handle('app:getBackendStatus', () => backendStatus);

  ipcMain.handle('app:openExternalCad', async (_event, { cadExecutablePath, filePath }) => {
    if (!filePath) {
      return { success: false, error: 'No file path provided.' };
    }

    let localTarget = filePath;

    // If filePath does not exist locally (e.g. cloud server path like /opt/backend/... or relative path)
    if (!fs.existsSync(localTarget)) {
      const projectRoot = getProjectRoot();
      const candidates = [
        path.resolve(localTarget),
        path.join(projectRoot, localTarget),
        path.join(projectRoot, 'backend', localTarget),
        path.join(projectRoot, 'backend', 'storage', 'outputs', path.basename(localTarget)),
        path.join(projectRoot, 'storage', 'outputs', path.basename(localTarget)),
        path.join(getStorageRoot(), 'outputs', path.basename(localTarget)),
      ];

      for (const cand of candidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          localTarget = cand;
          break;
        }
      }

      // If still not found locally on disk, download it to the local cache/temp folder automatically
      if (!fs.existsSync(localTarget)) {
        const backendOrigin = (process.env.VITE_API_ORIGIN || 'http://127.0.0.1:8000').replace(/\/+$/, '');
        let targetDownloadUrl = null;

        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
          targetDownloadUrl = filePath;
        } else {
          const clean = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
          if (clean.includes('storage/outputs/')) {
            const rel = clean.split('storage/outputs/')[1];
            targetDownloadUrl = `${backendOrigin}/static/outputs/${rel}`;
          } else if (clean.includes('outputs/')) {
            const rel = clean.split('outputs/')[1];
            targetDownloadUrl = `${backendOrigin}/static/outputs/${rel}`;
          } else {
            targetDownloadUrl = `${backendOrigin}/api/v1/files/download?file_path=${encodeURIComponent(filePath)}`;
          }
        }

        if (targetDownloadUrl) {
          const tempFolder = path.join(getStorageRoot(), 'temp');
          fs.mkdirSync(tempFolder, { recursive: true });
          const downloadedFileName = path.basename(filePath) || 'design.dxf';
          const cachedLocalPath = path.join(tempFolder, downloadedFileName);

          desktopLog('cad', 'INFO', `Downloading remote CAD file before opening: ${targetDownloadUrl} -> ${cachedLocalPath}`);
          const downloadSuccess = await new Promise((resolve) => {
            const client = targetDownloadUrl.startsWith('https') ? https : http;
            const fileStream = fs.createWriteStream(cachedLocalPath);
            const req = client.get(targetDownloadUrl, (res) => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                  fileStream.close(() => resolve(true));
                });
              } else {
                fileStream.close();
                fs.unlink(cachedLocalPath, () => {});
                resolve(false);
              }
            });
            req.on('error', () => {
              fileStream.close();
              fs.unlink(cachedLocalPath, () => {});
              resolve(false);
            });
            req.setTimeout(30000, () => {
              req.destroy();
              fileStream.close();
              fs.unlink(cachedLocalPath, () => {});
              resolve(false);
            });
          });

          if (downloadSuccess && fs.existsSync(cachedLocalPath)) {
            localTarget = cachedLocalPath;
          }
        }
      }
    }

    if (!fs.existsSync(localTarget)) {
      return { success: false, error: `File path does not exist on disk: ${filePath}` };
    }

    try {
      const trimmedCadPath = (cadExecutablePath || '').trim();
      if (trimmedCadPath && fs.existsSync(trimmedCadPath)) {
        if (trimmedCadPath.toLowerCase().endsWith('.lnk')) {
          // Launch Windows shortcut passing the file path argument via cmd /c start ""
          spawn('cmd.exe', ['/c', 'start', '""', trimmedCadPath, localTarget], { detached: true, stdio: 'ignore' }).unref();
          return { success: true, method: 'shortcut_lnk', localPath: localTarget };
        } else {
          spawn(trimmedCadPath, [localTarget], { detached: true, stdio: 'ignore' }).unref();
          return { success: true, method: 'custom_exe', localPath: localTarget };
        }
      } else {
        const errorMsg = await shell.openPath(localTarget);
        if (errorMsg) {
          return { success: false, error: errorMsg };
        }
        return { success: true, method: 'shell_default', localPath: localTarget };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('auth:googleLogin', async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return { error: 'GOOGLE_CLIENT_ID is not configured in .env' };
    }

    return new Promise((resolve) => {
      let redirectUri = '';
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };

      const server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        if (requestUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = requestUrl.searchParams.get('code');
        const oauthError = requestUrl.searchParams.get('error');
        // Read the Anti Design logo at runtime and inject as base64 data URL
        let logoDataUrl = '';
        try {
          const logoPath = path.join(getProjectRoot(), 'frontend', 'src', 'assets', 'anti-design-logo.png');
          if (fs.existsSync(logoPath)) {
            logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
          }
        } catch (_logoErr) { /* logo not critical */ }
        const successHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anti Design — Signed In</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #f8fafc;
    overflow: hidden;
  }
  /* Ambient glow blobs */
  body::before {
    content: '';
    position: fixed;
    top: -200px; left: -200px;
    width: 600px; height: 600px;
    background: radial-gradient(circle, rgba(99,102,241,0.25) 0%, transparent 70%);
    border-radius: 50%;
    pointer-events: none;
  }
  body::after {
    content: '';
    position: fixed;
    bottom: -200px; right: -200px;
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%);
    border-radius: 50%;
    pointer-events: none;
  }
  .card {
    background: rgba(255,255,255,0.05);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 24px;
    padding: 52px 56px;
    text-align: center;
    max-width: 440px;
    width: 90%;
    position: relative;
    z-index: 1;
    box-shadow: 0 32px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08);
    animation: slideUp 0.6s cubic-bezier(0.34,1.56,0.64,1) both;
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(40px) scale(0.95); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  /* Logo */
  .logo {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 36px;
  }
  .logo-img-wrap {
    background: white;
    border-radius: 14px;
    padding: 6px 8px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 24px rgba(99,102,241,0.5);
  }
  .logo-img { width: 44px; height: 44px; object-fit: contain; }
  .logo-text {
    font-size: 22px;
    font-weight: 700;
    background: linear-gradient(135deg, #a5b4fc, #c4b5fd);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.5px;
  }
  /* Checkmark */
  .check-ring {
    width: 80px; height: 80px;
    margin: 0 auto 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2));
    border: 2px solid rgba(99,102,241,0.4);
    display: flex; align-items: center; justify-content: center;
    animation: popIn 0.5s 0.3s cubic-bezier(0.34,1.56,0.64,1) both;
    box-shadow: 0 0 40px rgba(99,102,241,0.3);
  }
  @keyframes popIn {
    from { opacity: 0; transform: scale(0.4); }
    to   { opacity: 1; transform: scale(1); }
  }
  .check-svg { width: 36px; height: 36px; }
  .check-svg path {
    stroke: #a5b4fc;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    stroke-dasharray: 50;
    stroke-dashoffset: 50;
    animation: drawCheck 0.5s 0.6s ease forwards;
  }
  @keyframes drawCheck {
    to { stroke-dashoffset: 0; }
  }
  /* Text */
  h1 {
    font-size: 26px;
    font-weight: 700;
    color: #f1f5f9;
    letter-spacing: -0.5px;
    margin-bottom: 10px;
    animation: fadeIn 0.4s 0.5s ease both;
  }
  p {
    font-size: 15px;
    color: #94a3b8;
    line-height: 1.6;
    margin-bottom: 32px;
    animation: fadeIn 0.4s 0.6s ease both;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  /* Countdown bar */
  .countdown-wrap {
    animation: fadeIn 0.4s 0.8s ease both;
  }
  .countdown-label {
    font-size: 13px;
    color: #64748b;
    margin-bottom: 10px;
  }
  .bar-track {
    height: 4px;
    background: rgba(255,255,255,0.06);
    border-radius: 999px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    width: 100%;
    background: linear-gradient(90deg, #6366f1, #8b5cf6);
    border-radius: 999px;
    animation: shrink 5s linear forwards;
    transform-origin: left;
  }
  @keyframes shrink {
    from { transform: scaleX(1); }
    to   { transform: scaleX(0); }
  }
  .close-btn {
    display: inline-block;
    margin-top: 24px;
    padding: 12px 32px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.15s;
    box-shadow: 0 8px 24px rgba(99,102,241,0.4);
    animation: fadeIn 0.4s 0.9s ease both;
  }
  .close-btn:hover { opacity: 0.9; transform: translateY(-1px); }
  .close-btn:active { transform: translateY(0); }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    ${logoDataUrl ? '<div class="logo-img-wrap"><img class="logo-img" src="' + logoDataUrl + '" alt="Anti Design"></div>' : ''}
    <span class="logo-text">Anti Design</span>
  </div>

  <div class="check-ring">
    <svg class="check-svg" viewBox="0 0 36 36">
      <path d="M7 18l7 7 15-15"/>
    </svg>
  </div>

  <h1>You're signed in!</h1>
  <p>Your Google account has been connected successfully.<br>Return to the app to continue.</p>

  <div class="countdown-wrap">
    <div class="countdown-label">This window will close automatically…</div>
    <div class="bar-track"><div class="bar-fill"></div></div>
    <button class="close-btn" onclick="window.close()">Close Window</button>
  </div>
</div>
<script>
  setTimeout(() => { try { window.close(); } catch(e) {} }, 5000);
</script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml);
        server.close();

        if (oauthError) {
          finish({ error: oauthError });
          return;
        }
        if (!code) {
          finish({ error: 'No authorization code received from Google.' });
          return;
        }

        finish({ code, redirect_uri: redirectUri });
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        redirectUri = `http://127.0.0.1:${port}/callback`;
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', 'openid email profile');
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'select_account');

        shell.openExternal(authUrl.toString());

        setTimeout(() => {
          server.close();
          finish({ error: 'Google login timed out after 3 minutes.' });
        }, 180000);
      });

      server.on('error', (err) => {
        finish({ error: `Google login server error: ${err.message}` });
      });
    });
  });
}

configureElectronRuntime();
loadEnvFile();

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-UPDATER  (electron-updater + GitHub Releases)
// Works only in packaged (production) builds. Silently ignored in dev mode.
// ─────────────────────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged) {
    desktopLog('updater', 'INFO', 'Dev mode — auto-updater disabled');
    return;
  }

  // Don't nag users more than once per session if they click "Later"
  let updateAvailableNotified = false;

  autoUpdater.autoDownload = false;      // ask user before downloading
  autoUpdater.autoInstallOnAppQuit = true; // install quietly on next close

  // ── Events ────────────────────────────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    desktopLog('updater', 'INFO', 'Checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    if (updateAvailableNotified) return;
    updateAvailableNotified = true;
    desktopLog('updater', 'INFO', `Update available: v${info.version}`);
    // Notify renderer → shows in-app banner
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes || '',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    desktopLog('updater', 'INFO', 'App is up to date.');
  });

  autoUpdater.on('download-progress', (progress) => {
    desktopLog('updater', 'INFO', `Downloading update: ${Math.round(progress.percent)}%`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    desktopLog('updater', 'INFO', `Update downloaded: v${info.version} — ready to install`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    desktopLog('updater', 'ERROR', 'Auto-updater error', { message: err.message });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:error', { message: err.message });
    }
  });

  // ── IPC — renderer controls ───────────────────────────────────────────────
  // Start the download when user clicks "Update Now"
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Quit & install immediately when download is complete
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Manual check (e.g. Settings page "Check for updates" button)
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, updateInfo: result?.updateInfo || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Check silently 5 seconds after the window is ready
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      desktopLog('updater', 'WARN', 'Silenced updater check error', { message: err.message });
    });
  }, 5000);
}

app.whenReady().then(async () => {
  const projectRoot = getProjectRoot();
  // The default Electron File/Edit/View menu makes the renderer look like a
  // generic browser window. The CAD UI owns its actions, so keep the desktop
  // shell focused and remove the unused native menu.
  Menu.setApplicationMenu(null);
  ensureStorageDirectories();

  desktopLog('lifecycle', 'INFO', `CNC Studio Electron v${app.getVersion()} starting`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    packaged: app.isPackaged,
    projectRoot,
  });

  registerIPCHandlers();

  if (app.isPackaged) {
    packagedRendererUrl = await startPackagedRenderer();
    createWindow();
  } else {
    // Start window immediately - don't wait for services
    createWindow();

    // Local development can launch the Python services. The installed app uses the published backend.
    startAllPythonServices(projectRoot);

    // Run health checks in background - don't block startup
    runStartupHealthChecks(projectRoot).catch((err) => {
      desktopLog('health', 'ERROR', 'Startup health checks failed', { message: err.message });
    });
  }

  // Start auto-updater after window is ready
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      desktopLog('lifecycle', 'INFO', 'Re-activating — creating new window');
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  desktopLog('lifecycle', 'INFO', 'All windows closed — shutting down');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  desktopLog('lifecycle', 'INFO', 'Application quitting');
  stopAuxiliaryPythonServices();
});
