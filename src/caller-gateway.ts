/**
 * NET119 Caller Gateway
 * 発信側（通報受付事業者側）のSTOMPクライアント
 * TS-1022 インターフェイスB準拠
 */

import * as tls from 'tls';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import { config } from './config';
import { logger } from './utils/logger';
import {
  parseStompFrame,
  serializeStompFrame,
  createErrorFrame,
} from './utils/stomp-parser';
import {
  ConnectionState,
  NET119Request,
  NET119Response,
  NET119MessageType,
  StompFrameInfo,
  createVia,
  createQueueName,
} from './types/ts-1022';

interface CallerGatewayOptions {
  /** 自事業者コード */
  operatorCode: string;
  /** 接続先ブローカーホスト */
  brokerHost: string;
  /** 接続先ブローカーポート */
  brokerPort?: number;
  /** TLS使用 */
  useTLS?: boolean;
  /** 証明書設定 */
  tls?: {
    ca?: string;
    cert?: string;
    key?: string;
  };
}

/**
 * Caller Gateway
 * 通報発信側のSTOMPクライアント
 */
export class CallerGateway extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, {
    resolve: (response: NET119Response) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private subscriptionId: string | null = null;
  private buffer = Buffer.alloc(0);

  constructor(private readonly options: CallerGatewayOptions) {
    super();
    logger.configure(config.logging.level, config.logging.json);
  }

  /** 接続開始 */
  async connect(): Promise<void> {
    if (this.state !== 'DISCONNECTED') {
      throw new Error(`Cannot connect from state: ${this.state}`);
    }

    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);

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
      if (this.options.tls?.cert) {
        tlsOptions.cert = fs.readFileSync(this.options.tls.cert);
      }
      if (this.options.tls?.key) {
        tlsOptions.key = fs.readFileSync(this.options.tls.key);
      }

      logger.info('Connecting to broker', { host, port });

      this.socket = tls.connect(tlsOptions, () => {
        logger.info('TLS connection established');
        this.sendConnectFrame();
      });

      this.socket.on('data', (data: Buffer) => this.handleData(data));

      this.socket.on('close', () => {
        this.handleDisconnect();
      });

      this.socket.on('error', (err) => {
        logger.error('Socket error', { error: err.message });
        if (this.state === 'CONNECTING') {
          reject(err);
        }
        this.handleDisconnect();
      });

