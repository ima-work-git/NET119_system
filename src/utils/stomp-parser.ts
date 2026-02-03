/**
 * STOMP 1.2 プロトコルパーサー
 * https://stomp.github.io/stomp-specification-1.2.html
 */

import { StompCommand, StompFrameInfo } from '../types/ts-1022';

const NULL_CHAR = '\x00';
const LF = '\n';
const COLON = ':';

/** STOMPフレームをパース */
export function parseStompFrame(data: Buffer | string): StompFrameInfo | null {
  const str = typeof data === 'string' ? data : data.toString('utf-8');

  // NULL文字で終端
  const frameEnd = str.indexOf(NULL_CHAR);
  const frame = frameEnd >= 0 ? str.substring(0, frameEnd) : str;

  const lines = frame.split(LF);
  if (lines.length === 0) return null;

  // コマンド（最初の行）
  const command = lines[0].trim() as StompCommand;
  if (!isValidCommand(command)) return null;

  // ヘッダ（空行まで）
  const headers: Record<string, string> = {};
  let bodyStartIndex = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (line === '' || line === '\r') {
      bodyStartIndex = i + 1;
      break;
    }

    const colonIndex = line.indexOf(COLON);
    if (colonIndex > 0) {
      const key = decodeHeader(line.substring(0, colonIndex));
      const value = decodeHeader(line.substring(colonIndex + 1));

      // STOMP 1.2: 最初のヘッダが優先
      if (!(key in headers)) {
        headers[key] = value;
      }
    }
  }

  // ボディ
  const body = lines.slice(bodyStartIndex).join(LF);

  return {
    command,
    headers,
    body: body || undefined,
  };
}

/** STOMPフレームをシリアライズ */
export function serializeStompFrame(frame: StompFrameInfo): Buffer {
  const lines: string[] = [frame.command];

  // ヘッダ
  for (const [key, value] of Object.entries(frame.headers)) {
    lines.push(`${encodeHeader(key)}:${encodeHeader(value)}`);
  }

  // 空行（ヘッダとボディの区切り）
  lines.push('');

  // ボディ
  if (frame.body) {
    lines.push(frame.body);
  }

  return Buffer.from(lines.join(LF) + NULL_CHAR, 'utf-8');
}

/** ヘッダ値のエンコード（STOMP 1.2） */
function encodeHeader(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/:/g, '\\c');
}

/** ヘッダ値のデコード（STOMP 1.2） */
function decodeHeader(value: string): string {
  return value
    .replace(/\\c/g, ':')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

/** コマンドの妥当性チェック */
function isValidCommand(command: string): command is StompCommand {
  const validCommands: StompCommand[] = [
    'CONNECT', 'STOMP', 'SEND', 'SUBSCRIBE', 'UNSUBSCRIBE',
    'ACK', 'NACK', 'DISCONNECT',
    'CONNECTED', 'MESSAGE', 'RECEIPT', 'ERROR',
  ];
  return validCommands.includes(command as StompCommand);
}

/** CONNECTED フレームを生成 */
export function createConnectedFrame(sessionId: string, heartbeat: string = '0,0'): StompFrameInfo {
  return {
    command: 'CONNECTED',
    headers: {
      'version': '1.2',
      'session': sessionId,
      'server': 'NET119-STOMP/1.0',
      'heart-beat': heartbeat,
    },
  };
}

/** MESSAGE フレームを生成 */
export function createMessageFrame(
  destination: string,
  messageId: string,
  subscriptionId: string,
  body: string,
  contentType: string = 'application/json'
): StompFrameInfo {
  return {
    command: 'MESSAGE',
    headers: {
      'destination': destination,
      'message-id': messageId,
      'subscription': subscriptionId,
      'content-type': contentType,
      'content-length': Buffer.byteLength(body, 'utf-8').toString(),
    },
    body,
  };
}

/** ERROR フレームを生成 */
export function createErrorFrame(message: string, details?: string): StompFrameInfo {
  return {
    command: 'ERROR',
    headers: {
      'message': message,
      'content-type': 'text/plain',
    },
    body: details,
  };
}

/** RECEIPT フレームを生成 */
export function createReceiptFrame(receiptId: string): StompFrameInfo {
  return {
    command: 'RECEIPT',
    headers: {
      'receipt-id': receiptId,
    },
  };
}
