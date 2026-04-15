const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { startProxy, forwardTcpCommand, validateRequest } = require('./ws-proxy');

const APP_PORT = Number(process.env.HORUSTECH_APP_PORT || 8780);
const APP_HOST = process.env.HORUSTECH_APP_HOST || '127.0.0.1';
const APP_FILE = 'preset-autosystem.html';
const LEGACY_APP_FILE = 'horustech-preco_v3.html';

const DB_PORT = Number(process.env.HORUSTECH_DB_PORT || 1917);
const DB_USER = process.env.HORUSTECH_DB_USER || 'postgres';
const DB_PASSWORD = process.env.HORUSTECH_DB_PASSWORD || 'LZTsystem123*#';
const DB_NAME = process.env.HORUSTECH_DB_NAME || 'autosystem';
const DEFAULT_DB_HOST = process.env.HORUSTECH_DB_HOST || '127.0.0.1';

const rootDir = __dirname;
const appPath = path.join(rootDir, APP_FILE);
const commonDataDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'PresetAutoSystem');
const configFile = path.join(commonDataDir, 'server-config.json');
const sessions = new Map();
const APP_STATE_KEY = 'default';

let dbPool = null;
let dbConfig = null;
let dbError = null;

const logFile = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'PresetAutoSystem',
  'startup.log'
);

