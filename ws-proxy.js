const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const WS_PORT = Number(process.env.WS_PROXY_PORT || 8765);
const TCP_CONNECT_TIMEOUT = Number(process.env.TCP_CONNECT_TIMEOUT_MS || 5000);
const TCP_IDLE_TIMEOUT = Number(process.env.TCP_IDLE_TIMEOUT_MS || 5000);
const TCP_RESPONSE_SETTLE_MS = Number(process.env.TCP_RESPONSE_SETTLE_MS || 200);

function log(message, extra = '') {
  const timestamp = new Date().toISOString();
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${timestamp}] ${message}${suffix}`);
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizeIncomingMessage(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    return {
      host: String(parsed.host || '').trim(),
      port: Number(parsed.port),
      cmd: String(parsed.cmd || ''),
    };
  } catch {
    return null;
  }
}

function validateRequest(data) {
  if (!data) return 'Mensagem inválida: JSON não pôde ser interpretado.';
  if (!data.host) return 'Host TCP não informado.';
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) return 'Porta TCP inválida.';
  if (!data.cmd) return 'Comando do protocolo não informado.';
  return null;
}

function forwardTcpCommand({ host, port, cmd }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks = [];
    let settled = false;
    let connected = false;
    let responseTimer = null;

    const cleanup = () => {
      if (responseTimer) clearTimeout(responseTimer);
      socket.removeAllListeners();
      socket.destroy();
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    socket.setTimeout(TCP_IDLE_TIMEOUT);

    socket.connect(port, host, () => {
      connected = true;
      log('TCP conectado ao concentrador', `${host}:${port}`);
      socket.write(cmd);
    });

    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = setTimeout(() => {
        const response = Buffer.concat(chunks).toString('utf8').trim();
        if (response) {
          finish(resolve, response);
        }
      }, TCP_RESPONSE_SETTLE_MS);
    });

    socket.on('end', () => {
      const response = Buffer.concat(chunks).toString('utf8').trim();
      finish(resolve, response);
    });

    socket.on('close', (hadError) => {
      if (settled) return;
      const response = Buffer.concat(chunks).toString('utf8').trim();
      if (response) {
        finish(resolve, response);
      } else if (hadError) {
        finish(reject, new Error('Conexão TCP encerrada com erro.'));
      } else {
        finish(reject, new Error('Conexão TCP encerrada sem resposta do concentrador.'));
      }
    });

    socket.on('timeout', () => {
      if (connected) {
        finish(reject, new Error(`Conexão TCP estabelecida com ${host}:${port}, mas o concentrador não respondeu após ${TCP_IDLE_TIMEOUT} ms.`));
      } else {
        finish(reject, new Error(`Timeout TCP ao conectar em ${host}:${port} após ${TCP_IDLE_TIMEOUT} ms.`));
      }
    });

    socket.on('error', (error) => {
      finish(reject, error);
    });
  });
}

function startProxy(options = {}) {
  const wsPort = Number(options.wsPort || WS_PORT);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Preset AutoSystem proxy ativo.\n');
  });

  const wss = new WebSocket.Server({ server });

  wss.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') return;
    log('Erro interno do servidor WebSocket', error.message);
  });

  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress || 'desconhecido';
    log('Cliente WebSocket conectado', remote);

    ws.on('message', async (raw) => {
      const request = normalizeIncomingMessage(raw);
      const validationError = validateRequest(request);

      if (validationError) {
        log('Requisição rejeitada', validationError);
        sendJson(ws, { ok: false, error: validationError });
        return;
      }

      log('Encaminhando comando TCP', `${request.host}:${request.port} ${request.cmd}`);

      try {
        const response = await Promise.race([
          forwardTcpCommand(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout de conexão TCP após ${TCP_CONNECT_TIMEOUT} ms.`)), TCP_CONNECT_TIMEOUT)),
        ]);

        log('Resposta recebida do concentrador', response);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(response);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('Falha ao encaminhar comando', message);
        sendJson(ws, { ok: false, error: message });
      }
    });

    ws.on('close', () => {
      log('Cliente WebSocket desconectado', remote);
    });

    ws.on('error', (error) => {
      log('Erro no WebSocket', error.message);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wsPort, () => {
      server.removeListener('error', reject);
      log('Proxy WebSocket/TCP iniciado', `ws://localhost:${wsPort}`);
      resolve({ server, wss, wsPort });
    });
  });
}

module.exports = { startProxy, forwardTcpCommand, validateRequest };

if (require.main === module) {
  startProxy().catch((error) => {
    log('Falha ao iniciar o proxy', error.message);
    process.exitCode = 1;
  });
}
