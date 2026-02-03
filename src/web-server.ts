/**
 * NET119 Web Server
 * フロントエンド配信 + WebSocket通信
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { logger } from './utils/logger';
import { parseStompFrame, serializeStompFrame } from './utils/stomp-parser';
import { StompFrameInfo, createQueueName } from './types/ts-1022';

const PORT = parseInt(process.env.WEB_PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const OPERATOR_CODE = process.env.OPERATOR_CODE || 'tokyo';
const BROKER_HOST = process.env.BROKER_HOST || '127.0.0.1';
const BROKER_PORT = parseInt(process.env.BROKER_PORT || '61614', 10);

// 接続管理
interface CitizenConnection {
  id: string;
  ws: WebSocket;
  incidentId?: string;
  lastActivity: number;
}

interface DispatcherConnection {
  id: string;
  ws: WebSocket;
  lastActivity: number;
}

interface Incident {
  id: string;
  citizenId: string;
  type: string;
  caller: unknown;
  location: unknown;
  content: unknown;
  timestamp: string;
  status: 'waiting' | 'responding' | 'dispatched' | 'closed';
  messages: Array<{ from: string; content: string; timestamp: string }>;
}

// 状態
const citizens = new Map<string, CitizenConnection>();
const dispatchers = new Map<string, DispatcherConnection>();
const incidents = new Map<string, Incident>();

// STOMP接続
let stompSocket: tls.TLSSocket | null = null;
let stompBuffer = Buffer.alloc(0);
let stompSubId: string | null = null;
let stompReconnectAttempts = 0;

// MIMEタイプ
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// HTTPリクエストハンドラ
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  let url = req.url || '/';

  // ルーティング
  if (url === '/' || url === '/citizen' || url === '/citizen/') {
    url = '/citizen/index.html';
  } else if (url === '/dispatcher' || url === '/dispatcher/') {
    url = '/dispatcher/index.html';
  }

  // 静的ファイル配信
  const webDir = path.join(__dirname, '..', 'web');
  const filePath = path.join(webDir, url);

  // セキュリティ: ディレクトリトラバーサル防止
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// サーバー作成
let server: http.Server | https.Server;

if (USE_HTTPS) {
  const httpsOptions = {
    cert: fs.readFileSync(config.tls.certPath),
    key: fs.readFileSync(config.tls.keyPath),
  };
  server = https.createServer(httpsOptions, handleRequest);
} else {
  server = http.createServer(handleRequest);
}

// WebSocketサーバー
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = req.url || '';
  const ip = req.socket.remoteAddress || 'unknown';

  if (url.startsWith('/ws/citizen')) {
    handleCitizenConnection(ws, ip);
  } else if (url.startsWith('/ws/dispatcher')) {
    handleDispatcherConnection(ws, ip);
  } else {
    ws.close(4000, 'Invalid endpoint');
  }
});

// 市民側WebSocket
function handleCitizenConnection(ws: WebSocket, ip: string) {
  const id = uuidv4();
  logger.info('Citizen connected', { id, ip });

  const citizen: CitizenConnection = { id, ws, lastActivity: Date.now() };
  citizens.set(id, citizen);

  ws.send(JSON.stringify({ type: 'CONNECTED', citizenId: id }));

  ws.on('message', (data) => {
    citizen.lastActivity = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      handleCitizenMessage(citizen, msg);
    } catch (e) {
      logger.error('Invalid citizen message', { error: (e as Error).message });
    }
  });

  ws.on('close', () => {
    logger.info('Citizen disconnected', { id });
    citizens.delete(id);
  });

  ws.on('error', (err) => {
    logger.error('Citizen WebSocket error', { id, error: err.message });
  });
}

// 市民メッセージ処理
function handleCitizenMessage(citizen: CitizenConnection, msg: {
  type: string;
  messageId?: string;
  emergencyType?: string;
  caller?: unknown;
  location?: unknown;
  content?: unknown;
  timestamp?: string;
}) {
  logger.debug('Citizen message', { citizenId: citizen.id, type: msg.type });

  switch (msg.type) {
    case 'EMERGENCY_REQUEST': {
      // 通報作成
      const incidentId = msg.messageId || uuidv4();
      citizen.incidentId = incidentId;

      const incident: Incident = {
        id: incidentId,
        citizenId: citizen.id,
        type: msg.emergencyType || 'RESCUE',
        caller: msg.caller,
        location: msg.location,
        content: msg.content,
        timestamp: msg.timestamp || new Date().toISOString(),
        status: 'waiting',
        messages: [],
      };

      incidents.set(incidentId, incident);

      // 指令員にブロードキャスト
      broadcastToDispatchers({
        type: 'INCIDENT',
        incidentId,
        messageId: incidentId,
        emergencyType: incident.type,
        caller: incident.caller,
        location: incident.location,
        content: incident.content,
        timestamp: incident.timestamp,
      });

      // STOMPにも送信（他事業者連携用）
      sendToStomp(incidentId, msg);

      logger.info('New incident', { incidentId, type: incident.type });
      break;
    }

    case 'MESSAGE': {
      // チャットメッセージ
      const incident = incidents.get(citizen.incidentId || '');
      if (incident) {
        incident.messages.push({
          from: 'citizen',
          content: (msg as { content?: string }).content || '',
          timestamp: msg.timestamp || new Date().toISOString(),
        });

        // 指令員にブロードキャスト
        broadcastToDispatchers({
          type: 'MESSAGE',
          incidentId: incident.id,
          content: (msg as { content?: string }).content,
          timestamp: msg.timestamp,
        });
      }
      break;
    }
  }
}

// 指令員側WebSocket
function handleDispatcherConnection(ws: WebSocket, ip: string) {
  const id = uuidv4();
  logger.info('Dispatcher connected', { id, ip });

  const dispatcher: DispatcherConnection = { id, ws, lastActivity: Date.now() };
  dispatchers.set(id, dispatcher);

  ws.send(JSON.stringify({ type: 'CONNECTED', dispatcherId: id }));

  // 既存の通報を送信
  for (const incident of incidents.values()) {
    if (incident.status !== 'closed') {
      ws.send(JSON.stringify({
        type: 'INCIDENT',
        incidentId: incident.id,
        messageId: incident.id,
        emergencyType: incident.type,
        caller: incident.caller,
        location: incident.location,
        content: incident.content,
        timestamp: incident.timestamp,
      }));
    }
  }

  ws.on('message', (data) => {
    dispatcher.lastActivity = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      handleDispatcherMessage(dispatcher, msg);
    } catch (e) {
      logger.error('Invalid dispatcher message', { error: (e as Error).message });
    }
  });

  ws.on('close', () => {
    logger.info('Dispatcher disconnected', { id });
    dispatchers.delete(id);
  });

  ws.on('error', (err) => {
    logger.error('Dispatcher WebSocket error', { id, error: err.message });
  });
}

// 指令員メッセージ処理
function handleDispatcherMessage(dispatcher: DispatcherConnection, msg: {
  type: string;
  incidentId?: string;
  content?: string;
  timestamp?: string;
}) {
  logger.debug('Dispatcher message', { dispatcherId: dispatcher.id, type: msg.type });

  const incident = incidents.get(msg.incidentId || '');

  switch (msg.type) {
    case 'ACCEPTED': {
      // 受付完了
      if (incident) {
        incident.status = 'responding';

        // 市民に通知
        const citizen = citizens.get(incident.citizenId);
        if (citizen?.ws.readyState === WebSocket.OPEN) {
          citizen.ws.send(JSON.stringify({
            type: 'ACCEPTED',
            incidentId: incident.id,
            timestamp: msg.timestamp,
          }));
        }
      }
      break;
    }

    case 'MESSAGE': {
      // チャットメッセージ
      if (incident) {
        incident.messages.push({
          from: 'dispatcher',
          content: msg.content || '',
          timestamp: msg.timestamp || new Date().toISOString(),
        });

        // 市民に送信
        const citizen = citizens.get(incident.citizenId);
        if (citizen?.ws.readyState === WebSocket.OPEN) {
          citizen.ws.send(JSON.stringify({
            type: 'MESSAGE',
            content: msg.content,
            timestamp: msg.timestamp,
          }));
        }
      }
      break;
    }

    case 'DISPATCH': {
      // 出動指令
      if (incident) {
        incident.status = 'dispatched';

        // 市民に通知
        const citizen = citizens.get(incident.citizenId);
        if (citizen?.ws.readyState === WebSocket.OPEN) {
          citizen.ws.send(JSON.stringify({
            type: 'DISPATCH',
            incidentId: incident.id,
            timestamp: msg.timestamp,
          }));
        }

        logger.info('Dispatch ordered', { incidentId: incident.id });
      }
      break;
    }

    case 'CLOSE': {
      // 対応終了
      if (incident) {
        incident.status = 'closed';
        incidents.delete(incident.id);

        // 市民に通知
        const citizen = citizens.get(incident.citizenId);
        if (citizen?.ws.readyState === WebSocket.OPEN) {
          citizen.ws.send(JSON.stringify({
            type: 'CLOSED',
            incidentId: incident.id,
            timestamp: msg.timestamp,
          }));
        }

        // 他の指令員にも通知
        broadcastToDispatchers({
          type: 'CLOSED',
          incidentId: incident.id,
          timestamp: msg.timestamp,
        });

        logger.info('Incident closed', { incidentId: incident.id });
      }
      break;
    }
  }
}

// 指令員にブロードキャスト
function broadcastToDispatchers(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const dispatcher of dispatchers.values()) {
    if (dispatcher.ws.readyState === WebSocket.OPEN) {
      dispatcher.ws.send(data);
    }
  }
}

// STOMP接続（他事業者連携用）
function connectStomp() {
  logger.info('Connecting to STOMP broker', { host: BROKER_HOST, port: BROKER_PORT });

  stompSocket = tls.connect({
    host: BROKER_HOST,
    port: BROKER_PORT,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: false,
  }, () => {
    sendStompFrame({
      command: 'CONNECT',
      headers: {
        'accept-version': '1.2',
        'host': BROKER_HOST,
        'heart-beat': '30000,30000',
      },
    });
  });

  stompSocket.on('data', (data: Buffer) => {
    stompBuffer = Buffer.concat([stompBuffer, data]);
    let idx;
    while ((idx = stompBuffer.indexOf(0)) >= 0) {
      const frameData = stompBuffer.slice(0, idx);
      stompBuffer = stompBuffer.slice(idx + 1);
      if (frameData.length > 1) {
        const frame = parseStompFrame(frameData);
        if (frame) handleStompFrame(frame);
      }
    }
  });

  stompSocket.on('close', () => {
    logger.warn('STOMP connection closed');
    scheduleStompReconnect();
  });

  stompSocket.on('error', (err) => {
    logger.error('STOMP error', { error: err.message });
  });
}

function handleStompFrame(frame: StompFrameInfo) {
  if (frame.command === 'CONNECTED') {
    stompReconnectAttempts = 0;
    stompSubId = uuidv4();
    const dest = createQueueName(OPERATOR_CODE, 'callee');
    sendStompFrame({
      command: 'SUBSCRIBE',
      headers: { id: stompSubId, destination: dest, ack: 'auto' },
    });
    logger.info('STOMP connected, subscribed', { dest });
  } else if (frame.command === 'MESSAGE' && frame.body) {
    // 他事業者からのメッセージ
    try {
      const msg = JSON.parse(frame.body);
      logger.info('STOMP message received', { type: msg.messageType });

      // 指令員にブロードキャスト
      broadcastToDispatchers({
        type: 'INCIDENT',
        incidentId: msg.messageId,
        messageId: msg.messageId,
        emergencyType: msg.payload?.content?.type || 'RESCUE',
        caller: msg.payload?.caller,
        location: msg.payload?.location,
        content: msg.payload?.content,
        timestamp: msg.timestamp,
        fromExternal: true,
      });
    } catch (e) {
      logger.error('Failed to parse STOMP message', { error: (e as Error).message });
    }
  }
}

function sendStompFrame(frame: StompFrameInfo) {
  if (stompSocket?.writable) {
    stompSocket.write(serializeStompFrame(frame));
  }
}

function sendToStomp(incidentId: string, msg: unknown) {
  // 他事業者向けにSTOMP送信（必要に応じて）
  // 今回は同一事業者内なので省略
  logger.debug('Would send to STOMP', { incidentId });
}

function scheduleStompReconnect() {
  if (stompReconnectAttempts >= 10) {
    logger.error('STOMP max reconnect attempts reached');
    return;
  }
  const delay = 5000 * Math.pow(2, stompReconnectAttempts++);
  logger.info('Scheduling STOMP reconnect', { attempt: stompReconnectAttempts, delay });
  setTimeout(connectStomp, delay);
}

// サーバー起動
logger.configure(config.logging.level, config.logging.json);

server.listen(PORT, () => {
  logger.info('Web server started', { port: PORT, https: USE_HTTPS });
  logger.info('Citizen UI: http://localhost:' + PORT + '/citizen');
  logger.info('Dispatcher UI: http://localhost:' + PORT + '/dispatcher');
});

// STOMP接続（オプション）
if (process.env.CONNECT_STOMP === 'true') {
  connectStomp();
}

// シグナルハンドラ
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  server.close();
  if (stompSocket) stompSocket.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  server.close();
  if (stompSocket) stompSocket.destroy();
  process.exit(0);
});
