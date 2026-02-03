/**
 * NET119 Callee Gateway
 * 受信側（指令センター側）のゲートウェイ
 * TS-1022 準拠 + WSS端末接続対応
 *
 * 構成:
 * [インターネット] <-- STOMP/TLS --> [Callee Gateway] <-- WSS --> [指令センター端末]
 *
 * 指令センター端末は外部からの接続を受け付けない（セキュリティ要件）
 * 端末からGatewayへoutbound WSS接続を張り、メッセージを中継
 */

import * as tls from 'tls';
import * as https from 'https';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import { config } from './config';
import { logger } from './utils/logger';
import {
  parseStompFrame,
  serializeStompFrame,
} from './utils/stomp-parser';
import {
  ConnectionState,
  NET119Request,
  NET119Response,
  StompFrameInfo,
  createQueueName,
} from './types/ts-1022';

interface CalleeGatewayOptions {
  /** 自事業者コード */
  operatorCode: string;
  /** STOMPブローカーホスト */
  brokerHost: string;
  /** STOMPブローカーポート */
  brokerPort?: number;
  /** WSS待受ポート（端末向け） */
  wssPort?: number;
  /** TLS設定 */
  tls?: {
    ca?: string;
    cert: string;
    key: string;
  };
}

/** 端末接続情報 */
interface TerminalConnection {
  id: string;
  ws: WebSocket;
  lastActivity: number;
}

/**
 * Callee Gateway
 * 指令センター側のゲートウェイ
 */
export class CalleeGateway extends EventEmitter {
  // STOMP接続
  private stompSocket: tls.TLSSocket | null = null;
  private stompState: ConnectionState = 'DISCONNECTED';
  private stompSessionId: string | null = null;
  private stompSubscriptionId: string | null = null;
  private stompBuffer = Buffer.alloc(0);
  private stompReconnectAttempts = 0;
  private stompReconnectTimer: NodeJS.Timeout | null = null;
  private stompHeartbeatTimer: NodeJS.Timeout | null = null;

  // WSS サーバ（端末向け）
  private wssServer: https.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private terminals: Map<string, TerminalConnection> = new Map();

  // メッセージ処理
  private pendingResponses: Map<string, NET119Request> = new Map();

  constructor(private readonly options: CalleeGatewayOptions) {
    super();
    logger.configure(config.logging.level, config.logging.json);
  }

  /** ゲートウェイ起動 */
  async start(): Promise<void> {
    // WSSサーバ起動（端末向け）
    await this.startWSSServer();

    // STOMPブローカー接続
    await this.connectToStomp();
  }

  /** ゲートウェイ停止 */
  async stop(): Promise<void> {
    // STOMP切断
    await this.disconnectStomp();

    // 端末切断
    for (const terminal of this.terminals.values()) {
      terminal.ws.close(1000, 'Gateway shutdown');
    }
    this.terminals.clear();

    // WSSサーバ停止
    if (this.wsServer) {
      this.wsServer.close();
    }
    if (this.wssServer) {
      return new Promise((resolve) => {
        this.wssServer!.close(() => {
          logger.info('WSS server stopped');
          resolve();
        });
      });
    }
  }

  // ========================================
  // WSS サーバ（指令センター端末向け）
  // ========================================

  /** WSSサーバ起動 */
  private async startWSSServer(): Promise<void> {
    const port = this.options.wssPort || config.server.wssPort;

    const tlsOptions: https.ServerOptions = {
      cert: fs.readFileSync(this.options.tls!.cert),
      key: fs.readFileSync(this.options.tls!.key),
      minVersion: 'TLSv1.2',
    };

    this.wssServer = https.createServer(tlsOptions);

    this.wsServer = new WebSocketServer({
      server: this.wssServer,
      path: '/ws/terminal',
    });

    this.wsServer.on('connection', (ws, req) => {
      this.handleTerminalConnection(ws, req.socket.remoteAddress || 'unknown');
    });

    return new Promise((resolve) => {
      this.wssServer!.listen(port, () => {
        logger.info('WSS server started for terminals', { port });
        resolve();
      });
    });
  }