function log(message, extra = '') {
  const timestamp = new Date().toISOString();
  const suffix = extra ? ` ${extra}` : '';
  const line = `[${timestamp}] ${message}${suffix}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {
    // ignora falha de escrita no log
  }
}

function ensureCommonDataDir() {
  fs.mkdirSync(commonDataDir, { recursive: true });
}

function generateUUID() {
  var b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function readDbConfig() {
  ensureCommonDataDir();
  let fileHost = DEFAULT_DB_HOST;

  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (parsed && typeof parsed.host === 'string' && parsed.host.trim()) {
        fileHost = parsed.host.trim();
      }
    } catch (error) {
      log('Falha ao ler server-config.json, usando host padrão', error.message);
    }
  }

  return {
    host: fileHost,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  const derived = crypto.pbkdf2Sync(password, stored.salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(stored.hash, 'hex'));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Corpo da requisição excede 1 MB.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function getSession(req) {
  const token = extractToken(req);
  return token ? sessions.get(token) : null;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, error: 'Sessão não autenticada.' });
    return null;
  }
  return session;
}

function requireSuperuser(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!session.user.isSuperuser) {
    sendJson(res, 403, { ok: false, error: 'Apenas o superusuário pode gerenciar usuários.' });
    return null;
  }
  return session;
}

function sanitizeUser(row) {
  return {
    id: row.id,
    username: row.username,
    active: Boolean(row.active),
    isSuperuser: Boolean(row.is_superuser),
    canAdjustPrices: Boolean(row.can_adjust_prices),
    createdAt: row.created_at,
  };
}

async function query(text, params = []) {
  return dbPool.query(text, params);
}

function defaultAppState() {
  return {
    config: {
      ip: '',
      port: 3000,
      password: '',
      timeout: 5000,
      delay: 300,
      decimals: 3,
      postoNome: '',
      postoCnpj: '',
      levelTexts: {
        p0: { tag: 'NÍVEL 0 - DINHEIRO / À VISTA', description: 'PREÇO NÍVEL 0 (DINHEIRO OU À VISTA)' },
        p1: { tag: 'NÍVEL 1 - CRÉDITO', description: 'PREÇO NÍVEL 1 (CRÉDITO)' },
        p2: { tag: 'NÍVEL 2 - DÉBITO', description: 'PREÇO NÍVEL 2 (DÉBITO)' },
      },
    },
    bicos: [],
    fuelPrices: {},
  };
}

function normalizeAppState(input) {
  const base = defaultAppState();
  const source = input && typeof input === 'object' ? input : {};
  const rawConfig = source.config && typeof source.config === 'object' ? source.config : {};
  const rawBicos = Array.isArray(source.bicos) ? source.bicos : [];
  const rawFuelPrices = source.fuelPrices && typeof source.fuelPrices === 'object' ? source.fuelPrices : {};

  const normalized = {
    config: {
      ip: normalizeText(rawConfig.ip),
      port: Number.isInteger(Number(rawConfig.port)) ? Number(rawConfig.port) : base.config.port,
      password: String(rawConfig.password || ''),
      timeout: Number.isInteger(Number(rawConfig.timeout)) ? Number(rawConfig.timeout) : base.config.timeout,
      delay: Number.isInteger(Number(rawConfig.delay)) ? Number(rawConfig.delay) : base.config.delay,
      decimals: Number.isInteger(Number(rawConfig.decimals)) ? Number(rawConfig.decimals) : base.config.decimals,
      postoNome: normalizeText(rawConfig.postoNome),
      postoCnpj: normalizeText(rawConfig.postoCnpj),
      levelTexts: {
        p0: {
          tag: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p0 && rawConfig.levelTexts.p0.tag) || base.config.levelTexts.p0.tag,
          description: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p0 && rawConfig.levelTexts.p0.description) || base.config.levelTexts.p0.description,
        },
        p1: {
          tag: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p1 && rawConfig.levelTexts.p1.tag) || base.config.levelTexts.p1.tag,
          description: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p1 && rawConfig.levelTexts.p1.description) || base.config.levelTexts.p1.description,
        },
        p2: {
          tag: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p2 && rawConfig.levelTexts.p2.tag) || base.config.levelTexts.p2.tag,
          description: normalizeText(rawConfig.levelTexts && rawConfig.levelTexts.p2 && rawConfig.levelTexts.p2.description) || base.config.levelTexts.p2.description,
        },
      },
    },
    bicos: rawBicos.map((item) => ({
      num: Number.isInteger(Number(item && item.num)) ? Number(item && item.num) : null,
      fuel: normalizeText(item && item.fuel),
      code: normalizeText(item && item.code).toUpperCase(),
      desc: normalizeText(item && item.desc),
    })),
    fuelPrices: {},
  };

  for (const [fuelKey, prices] of Object.entries(rawFuelPrices)) {
    normalized.fuelPrices[fuelKey] = {
      p0: String((prices && prices.p0) || ''),
      p1: String((prices && prices.p1) || ''),
      p2: String((prices && prices.p2) || ''),
    };
  }

  return normalized;
}

async function initDatabase() {
  dbConfig = readDbConfig();
  dbPool = new Pool(dbConfig);

  await query(`
    create table if not exists ht_app_users (
      id uuid primary key,
      username varchar(80) not null unique,
      password_salt varchar(64) not null,
      password_hash varchar(128) not null,
      active boolean not null default true,
      is_superuser boolean not null default false,
      can_adjust_prices boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);

  await query(`
    create table if not exists ht_app_audit_logs (
      id uuid primary key,
      user_id uuid,
      username varchar(80) not null,
      action_type varchar(40) not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    )
  `);

  await query(`
    create table if not exists ht_app_state (
      state_key varchar(40) primary key,
      config jsonb not null default '{}'::jsonb,
      bicos jsonb not null default '[]'::jsonb,
      fuel_prices jsonb not null default '{}'::jsonb,
      updated_by varchar(80),
      updated_at timestamptz not null default now()
    )
  `);

  await query(
    `insert into ht_app_state (state_key, config, bicos, fuel_prices)
     values ($1, $2::jsonb, $3::jsonb, $4::jsonb)
     on conflict (state_key) do nothing`,
    [
      APP_STATE_KEY,
      JSON.stringify(defaultAppState().config),
      JSON.stringify(defaultAppState().bicos),
      JSON.stringify(defaultAppState().fuelPrices),
    ]
  );

  const exists = await query(`select id from ht_app_users where lower(username) = lower($1) limit 1`, ['autosystem']);
  if (exists.rowCount === 0) {
    const password = hashPassword('postgres01*');
    await query(
      `insert into ht_app_users (id, username, password_salt, password_hash, active, is_superuser, can_adjust_prices)
       values ($1, $2, $3, $4, true, true, true)`,
      [generateUUID(), 'autosystem', password.salt, password.hash]
    );
  }
}