      // CONNECTED フレームを待つ
      const connectTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.disconnect();
      }, config.stomp.connectTimeout);

      this.once('connected', () => {
        clearTimeout(connectTimeout);
        resolve();
      });
    });
  }

  /** 切断 */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.socket && this.state === 'CONNECTED') {
      // DISCONNECT フレーム送信
      this.sendFrame({
        command: 'DISCONNECT',
        headers: {
          'receipt': 'disconnect-receipt',
        },
      });
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  }

  /** 緊急通報リクエスト送信 */
  async sendEmergencyRequest(
    targetOperator: string,
    payload: unknown,
    timeoutMs: number = 30000
  ): Promise<NET119Response> {
    if (this.state !== 'CONNECTED') {
      throw new Error('Not connected');
    }

    const messageId = uuidv4();
    const request: NET119Request = {
      messageId,
      messageType: 'EMERGENCY_REQUEST',
      via: createVia(this.options.operatorCode, 'caller'),
      timestamp: new Date().toISOString(),
      payload,
    };

    const destination = createQueueName(targetOperator, 'callee');

    return this.sendRequest(destination, request, timeoutMs);
  }

  /** 状態更新送信 */
  async sendStatusUpdate(
    targetOperator: string,
    payload: unknown,
    timeoutMs: number = 10000
  ): Promise<NET119Response> {
    if (this.state !== 'CONNECTED') {
      throw new Error('Not connected');
    }

    const messageId = uuidv4();
    const request: NET119Request = {
      messageId,
      messageType: 'STATUS_UPDATE',
      via: createVia(this.options.operatorCode, 'caller'),
      timestamp: new Date().toISOString(),
      payload,
    };

    const destination = createQueueName(targetOperator, 'callee');

    return this.sendRequest(destination, request, timeoutMs);
  }

  /** リクエスト送信（レスポンス待ち） */
  private async sendRequest(
    destination: string,
    request: NET119Request,
    timeoutMs: number
  ): Promise<NET119Response> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.messageId);
        reject(new Error(`Request timeout: ${request.messageId}`));
      }, timeoutMs);

      this.pendingRequests.set(request.messageId, { resolve, reject, timeout });

      this.sendFrame({
        command: 'SEND',
        headers: {
          'destination': destination,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(JSON.stringify(request), 'utf-8').toString(),
        },
        body: JSON.stringify(request),
      });

      logger.info('Request sent', {
        messageId: request.messageId,
        type: request.messageType,
        destination,
      });
    });
  }

  /** 受信データ処理 */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    let nullIndex: number;
    while ((nullIndex = this.buffer.indexOf(0)) >= 0) {
      const frameData = this.buffer.slice(0, nullIndex);
      this.buffer = this.buffer.slice(nullIndex + 1);

      // ハートビート（改行のみ）
      if (frameData.length === 0 || (frameData.length === 1 && frameData[0] === 0x0a)) {
        continue;
      }

      const frame = parseStompFrame(frameData);
      if (frame) {
        this.handleFrame(frame);
      }
    }
  }

  /** フレーム処理 */
  private handleFrame(frame: StompFrameInfo): void {
    logger.debug('Received frame', { command: frame.command });

    switch (frame.command) {
      case 'CONNECTED':
        this.handleConnected(frame);
        break;
      case 'MESSAGE':
        this.handleMessage(frame);
        break;
      case 'RECEIPT':
        this.handleReceipt(frame);
        break;
      case 'ERROR':
        this.handleError(frame);
        break;
    }
  }

  /** CONNECTED処理 */
  private handleConnected(frame: StompFrameInfo): void {
    this.sessionId = frame.headers['session'];
    this.state = 'CONNECTED';
    this.reconnectAttempts = 0;

    logger.info('Connected to broker', {
      sessionId: this.sessionId,
      version: frame.headers['version'],
    });

    // ハートビート開始
    const heartbeat = frame.headers['heart-beat'];
    if (heartbeat) {
      const [, serverReceive] = heartbeat.split(',').map(Number);
      if (serverReceive > 0) {
        this.heartbeatTimer = setInterval(() => {
          if (this.socket?.writable) {
            this.socket.write(Buffer.from('\n'));
          }
        }, serverReceive);
      }
    }

    // 自分のキューにSUBSCRIBE
    this.subscribeToOwnQueue();

    this.emit('connected');
    this.emit('stateChange', this.state);
  }

  /** 自分のキューに購読 */
  private subscribeToOwnQueue(): void {
    this.subscriptionId = uuidv4();
    const destination = createQueueName(this.options.operatorCode, 'caller');

    this.sendFrame({
      command: 'SUBSCRIBE',
      headers: {
        'id': this.subscriptionId,
        'destination': destination,
        'ack': 'auto',
      },
    });

    logger.info('Subscribed to queue', { destination });
  }

  /** MESSAGE処理 */
  private handleMessage(frame: StompFrameInfo): void {
    const destination = frame.headers['destination'];
    const messageId = frame.headers['message-id'];

    try {
      const message = JSON.parse(frame.body || '{}');

      // レスポンスの場合
      if (message.requestMessageId && this.pendingRequests.has(message.requestMessageId)) {
        const pending = this.pendingRequests.get(message.requestMessageId)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.requestMessageId);
        pending.resolve(message as NET119Response);

        logger.info('Response received', {
          requestMessageId: message.requestMessageId,
          resultCode: message.resultCode,
        });
      } else {
        // その他のメッセージ（リクエストなど）
        this.emit('message', message, destination);
      }
    } catch (err) {
      logger.error('Failed to parse message', { messageId, error: (err as Error).message });
    }
  }

  /** RECEIPT処理 */
  private handleReceipt(frame: StompFrameInfo): void {
    const receiptId = frame.headers['receipt-id'];
    logger.debug('Receipt received', { receiptId });

    if (receiptId === 'disconnect-receipt') {
      this.socket?.destroy();
    }
  }

  /** ERROR処理 */
  private handleError(frame: StompFrameInfo): void {
    const message = frame.headers['message'];
    logger.error('STOMP error', { message, body: frame.body });

    this.emit('error', new Error(message));
  }

  /** 切断処理 */
  private handleDisconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.socket = null;
    this.sessionId = null;
    this.subscriptionId = null;

    // 再接続
    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') {
      this.state = 'RECONNECTING';
      this.emit('stateChange', this.state);
      this.scheduleReconnect();
    } else {
      this.state = 'DISCONNECTED';
      this.emit('stateChange', this.state);
    }
  }

  /** 再接続スケジュール */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= config.stomp.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      this.state = 'ERROR';
      this.emit('stateChange', this.state);
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = config.stomp.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.state = 'DISCONNECTED';
      try {
        await this.connect();
      } catch (err) {
        logger.error('Reconnect failed', { error: (err as Error).message });
      }
    }, delay);
  }

  /** CONNECTフレーム送信 */
  private sendConnectFrame(): void {
    this.sendFrame({
      command: 'CONNECT',
      headers: {
        'accept-version': '1.2',
        'host': this.options.brokerHost,
        'heart-beat': `${config.stomp.heartbeatInterval},${config.stomp.heartbeatInterval}`,
      },
    });
  }

  /** フレーム送信 */
  private sendFrame(frame: StompFrameInfo): void {
    if (this.socket?.writable) {
      const data = serializeStompFrame(frame);
      this.socket.write(data);

      logger.debug('Sent frame', { command: frame.command });
    }
  }

  /** 接続状態取得 */
  getState(): ConnectionState {
    return this.state;
  }

  /** 統計情報 */
  getStats(): Record<string, unknown> {
    return {
      state: this.state,
      sessionId: this.sessionId,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// メイン実行（テスト用）
if (require.main === module) {
  const gateway = new CallerGateway({
    operatorCode: process.env.OPERATOR_CODE || 'tokyo',
    brokerHost: process.env.BROKER_HOST || 'localhost',
    brokerPort: parseInt(process.env.BROKER_PORT || '61614', 10),
  });

  gateway.on('stateChange', (state) => {
    logger.info('State changed', { state });
  });

  gateway.on('message', (message, destination) => {
    logger.info('Received message', { message, destination });
  });

  gateway.on('error', (err) => {
    logger.error('Gateway error', { error: err.message });
  });

  gateway.connect().then(() => {
    logger.info('Gateway connected and ready');
  }).catch((err) => {
    logger.error('Failed to connect', { error: err.message });
    process.exit(1);
  });

  process.on('SIGTERM', async () => {
    await gateway.disconnect();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await gateway.disconnect();
    process.exit(0);
  });
}