  /** 端末接続ハンドラ */
  private handleTerminalConnection(ws: WebSocket, remoteAddress: string): void {
    const terminalId = uuidv4();

    logger.info('Terminal connected', { terminalId, remoteAddress });

    const terminal: TerminalConnection = {
      id: terminalId,
      ws,
      lastActivity: Date.now(),
    };

    this.terminals.set(terminalId, terminal);

    // 接続確認メッセージ
    this.sendToTerminal(terminal, {
      type: 'CONNECTED',
      terminalId,
      operatorCode: this.options.operatorCode,
      timestamp: new Date().toISOString(),
    });

    ws.on('message', (data) => {
      terminal.lastActivity = Date.now();
      this.handleTerminalMessage(terminal, data.toString());
    });

    ws.on('close', () => {
      logger.info('Terminal disconnected', { terminalId });
      this.terminals.delete(terminalId);
    });

    ws.on('error', (err) => {
      logger.error('Terminal WebSocket error', { terminalId, error: err.message });
    });

    // Ping/Pong
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('pong', () => {
      terminal.lastActivity = Date.now();
    });
  }

  /** 端末からのメッセージ処理 */
  private handleTerminalMessage(terminal: TerminalConnection, data: string): void {
    try {
      const message = JSON.parse(data);

      logger.debug('Received from terminal', {
        terminalId: terminal.id,
        type: message.type,
      });

      switch (message.type) {
        case 'RESPONSE':
          this.handleTerminalResponse(message);
          break;
        case 'HEARTBEAT':
          this.sendToTerminal(terminal, {
            type: 'HEARTBEAT_ACK',
            timestamp: new Date().toISOString(),
          });
          break;
        default:
          logger.warn('Unknown message type from terminal', {
            terminalId: terminal.id,
            type: message.type,
          });
      }
    } catch (err) {
      logger.error('Failed to parse terminal message', {
        terminalId: terminal.id,
        error: (err as Error).message,
      });
    }
  }

  /** 端末からのレスポンス処理 */
  private handleTerminalResponse(message: {
    type: string;
    requestMessageId: string;
    resultCode: string;
    payload?: unknown;
  }): void {
    const originalRequest = this.pendingResponses.get(message.requestMessageId);
    if (!originalRequest) {
      logger.warn('No pending request for response', {
        requestMessageId: message.requestMessageId,
      });
      return;
    }

    this.pendingResponses.delete(message.requestMessageId);

    // TS-1022: Via.destination にレスポンスを返す
    const responseDestination = originalRequest.via.destination;

    const response: NET119Response = {
      requestMessageId: message.requestMessageId,
      messageId: uuidv4(),
      messageType: this.getResponseType(originalRequest.messageType),
      resultCode: message.resultCode as NET119Response['resultCode'],
      timestamp: new Date().toISOString(),
      payload: message.payload,
    };

    this.sendToStomp(responseDestination, response);

    logger.info('Response sent to STOMP', {
      requestMessageId: message.requestMessageId,
      destination: responseDestination,
      resultCode: response.resultCode,
    });
  }

  /** リクエストタイプに対応するレスポンスタイプを取得 */
  private getResponseType(requestType: string): NET119Response['messageType'] {
    const mapping: Record<string, NET119Response['messageType']> = {
      'EMERGENCY_REQUEST': 'EMERGENCY_RESPONSE',
      'STATUS_UPDATE': 'STATUS_ACK',
      'HEARTBEAT': 'HEARTBEAT_ACK',
    };
    return mapping[requestType] || 'EMERGENCY_RESPONSE';
  }

  /** 端末にメッセージ送信 */
  private sendToTerminal(terminal: TerminalConnection, message: unknown): void {
    if (terminal.ws.readyState === WebSocket.OPEN) {
      terminal.ws.send(JSON.stringify(message));
    }
  }

  /** 全端末にブロードキャスト */
  private broadcastToTerminals(message: unknown): void {
    const data = JSON.stringify(message);
    for (const terminal of this.terminals.values()) {
      if (terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.send(data);
      }
    }
  }

  // ========================================
  // STOMP 接続（ブローカー向け）
  // ========================================