async function authenticateUser(username, password) {
  const result = await query(
    `select * from ht_app_users where lower(username) = lower($1) and active = true limit 1`,
    [username]
  );

  if (result.rowCount === 0) return { ok: false, reason: 'Usuário ou senha inválidos.' };

  const user = result.rows[0];
  if (!verifyPassword(password, { salt: user.password_salt, hash: user.password_hash })) {
    return { ok: false, reason: 'Usuário ou senha inválidos.' };
  }

  if (!user.can_adjust_prices && !user.is_superuser) {
    return { ok: false, reason: 'Usuário sem permissão para reajuste de preços.' };
  }

  return { ok: true, user: sanitizeUser(user) };
}

async function listUsers() {
  const result = await query(`select * from ht_app_users order by lower(username) asc`);
  return result.rows.map(sanitizeUser);
}

async function createUser(session, body) {
  const username = normalizeText(body.username);
  const password = normalizeText(body.password);
  const canAdjustPrices = Boolean(body.canAdjustPrices);
  const isSuperuser = Boolean(body.isSuperuser) && Boolean(session && session.user && session.user.isSuperuser);
  const active = body.active !== false;

  if (!username || !password) {
    throw new Error('Informe usuário e senha do novo cadastro.');
  }

  const exists = await query(`select id from ht_app_users where lower(username) = lower($1) limit 1`, [username]);
  if (exists.rowCount > 0) {
    throw new Error('Já existe um usuário com esse nome.');
  }

  const passwordData = hashPassword(password);
  const inserted = await query(
    `insert into ht_app_users
      (id, username, password_salt, password_hash, active, is_superuser, can_adjust_prices)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      generateUUID(),
      username,
      passwordData.salt,
      passwordData.hash,
      active,
      isSuperuser,
      isSuperuser ? true : canAdjustPrices,
    ]
  );

  return sanitizeUser(inserted.rows[0]);
}

async function deleteUser(id) {
  const current = await query(`select * from ht_app_users where id = $1 limit 1`, [id]);
  if (current.rowCount === 0) throw new Error('Usuário não encontrado.');
  if (current.rows[0].username.toLowerCase() === 'autosystem') {
    throw new Error('O superusuário padrão não pode ser removido.');
  }
  await query(`delete from ht_app_users where id = $1`, [id]);
}

async function changeUserPassword(session, id, newPassword) {
  const password = normalizeText(newPassword);
  if (!password || password.length < 4) {
    throw new Error('Informe uma nova senha com pelo menos 4 caracteres.');
  }
  const current = await query(`select id, username from ht_app_users where id = $1 limit 1`, [id]);
  if (current.rowCount === 0) throw new Error('Usuário não encontrado.');
  const target = current.rows[0];
  const passwordData = hashPassword(password);
  await query(
    `update ht_app_users set password_salt = $1, password_hash = $2 where id = $3`,
    [passwordData.salt, passwordData.hash, id]
  );
  await query(
    `insert into ht_app_audit_logs (id, user_id, username, action_type, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      crypto.randomUUID(),
      session.user.id || null,
      session.user.username,
      'alteracao_senha',
      JSON.stringify({
        targetUserId: target.id,
        targetUsername: target.username,
      }),
    ]
  );
  return { id: target.id, username: target.username };
}

