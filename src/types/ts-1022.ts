/**
 * TS-1022 NET119 相互接続 型定義
 * https://www.ttc.or.jp/application/files/5315/5442/5368/TS-1022v1.pdf
 */

/** 事業者識別子 */
export interface OperatorId {
  /** 事業者コード（例: "tokyo", "osaka"） */
  code: string;
  /** 事業者名 */
  name: string;
  /** 許可された送信元IP（複数可） */
  allowedIPs: string[];
}

/** Via ヘッダ（ルーティング情報） */
export interface Via {
  /** 返信先キュー（例: /queue/tokyo.callee） */
  destination: string;
  /** 送信元事業者ID */
  operatorId: string;
  /** タイムスタンプ */
  timestamp: string;
}

/** NET119 リクエストメッセージ基本構造 */
export interface NET119Request {
  /** メッセージID（UUID） */
  messageId: string;
  /** メッセージ種別 */
  messageType: NET119MessageType;
  /** ルーティング情報 */
  via: Via;
  /** タイムスタンプ（ISO 8601） */
  timestamp: string;
  /** ペイロード */
  payload: unknown;
}

/** NET119 レスポンスメッセージ基本構造 */
export interface NET119Response {
  /** 元リクエストのメッセージID */
  requestMessageId: string;
  /** レスポンスメッセージID */
  messageId: string;
  /** メッセージ種別 */
  messageType: NET119MessageType;
  /** 結果コード */
  resultCode: NET119ResultCode;
  /** タイムスタンプ（ISO 8601） */
  timestamp: string;
  /** ペイロード */
  payload?: unknown;
}

/** メッセージ種別 */
export type NET119MessageType =
  | 'EMERGENCY_REQUEST'      // 緊急通報リクエスト
  | 'EMERGENCY_RESPONSE'     // 緊急通報レスポンス
  | 'STATUS_UPDATE'          // 状態更新
  | 'STATUS_ACK'             // 状態更新確認
  | 'HEARTBEAT'              // ハートビート
  | 'HEARTBEAT_ACK';         // ハートビート確認

/** 結果コード */
export type NET119ResultCode =
  | 'OK'                     // 成功
  | 'ACCEPTED'               // 受付完了
  | 'REJECTED'               // 拒否
  | 'ERROR'                  // エラー
  | 'TIMEOUT'                // タイムアウト
  | 'INVALID_FORMAT'         // フォーマット不正
  | 'UNAUTHORIZED';          // 認証エラー

/** 緊急通報ペイロード */
export interface EmergencyPayload {
  /** 通報者情報 */
  caller: CallerInfo;
  /** 位置情報 */
  location?: LocationInfo;
  /** 通報内容 */
  content: EmergencyContent;
}

/** 通報者情報 */
export interface CallerInfo {
  /** 電話番号 */
  phoneNumber?: string;
  /** 登録ID */
  registrationId: string;
  /** 氏名 */
  name?: string;
  /** 障害種別 */
  disabilityType?: DisabilityType;
}

/** 障害種別 */
export type DisabilityType =
  | 'HEARING'      // 聴覚障害
  | 'SPEECH'       // 言語障害
  | 'BOTH'         // 両方
  | 'OTHER';       // その他

/** 位置情報 */
export interface LocationInfo {
  /** 緯度 */
  latitude: number;
  /** 経度 */
  longitude: number;
  /** 精度（メートル） */
  accuracy?: number;
  /** 住所 */
  address?: string;
  /** 建物名等 */
  building?: string;
}

/** 通報内容 */
export interface EmergencyContent {
  /** 通報種別 */
  type: EmergencyType;
  /** 詳細テキスト */
  description?: string;
  /** 定型文ID */
  templateId?: string;
}

/** 通報種別 */
export type EmergencyType =
  | 'FIRE'         // 火災
  | 'RESCUE'       // 救急
  | 'OTHER';       // その他

/** STOMP フレーム情報 */
export interface StompFrameInfo {
  /** コマンド */
  command: StompCommand;
  /** ヘッダ */
  headers: Record<string, string>;
  /** ボディ */
  body?: string;
}

/** STOMP コマンド */
export type StompCommand =
  // クライアント→サーバ
  | 'CONNECT'
  | 'STOMP'
  | 'SEND'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'ACK'
  | 'NACK'
  | 'DISCONNECT'
  // サーバ→クライアント
  | 'CONNECTED'
  | 'MESSAGE'
  | 'RECEIPT'
  | 'ERROR';

/** 接続状態 */
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR';

/** キュー名生成ユーティリティ */
export function createQueueName(operatorCode: string, role: 'caller' | 'callee'): string {
  return `/queue/${operatorCode}.${role}`;
}

/** Via ヘッダ生成 */
export function createVia(operatorId: string, role: 'caller' | 'callee'): Via {
  return {
    destination: createQueueName(operatorId, role),
    operatorId,
    timestamp: new Date().toISOString(),
  };
}
