/**
 * NET119 STOMP 1.2 ブローカー
 * TS-1022準拠: ポート61614、TLS、IP認証
 */

import * as tls from 'tls';
import * as fs from 'fs';
import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';

import { config } from './config';
import { logger } from './utils/logger';
import { identifyOperator, canAccessQueue, canSendToQueue } from './utils/ip-auth';
import {
  parseStompFrame,
  serializeStompFrame,
  createConnectedFrame,
  createMessageFrame,
  createErrorFrame,
  createReceiptFrame,
} from './utils/stomp-parser';
import { OperatorId, StompFrameInfo } from './types/ts-1022';

/** クライアント接続情報 */
interface ClientConnection {
  id: string;
  socket: tls.TLSSocket | net.Socket;
  operator: OperatorId | null;
  subscriptions: Map<string, string>; // subscriptionId -> destination
  heartbeatTimer?: NodeJS.Timeout;
  lastActivity: number;
}

/** キューメッセージ */
interface QueuedMessage {
  id: string;
  destination: string;
  body: string;
  contentType: string;
  timestamp: number;
}

/**
 * STOMP 1.2 ブローカー
 */
export class StompBroker {
  private server: tls.Server | net.Server | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private queues: Map<string, QueuedMessage[]> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map(); // destination -> clientIds

  constructor(private readonly useTLS: boolean = true) {
    logger.configure(config.logging.level, config.logging.json);
  }

