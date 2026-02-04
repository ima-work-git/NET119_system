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
  status: 'waiting' | 'responding' | 'dispatched' | 'closed' | 'transferred';
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

// 他本部一覧（実際にはconfigまたはDBから取得）
const HEADQUARTERS: Record<string, { name: string; host: string; port: number }> = {
  kawasaki: { name: '川崎市消防局', host: '18.177.238.97', port: 61614 },
  yokohama: { name: '横浜市消防局', host: 'YOKOHAMA_EC2_IP', port: 61614 },
  tokyo: { name: '東京消防庁', host: '127.0.0.1', port: 61614 },
};

// 他本部へのSTOMP接続管理
const externalStompConnections = new Map<string, tls.TLSSocket>();

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

    case 'TRANSFER': {
      // 他本部への転送
      const transferMsg = msg as {
        type: string;
        incidentId: string;
        targetCode: string;
        targetName: string;
        reason: string;
        incident: unknown;
        timestamp: string;
      };

      if (incident && transferMsg.targetCode) {
        logger.info('Transfer requested', {
          incidentId: incident.id,
          targetCode: transferMsg.targetCode,
          reason: transferMsg.reason,
        });

        // STOMP経由で他本部に転送
        sendTransferToExternalHQ(transferMsg.targetCode, {
          messageType: 'TRANSFER_REQUEST',
          messageId: incident.id,
          fromOperator: OPERATOR_CODE,
          fromOperatorName: HEADQUARTERS[OPERATOR_CODE]?.name || OPERATOR_CODE,
          timestamp: transferMsg.timestamp,
          reason: transferMsg.reason,
          payload: {
            incidentId: incident.id,
            type: incident.type,
            caller: incident.caller,
            location: incident.location,
            content: incident.content,
            originalTimestamp: incident.timestamp,
            messages: incident.messages,
          },
        });

        // ステータス更新
        incident.status = 'transferred';

        // 転送元指令員に完了通知
        dispatcher.ws.send(JSON.stringify({
          type: 'TRANSFER_COMPLETE',
          incidentId: incident.id,
          targetName: transferMsg.targetName,
          timestamp: transferMsg.timestamp,
        }));

        logger.info('Transfer sent', { incidentId: incident.id, target: transferMsg.targetCode });
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

      // 転送リクエストの場合
      if (msg.messageType === 'TRANSFER_REQUEST') {
        handleTransferRequest(msg);
        return;
      }

      // 通常の通報
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

// 転送リクエストを受信した場合の処理
function handleTransferRequest(msg: {
  messageId: string;
  fromOperator: string;
  fromOperatorName: string;
  timestamp: string;
  reason: string;
  payload: {
    incidentId: string;
    type: string;
    caller: unknown;
    location: unknown;
    content: unknown;
    originalTimestamp: string;
    messages: Array<{ from: string; content: string; timestamp: string }>;
  };
}) {
  logger.info('Transfer request received', {
    incidentId: msg.messageId,
    from: msg.fromOperator,
  });

  // 新しいインシデントとして登録
  const incident: Incident = {
    id: msg.messageId,
    citizenId: `transferred-${msg.fromOperator}`,
    type: msg.payload.type,
    caller: msg.payload.caller,
    location: msg.payload.location,
    content: msg.payload.content,
    timestamp: msg.timestamp,
    status: 'waiting',
    messages: msg.payload.messages || [],
  };

  incidents.set(incident.id, incident);

  // 指令員にブロードキャスト（転送として表示）
  broadcastToDispatchers({
    type: 'TRANSFERRED',
    incidentId: incident.id,
    messageId: incident.id,
    emergencyType: incident.type,
    caller: incident.caller,
    location: incident.location,
    content: incident.content,
    timestamp: incident.timestamp,
    transferredFrom: msg.fromOperatorName,
    reason: msg.reason,
  });

  logger.info('Transfer accepted', { incidentId: incident.id });
}

// 他本部へ転送送信
function sendTransferToExternalHQ(targetCode: string, message: unknown) {
  const target = HEADQUARTERS[targetCode];
  if (!target) {
    logger.error('Unknown target HQ', { targetCode });
    return;
  }

  // 既存の接続を使用するか、新規接続
  let socket = externalStompConnections.get(targetCode);

  if (!socket || socket.destroyed) {
    logger.info('Connecting to external HQ', { targetCode, host: target.host, port: target.port });

    socket = tls.connect({
      host: target.host,
      port: target.port,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    }, () => {
      // STOMP CONNECT
      const connectFrame = serializeStompFrame({
        command: 'CONNECT',
        headers: {
          'accept-version': '1.2',
          'host': target.host,
          'heart-beat': '0,0',
        },
      });
      socket!.write(connectFrame);
    });

    let buffer = Buffer.alloc(0);
    let connected = false;

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      let idx;
      while ((idx = buffer.indexOf(0)) >= 0) {
        const frameData = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (frameData.length > 1) {
          const frame = parseStompFrame(frameData);
          if (frame?.command === 'CONNECTED' && !connected) {
            connected = true;
            logger.info('External HQ connected', { targetCode });

            // 転送メッセージを送信
            const dest = createQueueName(targetCode, 'callee');
            const sendFrame = serializeStompFrame({
              command: 'SEND',
              headers: {
                destination: dest,
                'content-type': 'application/json',
              },
              body: JSON.stringify(message),
            });
            socket!.write(sendFrame);
            logger.info('Transfer message sent', { targetCode, dest });
          }
        }
      }
    });

    socket.on('error', (err) => {
      logger.error('External HQ connection error', { targetCode, error: err.message });
    });

    socket.on('close', () => {
      externalStompConnections.delete(targetCode);
      logger.info('External HQ connection closed', { targetCode });
    });

    externalStompConnections.set(targetCode, socket);
  } else {
    // 既存接続で送信
    const dest = createQueueName(targetCode, 'callee');
    const sendFrame = serializeStompFrame({
      command: 'SEND',
      headers: {
        destination: dest,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    socket.write(sendFrame);
    logger.info('Transfer message sent via existing connection', { targetCode, dest });
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