  /** STOMPブローカー接続 */
  private async connectToStomp(): Promise<void> {
    if (this.stompState !== 'DISCONNECTED') {
      return;
    }

    this.stompState = 'CONNECTING';

    return new Promise((resolve, reject) => {
      const port = this.options.brokerPort || config.server.stompPort;
      const host = this.options.brokerHost;

      const tlsOptions: tls.ConnectionOptions = {
        host,
        port,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      };

      if (this.options.tls?.ca) {
        tlsOptions.ca = fs.readFileSync(this.options.tls.ca);
      }

      logger.info('Connecting to STOMP broker', { host, port });

      this.stompSocket = tls.connect(tlsOptions, () => {
        this.sendStompConnectFrame();
      });

      this.stompSocket.on('data', (data: Buffer) => this.handleStompData(data));

      this.stompSocket.on('close', () => {
        this.handleStompDisconnect();
      });

      this.stompSocket.on('error', (err) => {
        logger.error('STOMP socket error', { error: err.message });
        if (this.stompState === 'CONNECTING') {
          reject(err);
        }
        this.handleStompDisconnect();
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error('STOMP connection timeout'));
        this.disconnectStomp();
      }, config.stomp.connectTimeout);

      this.once('stompConnected', () => {
        clearTimeout(connectTimeout);
        resolve();
      });
    });
  }

  /** STOMP切断 */
  private async disconnectStomp(): Promise<void> {
    if (this.stompReconnectTimer) {
      clearTimeout(this.stompReconnectTimer);
      this.stompReconnectTimer = null;
    }

    if (this.stompHeartbeatTimer) {
      clearInterval(this.stompHeartbeatTimer);
      this.stompHeartbeatTimer = null;
    }

    if (this.stompSocket && this.stompState === 'CONNECTED') {
      this.sendStompFrame({
        command: 'DISCONNECT',
        headers: { 'receipt': 'disconnect-receipt' },
      });
    }

    if (this.stompSocket) {
      this.stompSocket.destroy();
      this.stompSocket = null;
    }

    this.stompState = 'DISCONNECTED';
  }

  /** STOMPデータ受信 */
  private handleStompData(data: Buffer): void {
    this.stompBuffer = Buffer.concat([this.stompBuffer, data]);

    let nullIndex: number;
    while ((nullIndex = this.stompBuffer.indexOf(0)) >= 0) {
      const frameData = this.stompBuffer.slice(0, nullIndex);
      this.stompBuffer = this.stompBuffer.slice(nullIndex + 1);

      if (frameData.length === 0 || (frameData.length === 1 && frameData[0] === 0x0a)) {
        continue;
      }

      const frame = parseStompFrame(frameData);
      if (frame) {
        this.handleStompFrame(frame);
      }
    }
  }

  /** STOMPフレーム処理 */
  private handleStompFrame(frame: StompFrameInfo): void {
    logger.debug('STOMP frame received', { command: frame.command });

    switch (frame.command) {
      case 'CONNECTED':
        this.handleStompConnected(frame);
        break;
      case 'MESSAGE':
        this.handleStompMessage(frame);
        break;
      case 'RECEIPT':
        logger.debug('STOMP receipt', { receiptId: frame.headers['receipt-id'] });
        break;
      case 'ERROR':
        logger.error('STOMP error', {
          message: frame.headers['message'],
          body: frame.body,
        });
        break;
    }
  }

  /** STOMP CONNECTED処理 */
  private handleStompConnected(frame: StompFrameInfo): void {
    this.stompSessionId = frame.headers['session'];
    this.stompState = 'CONNECTED';
    this.stompReconnectAttempts = 0;

    logger.info('STOMP connected', { sessionId: this.stompSessionId });

    // ハートビート
    const heartbeat = frame.headers['heart-beat'];
    if (heartbeat) {
      const [, serverReceive] = heartbeat.split(',').map(Number);
      if (serverReceive > 0) {
        this.stompHeartbeatTimer = setInterval(() => {
          if (this.stompSocket?.writable) {
            this.stompSocket.write(Buffer.from('\n'));
          }
        }, serverReceive);
      }
    }

    // 自分のキューにSUBSCRIBE
    this.stompSubscriptionId = uuidv4();
    const destination = createQueueName(this.options.operatorCode, 'callee');

    this.sendStompFrame({
      command: 'SUBSCRIBE',
      headers: {
        'id': this.stompSubscriptionId,
        'destination': destination,
        'ack': 'auto',
      },
    });

    logger.info('Subscribed to queue', { destination });

    this.emit('stompConnected');
  }

  /** STOMP MESSAGE処理 */
  private handleStompMessage(frame: StompFrameInfo): void {
    try {
      const message = JSON.parse(frame.body || '{}') as NET119Request;

      logger.info('STOMP message received', {
        messageId: message.messageId,
        type: message.messageType,
      });

      // 端末に転送するためペンディングリストに追加
      this.pendingResponses.set(message.messageId, message);

      // 全端末にブロードキャスト
      this.broadcastToTerminals({
        type: 'REQUEST',
        messageId: message.messageId,
        messageType: message.messageType,
        via: message.via,
        timestamp: message.timestamp,
        payload: message.payload,
      });

      // レスポンスタイムアウト
      setTimeout(() => {
        if (this.pendingResponses.has(message.messageId)) {
          this.pendingResponses.delete(message.messageId);

          // タイムアウトレスポンスを送信
          const response: NET119Response = {
            requestMessageId: message.messageId,
            messageId: uuidv4(),
            messageType: this.getResponseType(message.messageType),
            resultCode: 'TIMEOUT',
            timestamp: new Date().toISOString(),
          };

          this.sendToStomp(message.via.destination, response);

          logger.warn('Request timed out', { messageId: message.messageId });
        }
      }, 60000); // 60秒タイムアウト

    } catch (err) {
      logger.error('Failed to process STOMP message', {
        error: (err as Error).message,
      });
    }
  }

  /** STOMP切断処理 */
  private handleStompDisconnect(): void {
    if (this.stompHeartbeatTimer) {
      clearInterval(this.stompHeartbeatTimer);
      this.stompHeartbeatTimer = null;
    }

    this.stompSocket = null;
    this.stompSessionId = null;
    this.stompSubscriptionId = null;

    if (this.stompState === 'CONNECTED' || this.stompState === 'CONNECTING') {
      this.stompState = 'RECONNECTING';
      this.scheduleStompReconnect();
    } else {
      this.stompState = 'DISCONNECTED';
    }
  }

  /** STOMP再接続スケジュール */
  private scheduleStompReconnect(): void {
    if (this.stompReconnectAttempts >= config.stomp.maxReconnectAttempts) {
      logger.error('Max STOMP reconnect attempts reached');
      this.stompState = 'ERROR';
      return;
    }

    const delay = config.stomp.reconnectInterval * Math.pow(2, this.stompReconnectAttempts);
    this.stompReconnectAttempts++;

    logger.info('Scheduling STOMP reconnect', {
      attempt: this.stompReconnectAttempts,
      delay,
    });

    this.stompReconnectTimer = setTimeout(async () => {
      this.stompState = 'DISCONNECTED';
      try {
        await this.connectToStomp();
      } catch (err) {
        logger.error('STOMP reconnect failed', { error: (err as Error).message });
      }
    }, delay);
  }

  /** STOMP CONNECTフレーム送信 */
  private sendStompConnectFrame(): void {
    this.sendStompFrame({
      command: 'CONNECT',
      headers: {
        'accept-version': '1.2',
        'host': this.options.brokerHost,
        'heart-beat': `${config.stomp.heartbeatInterval},${config.stomp.heartbeatInterval}`,
      },
    });
  }

  /** STOMPフレーム送信 */
  private sendStompFrame(frame: StompFrameInfo): void {
    if (this.stompSocket?.writable) {
      const data = serializeStompFrame(frame);
      this.stompSocket.write(data);
    }
  }

  /** STOMPキューにメッセージ送信 */
  private sendToStomp(destination: string, message: unknown): void {
    const body = JSON.stringify(message);

    this.sendStompFrame({
      command: 'SEND',
      headers: {
        'destination': destination,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body, 'utf-8').toString(),
      },
      body,
    });
  }

  /** 統計情報 */
  getStats(): Record<string, unknown> {
    return {
      stomp: {
        state: this.stompState,
        sessionId: this.stompSessionId,
        reconnectAttempts: this.stompReconnectAttempts,
      },
      terminals: {
        connected: this.terminals.size,
        ids: Array.from(this.terminals.keys()),
      },
      pendingResponses: this.pendingResponses.size,
    };
  }
}

// メイン実行
if (require.main === module) {
  const gateway = new CalleeGateway({
    operatorCode: process.env.OPERATOR_CODE || 'tokyo',
    brokerHost: process.env.BROKER_HOST || 'localhost',
    brokerPort: parseInt(process.env.BROKER_PORT || '61614', 10),
    wssPort: parseInt(process.env.WSS_PORT || '443', 10),
    tls: {
      cert: process.env.TLS_CERT_PATH || '/etc/net119/certs/server.crt',
      key: process.env.TLS_KEY_PATH || '/etc/net119/certs/server.key',
      ca: process.env.TLS_CA_PATH,
    },
  });

  gateway.start().then(() => {
    logger.info('Callee Gateway started');
  }).catch((err) => {
    logger.error('Failed to start Callee Gateway', { error: err.message });
    process.exit(1);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM');
    await gateway.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT');
    await gateway.stop();
    process.exit(0);
  });
}