  /** ブローカー起動 */
  async start(): Promise<void> {
    const port = config.server.stompPort;

    if (this.useTLS) {
      const tlsOptions: tls.TlsOptions = {
        cert: fs.readFileSync(config.tls.certPath),
        key: fs.readFileSync(config.tls.keyPath),
        minVersion: config.tls.minVersion,
        // クライアント証明書は不要（IP認証を使用）
        requestCert: false,
      };

      if (config.tls.caPath) {
        tlsOptions.ca = fs.readFileSync(config.tls.caPath);
      }

      this.server = tls.createServer(tlsOptions, (socket) => this.handleConnection(socket));
    } else {
      // 開発用: TLSなし
      this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    this.server.listen(port, config.server.host, () => {
      logger.info('STOMP Broker started', {
        port,
        host: config.server.host,
        tls: this.useTLS,
        publicIP: config.server.publicIP,
      });
    });

    this.server.on('error', (err) => {
      logger.error('Server error', { error: err.message });
    });

    // 定期的なヘルスチェック
    setInterval(() => this.healthCheck(), 30000);
  }

  /** 接続停止 */
  async stop(): Promise<void> {
    // 全クライアント切断
    for (const client of this.clients.values()) {
      this.disconnectClient(client, 'Server shutdown');
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('STOMP Broker stopped');
          resolve();
        });
      });
    }
  }

  /** 接続ハンドラ */
  private handleConnection(socket: tls.TLSSocket | net.Socket): void {
    const remoteAddress = socket.remoteAddress || 'unknown';
    const clientId = uuidv4();

    logger.info('New connection', { clientId, remoteAddress });

    // IP認証
    const operator = identifyOperator(remoteAddress, config.operators);
    if (!operator) {
      logger.warn('Connection rejected: unknown IP', { remoteAddress });
      socket.destroy();
      return;
    }

    const client: ClientConnection = {
      id: clientId,
      socket,
      operator,
      subscriptions: new Map(),
      lastActivity: Date.now(),
    };

    this.clients.set(clientId, client);

    let buffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      client.lastActivity = Date.now();
      buffer = Buffer.concat([buffer, data]);

      // NULL文字でフレーム分割
      let nullIndex: number;
      while ((nullIndex = buffer.indexOf(0)) >= 0) {
        const frameData = buffer.slice(0, nullIndex);
        buffer = buffer.slice(nullIndex + 1);

        const frame = parseStompFrame(frameData);
        if (frame) {
          this.handleFrame(client, frame);
        }
      }

      // バッファサイズ制限
      if (buffer.length > config.stomp.maxMessageSize) {
        this.sendError(client, 'Message too large');
        this.disconnectClient(client, 'Message size exceeded');
      }
    });

    socket.on('close', () => {
      this.handleDisconnect(client);
    });

    socket.on('error', (err) => {
      logger.error('Socket error', { clientId, error: err.message });
      this.handleDisconnect(client);
    });
  }

  /** フレーム処理 */
  private handleFrame(client: ClientConnection, frame: StompFrameInfo): void {
    logger.debug('Received frame', {
      clientId: client.id,
      command: frame.command,
      headers: frame.headers,
    });

    switch (frame.command) {
      case 'CONNECT':
      case 'STOMP':
        this.handleConnect(client, frame);
        break;
      case 'SEND':
        this.handleSend(client, frame);
        break;
      case 'SUBSCRIBE':
        this.handleSubscribe(client, frame);
        break;
      case 'UNSUBSCRIBE':
        this.handleUnsubscribe(client, frame);
        break;
      case 'DISCONNECT':
        this.handleDisconnectFrame(client, frame);
        break;
      case 'ACK':
      case 'NACK':
        // ACK/NACKは受け取るが、シンプルな実装のため処理は最小限
        this.sendReceiptIfRequested(client, frame);
        break;
      default:
        this.sendError(client, `Unknown command: ${frame.command}`);
    }
  }

  /** CONNECT処理 */
  private handleConnect(client: ClientConnection, frame: StompFrameInfo): void {
    const acceptVersion = frame.headers['accept-version'];
    if (!acceptVersion?.includes('1.2')) {
      this.sendError(client, 'Supported protocol version is 1.2');
      return;
    }

    // TS-1022: host ヘッダ必須
    const host = frame.headers['host'];
    if (!host) {
      this.sendError(client, 'host header is required');
      return;
    }

    // TS-1022: login/passcodeは使用しない（IP認証）
    if (frame.headers['login'] || frame.headers['passcode']) {
      logger.warn('Client sent login/passcode (ignored, using IP auth)', {
        clientId: client.id,
      });
    }

    // ハートビート設定
    const clientHeartbeat = frame.headers['heart-beat'] || '0,0';
    const [clientSend, clientReceive] = clientHeartbeat.split(',').map(Number);
    const serverHeartbeat = config.stomp.heartbeatInterval;

    // ハートビートネゴシエーション
    const sendInterval = Math.max(serverHeartbeat, clientReceive);
    const receiveInterval = Math.max(serverHeartbeat, clientSend);

    if (sendInterval > 0) {
      client.heartbeatTimer = setInterval(() => {
        if (client.socket.writable) {
          client.socket.write(Buffer.from('\n'));
        }
      }, sendInterval);
    }

    const connectedFrame = createConnectedFrame(
      client.id,
      `${serverHeartbeat},${serverHeartbeat}`
    );

    this.sendFrame(client, connectedFrame);

    logger.info('Client connected', {
      clientId: client.id,
      operator: client.operator?.code,
      host,
    });
  }

  /** SEND処理 */
  private handleSend(client: ClientConnection, frame: StompFrameInfo): void {
    const destination = frame.headers['destination'];
    if (!destination) {
      this.sendError(client, 'destination header is required');
      return;
    }

    // TS-1022: transactionは禁止
    if (frame.headers['transaction']) {
      this.sendError(client, 'transaction is not supported');
      return;
    }

    // 宛先キューのアクセスチェック
    if (client.operator && !canSendToQueue(client.operator, destination)) {
      this.sendError(client, 'Access denied to destination');
      return;
    }

    const contentType = frame.headers['content-type'] || 'application/json';

    // TS-1022: content-type は application/json
    if (contentType !== 'application/json') {
      logger.warn('Non-JSON content-type', { contentType, clientId: client.id });
    }

    const message: QueuedMessage = {
      id: uuidv4(),
      destination,
      body: frame.body || '',
      contentType,
      timestamp: Date.now(),
    };

    // キューに追加
    if (!this.queues.has(destination)) {
      this.queues.set(destination, []);
    }
    this.queues.get(destination)!.push(message);

    // サブスクライバーに配信
    this.deliverMessage(message);

    // RECEIPTが要求されていれば送信
    this.sendReceiptIfRequested(client, frame);

    logger.debug('Message queued', {
      messageId: message.id,
      destination,
      from: client.operator?.code,
    });
  }

  /** SUBSCRIBE処理 */
  private handleSubscribe(client: ClientConnection, frame: StompFrameInfo): void {
    const destination = frame.headers['destination'];
    const subscriptionId = frame.headers['id'];

    if (!destination || !subscriptionId) {
      this.sendError(client, 'destination and id headers are required');
      return;
    }

    // TS-1022: 自分のキューのみSUBSCRIBE可能
    if (client.operator && !canAccessQueue(client.operator, destination)) {
      this.sendError(client, 'Can only subscribe to own queues');
      return;
    }

    // サブスクリプション登録
    client.subscriptions.set(subscriptionId, destination);

    if (!this.subscriptions.has(destination)) {
      this.subscriptions.set(destination, new Set());
    }
    this.subscriptions.get(destination)!.add(client.id);

    // 未配信メッセージがあれば配信
    const pendingMessages = this.queues.get(destination) || [];
    for (const message of pendingMessages) {
      this.sendMessage(client, message, subscriptionId);
    }
    // 配信済みメッセージをクリア
    this.queues.set(destination, []);

    this.sendReceiptIfRequested(client, frame);

    logger.info('Subscription created', {
      clientId: client.id,
      destination,
      subscriptionId,
    });
  }

  /** UNSUBSCRIBE処理 */
  private handleUnsubscribe(client: ClientConnection, frame: StompFrameInfo): void {
    const subscriptionId = frame.headers['id'];
    if (!subscriptionId) {
      this.sendError(client, 'id header is required');
      return;
    }

    const destination = client.subscriptions.get(subscriptionId);
    if (destination) {
      client.subscriptions.delete(subscriptionId);
      this.subscriptions.get(destination)?.delete(client.id);
    }

    this.sendReceiptIfRequested(client, frame);
  }

  /** DISCONNECT処理 */
  private handleDisconnectFrame(client: ClientConnection, frame: StompFrameInfo): void {
    this.sendReceiptIfRequested(client, frame);
    this.disconnectClient(client, 'Client disconnect');
  }

  /** メッセージ配信 */
  private deliverMessage(message: QueuedMessage): void {
    const subscribers = this.subscriptions.get(message.destination);
    if (!subscribers || subscribers.size === 0) {
      logger.debug('No subscribers for destination', { destination: message.destination });
      return;
    }

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      // このクライアントのサブスクリプションIDを探す
      for (const [subId, dest] of client.subscriptions) {
        if (dest === message.destination) {
          this.sendMessage(client, message, subId);
          break;
        }
      }
    }
  }

  /** メッセージ送信 */
  private sendMessage(client: ClientConnection, message: QueuedMessage, subscriptionId: string): void {
    const frame = createMessageFrame(
      message.destination,
      message.id,
      subscriptionId,
      message.body,
      message.contentType
    );
    this.sendFrame(client, frame);
  }

  /** フレーム送信 */
  private sendFrame(client: ClientConnection, frame: StompFrameInfo): void {
    if (client.socket.writable) {
      const data = serializeStompFrame(frame);
      client.socket.write(data);

      logger.debug('Sent frame', {
        clientId: client.id,
        command: frame.command,
      });
    }
  }

  /** エラー送信 */
  private sendError(client: ClientConnection, message: string, details?: string): void {
    const frame = createErrorFrame(message, details);
    this.sendFrame(client, frame);
  }

  /** RECEIPT送信（要求時のみ） */
  private sendReceiptIfRequested(client: ClientConnection, frame: StompFrameInfo): void {
    const receiptId = frame.headers['receipt'];
    if (receiptId) {
      const receiptFrame = createReceiptFrame(receiptId);
      this.sendFrame(client, receiptFrame);
    }
  }

  /** クライアント切断処理 */
  private disconnectClient(client: ClientConnection, reason: string): void {
    logger.info('Client disconnected', {
      clientId: client.id,
      operator: client.operator?.code,
      reason,
    });

    // ハートビートタイマー停止
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
    }

    // サブスクリプション解除
    for (const [, destination] of client.subscriptions) {
      this.subscriptions.get(destination)?.delete(client.id);
    }

    // クライアントリストから削除
    this.clients.delete(client.id);

    // ソケットクローズ
    if (!client.socket.destroyed) {
      client.socket.destroy();
    }
  }

  /** 切断ハンドラ */
  private handleDisconnect(client: ClientConnection): void {
    this.disconnectClient(client, 'Connection closed');
  }

  /** ヘルスチェック */
  private healthCheck(): void {
    const now = Date.now();
    const timeout = config.stomp.heartbeatInterval * 3;

    for (const client of this.clients.values()) {
      if (now - client.lastActivity > timeout) {
        logger.warn('Client heartbeat timeout', { clientId: client.id });
        this.disconnectClient(client, 'Heartbeat timeout');
      }
    }

    logger.debug('Health check', {
      clients: this.clients.size,
      queues: this.queues.size,
      subscriptions: this.subscriptions.size,
    });
  }

  /** 統計情報 */
  getStats(): Record<string, unknown> {
    return {
      clients: this.clients.size,
      queues: this.queues.size,
      subscriptions: this.subscriptions.size,
      operators: Array.from(this.clients.values())
        .filter(c => c.operator)
        .map(c => c.operator!.code),
    };
  }
}

// メイン実行
if (require.main === module) {
  const useTLS = process.env.DISABLE_TLS !== 'true';
  const broker = new StompBroker(useTLS);

  broker.start().catch((err) => {
    logger.error('Failed to start broker', { error: err.message });
    process.exit(1);
  });

  // グレースフルシャットダウン
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM');
    await broker.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT');
    await broker.stop();
    process.exit(0);
  });
}
