/**
 * NET119 相互接続システム設定
 * OCI Always Free 対応
 */

import { OperatorId } from '../types/ts-1022';

/** 環境変数から設定を読み込み */
export interface Config {
  /** サーバ設定 */
  server: ServerConfig;
  /** TLS設定 */
  tls: TLSConfig;
  /** STOMP設定 */
  stomp: StompConfig;
  /** 事業者設定 */
  operators: OperatorId[];
  /** ログ設定 */
  logging: LoggingConfig;
}

export interface ServerConfig {
  /** STOMPブローカーポート（TS-1022: 61614） */
  stompPort: number;
  /** WSS ポート（Callee端末向け） */
  wssPort: number;
  /** バインドホスト */
  host: string;
  /** 固定IP（OCI Reserved Public IP） */
  publicIP?: string;
}

export interface TLSConfig {
  /** 証明書ファイルパス */
  certPath: string;
  /** 秘密鍵ファイルパス */
  keyPath: string;
  /** CA証明書パス（オプション） */
  caPath?: string;
  /** 最小TLSバージョン */
  minVersion: 'TLSv1.2' | 'TLSv1.3';
}

export interface StompConfig {
  /** ハートビート間隔（ミリ秒） */
  heartbeatInterval: number;
  /** 接続タイムアウト（ミリ秒） */
  connectTimeout: number;
  /** 再接続間隔（ミリ秒） */
  reconnectInterval: number;
  /** 最大再接続試行回数 */
  maxReconnectAttempts: number;
  /** メッセージ最大サイズ（バイト） */
  maxMessageSize: number;
}

export interface LoggingConfig {
  /** ログレベル */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** JSON形式でログ出力 */
  json: boolean;
}

/** デフォルト設定 */
export function loadConfig(): Config {
  return {
    server: {
      stompPort: parseInt(process.env.STOMP_PORT || '61614', 10),
      wssPort: parseInt(process.env.WSS_PORT || '443', 10),
      host: process.env.BIND_HOST || '0.0.0.0',
      publicIP: process.env.PUBLIC_IP,
    },
    tls: {
      certPath: process.env.TLS_CERT_PATH || '/etc/net119/certs/server.crt',
      keyPath: process.env.TLS_KEY_PATH || '/etc/net119/certs/server.key',
      caPath: process.env.TLS_CA_PATH,
      minVersion: 'TLSv1.2',
    },
    stomp: {
      heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),
      connectTimeout: parseInt(process.env.CONNECT_TIMEOUT || '10000', 10),
      reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000', 10),
      maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10),
      maxMessageSize: parseInt(process.env.MAX_MESSAGE_SIZE || '65536', 10),
    },
    operators: loadOperators(),
    logging: {
      level: (process.env.LOG_LEVEL as LoggingConfig['level']) || 'info',
      json: process.env.LOG_JSON === 'true',
    },
  };
}

/** 事業者設定の読み込み */
function loadOperators(): OperatorId[] {
  const operatorsJson = process.env.OPERATORS_CONFIG;
  if (operatorsJson) {
    try {
      return JSON.parse(operatorsJson);
    } catch {
      console.error('Failed to parse OPERATORS_CONFIG');
    }
  }

  // デフォルト設定（川崎・横浜消防局）
  // 本番環境では OPERATORS_CONFIG 環境変数で設定
  return [
    {
      code: 'kawasaki',
      name: '川崎市消防局',
      allowedIPs: [
        '127.0.0.1',
        '18.177.238.97',              // 川崎EC2
        '10.0.0.0/8',
        '192.168.0.0/16',
      ],
    },
    {
      code: 'yokohama',
      name: '横浜市消防局',
      allowedIPs: [
        '127.0.0.1',
        'YOKOHAMA_EC2_IP',            // ← 横浜EC2のElastic IPに置換
        '10.0.0.0/8',
        '192.168.0.0/16',
      ],
    },
    {
      code: 'tokyo',
      name: '東京消防庁',
      allowedIPs: ['127.0.0.1', '10.0.0.0/8', '192.168.0.0/16'],
    },
  ];
}

/** OCI Always Free 用の推奨設定 */
export const OCI_FREE_TIER_LIMITS = {
  /** 最大同時接続数（メモリ1GB想定） */
  maxConnections: 100,
  /** 最大キュー数 */
  maxQueues: 50,
  /** メッセージ保持期間（秒） */
  messageRetentionSeconds: 86400, // 24時間
  /** CPU制限を考慮したワーカー数 */
  workers: 1,
};

export const config = loadConfig();