async function appendAuditEntry(session, payload) {
  await query(
    `insert into ht_app_audit_logs (id, user_id, username, action_type, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      generateUUID(),
      session.user.id || null,
      session.user.username,
      'reajuste_preco',
      JSON.stringify(payload),
    ]
  );
}

async function listAuditEntries() {
  const result = await query(
    `select id, user_id, username, action_type, payload, created_at
     from ht_app_audit_logs
     order by created_at desc
     limit 200`
  );

  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      username: row.username,
    },
    payload: row.payload,
    actionType: row.action_type,
  }));
}


async function getAppState() {
  const result = await query(
    `select config, bicos, fuel_prices, updated_by, updated_at
     from ht_app_state
     where state_key = $1
     limit 1`,
    [APP_STATE_KEY]
  );

  if (result.rowCount === 0) {
    return {
      ...defaultAppState(),
      updatedBy: null,
      updatedAt: null,
    };
  }

  const row = result.rows[0];
  const normalized = normalizeAppState({
    config: row.config,
    bicos: row.bicos,
    fuelPrices: row.fuel_prices,
  });

  return {
    ...normalized,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function saveAppState(session, payload) {
  const state = normalizeAppState(payload);
  await query(
    `insert into ht_app_state (state_key, config, bicos, fuel_prices, updated_by, updated_at)
     values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, now())
     on conflict (state_key) do update
       set config = excluded.config,
           bicos = excluded.bicos,
           fuel_prices = excluded.fuel_prices,
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [
      APP_STATE_KEY,
      JSON.stringify(state.config),
      JSON.stringify(state.bicos),
      JSON.stringify(state.fuelPrices),
      session.user.username,
    ]
  );
  return getAppState();
}

async function sendProtocolCommand(body) {
  const request = {
    host: normalizeText(body.host),
    port: Number(body.port),
    cmd: String(body.cmd || ''),
  };
  const validationError = validateRequest(request);
  if (validationError) {
    throw new Error(validationError);
  }
  const response = await forwardTcpCommand(request);
  return { response };
}

async function handleApiRequest(req, res) {
  if (req.method === 'GET' && req.url === '/api/db-status') {
    if (dbError) {
      sendJson(res, 503, { ok: false, error: `Falha ao conectar ao banco de dados: ${dbError}` });
    } else {
      sendJson(res, 200, { ok: true });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/login') {
    try {
      const body = await parseJsonBody(req);
      const username = normalizeText(body.username);
      const password = normalizeText(body.password);

      if (!username || !password) {
        sendJson(res, 400, { ok: false, error: 'Informe usuário e senha.' });
        return true;
      }

      const auth = await authenticateUser(username, password);
      if (!auth.ok) {
        sendJson(res, 403, { ok: false, error: auth.reason });
        return true;
      }

      const token = generateUUID();
      sessions.set(token, { user: auth.user, createdAt: Date.now() });
      sendJson(res, 200, { ok: true, token, user: auth.user });
      return true;
    } catch (error) {
      log('Falha na autenticação', error.message);
      sendJson(res, 500, { ok: false, error: `Erro ao autenticar: ${error.message}` });
      return true;
    }
  }

  if (req.method === 'GET' && req.url === '/api/session') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: 'Sessão não autenticada.' });
      return true;
    }
    sendJson(res, 200, { ok: true, user: session.user });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/logout') {
    const token = extractToken(req);
    if (token) sessions.delete(token);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/app-state') {
    const session = requireSession(req, res);
    if (!session) return true;
    sendJson(res, 200, { ok: true, state: await getAppState() });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/app-state') {
    const session = requireSession(req, res);
    if (!session) return true;
    try {
      const body = await parseJsonBody(req);
      const state = await saveAppState(session, body);
      sendJson(res, 200, { ok: true, state });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `Falha ao salvar configurações: ${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/protocol/send') {
    const session = requireSession(req, res);
    if (!session) return true;
    try {
      const body = await parseJsonBody(req);
      const result = await sendProtocolCommand(body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/users') {
    const session = requireSuperuser(req, res);
    if (!session) return true;
    sendJson(res, 200, { ok: true, users: await listUsers() });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/users') {
    const session = requireSuperuser(req, res);
    if (!session) return true;
    try {
      const body = await parseJsonBody(req);
      const user = await createUser(session, body);
      sendJson(res, 200, { ok: true, user });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === 'PUT' && req.url.startsWith('/api/users/') && req.url.endsWith('/password')) {
    const session = requireSuperuser(req, res);
    if (!session) return true;
    try {
      const parts = req.url.split('/');
      const id = decodeURIComponent(parts[3] || '');
      const body = await parseJsonBody(req);
      const target = await changeUserPassword(session, id, body.password);
      sendJson(res, 200, { ok: true, user: target });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/users/')) {
    const session = requireSuperuser(req, res);
    if (!session) return true;
    try {
      const id = decodeURIComponent(req.url.split('/').pop() || '');
      await deleteUser(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/audit/reajustes') {
    const session = requireSession(req, res);
    if (!session) return true;
    sendJson(res, 200, { ok: true, entries: await listAuditEntries() });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/audit/reajustes') {
    const session = requireSession(req, res);
    if (!session) return true;
    try {
      const body = await parseJsonBody(req);
      await appendAuditEntry(session, body);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `Falha ao gravar auditoria: ${error.message}` });
    }
    return true;
  }

  return false;
}

function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (await handleApiRequest(req, res)) return;

      const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (requestPath === `/${LEGACY_APP_FILE}`) {
        res.writeHead(302, { Location: `/${APP_FILE}` });
        res.end();
        return;
      }

      if (requestPath === '/' || requestPath === `/${APP_FILE}`) {
        fs.readFile(appPath, (error, data) => {
          if (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Erro ao carregar a aplicação.');
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        });
        return;
      }

      const safePath = requestPath === '/' ? APP_FILE : requestPath.replace(/^\/+/, '');
      const filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Acesso negado.');
        return;
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(error.code === 'ENOENT' ? 'Arquivo não encontrado.' : 'Erro interno.');
          return;
        }

        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        res.end(data);
      });
    } catch (error) {
      log('Erro no servidor HTTP', error.message);
      sendJson(res, 500, { ok: false, error: 'Erro interno do servidor local.' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(APP_PORT, APP_HOST, () => resolve(server));
  });
}

function openBrowser(url) {
  const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    {
      file: path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`],
    },
    { file: path.join(winDir, 'explorer.exe'), args: [url] },
    { file: path.join(winDir, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] },
    { file: 'cmd', args: ['/c', 'start', '', url], options: { shell: true } },
  ];

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.file, candidate.args, {
        cwd: rootDir,
        windowsHide: true,
        timeout: 4000,
        stdio: 'ignore',
        ...(candidate.options || {}),
      });

      if (!result.error) {
        log('Navegador acionado com sucesso', candidate.file);
        return true;
      }

      log('Tentativa de abrir navegador falhou', `${candidate.file} - ${result.error.message}`);
    } catch (error) {
      log('Tentativa de abrir navegador falhou', `${candidate.file} - ${error.message}`);
    }
  }

  log('Falha ao abrir o navegador automaticamente', url);
  return false;
}

