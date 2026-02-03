/**
 * IP認証ユーティリティ
 * TS-1022: IP制限による認証
 */

import { OperatorId } from '../types/ts-1022';
import { logger } from './logger';

/** CIDR表記のIPアドレス範囲をパース */
interface IPRange {
  network: number;
  mask: number;
}

/** IPv4アドレスを数値に変換 */
function ipToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // 符号なし32ビット整数に変換
}

/** CIDR表記をパース */
function parseCIDR(cidr: string): IPRange | null {
  const [ip, maskStr] = cidr.split('/');
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return null;

  const maskBits = maskStr ? parseInt(maskStr, 10) : 32;
  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return null;

  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;

  return {
    network: (ipNum & mask) >>> 0,
    mask,
  };
}

/** IPアドレスがCIDR範囲内かチェック */
function isIPInRange(ip: string, range: IPRange): boolean {
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;
  return ((ipNum & range.mask) >>> 0) === range.network;
}

/** IPアドレスが許可リストに含まれるかチェック */
export function isIPAllowed(clientIP: string, allowedIPs: string[]): boolean {
  // IPv6マッピングされたIPv4を処理
  const ip = clientIP.replace(/^::ffff:/, '');

  for (const allowed of allowedIPs) {
    // 完全一致
    if (allowed === ip) return true;

    // CIDR範囲チェック
    const range = parseCIDR(allowed);
    if (range && isIPInRange(ip, range)) return true;
  }

  return false;
}

/** クライアントIPから事業者を特定 */
export function identifyOperator(clientIP: string, operators: OperatorId[]): OperatorId | null {
  const ip = clientIP.replace(/^::ffff:/, '');

  for (const operator of operators) {
    if (isIPAllowed(ip, operator.allowedIPs)) {
      logger.debug('Operator identified', { ip, operator: operator.code });
      return operator;
    }
  }

  logger.warn('Unknown client IP', { ip });
  return null;
}

/** キュー名のアクセス権チェック */
export function canAccessQueue(operator: OperatorId, queueName: string): boolean {
  // キュー名フォーマット: /queue/{operatorCode}.{role}
  const match = queueName.match(/^\/queue\/([^.]+)\.(caller|callee)$/);
  if (!match) {
    logger.warn('Invalid queue name format', { queueName });
    return false;
  }

  const [, queueOperator] = match;

  // 自分のキューのみSUBSCRIBE可能（TS-1022要件）
  const allowed = queueOperator === operator.code;

  if (!allowed) {
    logger.warn('Queue access denied', {
      operator: operator.code,
      queueName,
      reason: 'Can only subscribe to own queues',
    });
  }

  return allowed;
}

/** SENDの宛先チェック */
export function canSendToQueue(operator: OperatorId, queueName: string): boolean {
  // キュー名フォーマットチェック
  const match = queueName.match(/^\/queue\/([^.]+)\.(caller|callee)$/);
  if (!match) {
    logger.warn('Invalid queue name format for SEND', { queueName });
    return false;
  }

  // SENDは他事業者のキューにも送信可能
  return true;
}