async function main() {
  if (!fs.existsSync(appPath)) {
    throw new Error(`Arquivo da aplicação não encontrado: ${appPath}`);
  }

  ensureCommonDataDir();

  // Tenta conectar ao banco, mas não impede o servidor HTTP de subir se falhar
  try {
    await initDatabase();
    dbError = null;
  } catch (error) {
    dbError = error.message;
    log('AVISO: Falha ao conectar ao banco de dados', error.message);
    log('O servidor HTTP será iniciado mesmo assim. Verifique o server-config.json e a conectividade com o banco.');
  }

  try {
    await startProxy();
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      log('Proxy já estava em execução na porta padrão.');
    } else {
      log('AVISO: Falha ao iniciar proxy WebSocket', error.message);
    }
  }

  try {
    await startStaticServer();
    log('Servidor da aplicação iniciado', `http://${APP_HOST}:${APP_PORT}/`);
    if (dbConfig) log('Banco PostgreSQL configurado', `${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    log('Arquivo local de configuração', configFile);
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      log('Servidor HTTP da aplicação já estava em execução.');
    } else {
      log('ERRO CRÍTICO: Falha ao iniciar servidor HTTP na porta ' + APP_PORT, error.message);
      // Não relança — anota o erro e continua para abrir o navegador com a mensagem de falha
    }
  }

  const url = `http://${APP_HOST}:${APP_PORT}/`;
  log('Abrindo aplicação no navegador', url);
  const opened = openBrowser(url);
  if (!opened) {
    log('Abra manualmente no navegador', url);
  }
}

main().catch((error) => {
  log('ERRO FATAL ao iniciar a aplicação', error.message);
  try { fs.appendFileSync(logFile, `STACK: ${error.stack}\n`); } catch (e) { }
  process.exitCode = 1;
});

