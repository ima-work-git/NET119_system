# NET119 相互接続システム

TS-1022準拠のNET119事業者間相互接続システム。OCI Always Freeで無料運用可能。

## 概要

```
[通報受付事業者A]                    [指令センターB]
      │                                   │
      ↓                                   ↓
┌─────────────┐                    ┌─────────────┐
│ Caller      │ ←── STOMP/TLS ──→ │ Callee      │ ←── WSS ──→ [端末]
│ Gateway     │     (Port 61614)   │ Gateway     │    (443)
└─────────────┘                    └─────────────┘
      │                                   │
      └──────────── STOMP Broker ─────────┘
```

## 技術仕様 (TS-1022準拠)

| 項目 | 仕様 |
|------|------|
| プロトコル | STOMP 1.2 |
| トランスポート | IPv4 / TLS 1.2以上 |
| ポート | 61614 (STOMP), 443 (WSS) |
| 認証 | IP制限（送信元固定IP） |
| メッセージ | JSON / UTF-8 |
| キュー命名 | `/queue/{事業者コード}.{caller\|callee}` |

## クイックスタート

### 開発環境

```bash
# 依存関係インストール
npm install

# 自己署名証明書生成
npm run cert:generate
# または
./scripts/generate-certs.sh

# 開発モード起動
npm run dev:broker    # STOMPブローカー
npm run dev:caller    # Callerゲートウェイ
npm run dev:callee    # Calleeゲートウェイ

# Docker Compose (開発用)
docker-compose -f docker-compose.dev.yml up
```

### 本番環境 (OCI Always Free)

```bash
# 1. OCI CLIセットアップ
./scripts/oci-setup.sh

# 2. Terraform でインフラ構築
cd oci
terraform init
terraform apply

# 3. サーバーにSSH接続
ssh opc@<PUBLIC_IP>

# 4. Let's Encrypt証明書取得
sudo /opt/net119/setup-certs.sh your-domain.com your@email.com

# 5. サービス起動
sudo systemctl start net119
```

## OCI Always Free リソース

| リソース | 無料枠 | 本システム使用量 |
|----------|--------|------------------|
| VM.Standard.E2.1.Micro | 2台 | 1台 |
| Reserved Public IP | 無課金 | 1個 |
| Boot Volume | 200GB | 50GB |
| Outbound | 10TB/月 | 想定1GB未満 |

### 固定IP取得方法

1. OCI Console → Networking → IP Management → Reserved Public IPs
2. 「Create Reserved Public IP」をクリック
3. Compartmentを選択し、名前を入力
4. 作成されたIPをCompute Instanceにアタッチ

## 設定

### 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|------------|
| `STOMP_PORT` | STOMPブローカーポート | 61614 |
| `WSS_PORT` | WSS待受ポート | 443 |
| `OPERATOR_CODE` | 事業者コード | tokyo |
| `TLS_CERT_PATH` | TLS証明書パス | /etc/net119/certs/fullchain.pem |
| `TLS_KEY_PATH` | TLS秘密鍵パス | /etc/net119/certs/privkey.pem |
| `LOG_LEVEL` | ログレベル | info |
| `OPERATORS_CONFIG` | 事業者設定(JSON) | (デフォルト設定) |

### 事業者設定 (OPERATORS_CONFIG)

```json
[
  {
    "code": "tokyo",
    "name": "東京消防庁",
    "allowedIPs": ["203.0.113.0/24", "198.51.100.50"]
  },
  {
    "code": "osaka",
    "name": "大阪市消防局",
    "allowedIPs": ["192.0.2.0/24"]
  }
]
```

## API

### メッセージフォーマット

#### リクエスト
```json
{
  "messageId": "uuid-v4",
  "messageType": "EMERGENCY_REQUEST",
  "via": {
    "destination": "/queue/tokyo.caller",
    "operatorId": "tokyo",
    "timestamp": "2026-02-03T12:00:00.000Z"
  },
  "timestamp": "2026-02-03T12:00:00.000Z",
  "payload": {
    "caller": {
      "registrationId": "REG-12345",
      "disabilityType": "HEARING"
    },
    "location": {
      "latitude": 35.6812,
      "longitude": 139.7671
    },
    "content": {
      "type": "FIRE",
      "description": "火災発生"
    }
  }
}
```

#### レスポンス
```json
{
  "requestMessageId": "original-request-uuid",
  "messageId": "response-uuid",
  "messageType": "EMERGENCY_RESPONSE",
  "resultCode": "ACCEPTED",
  "timestamp": "2026-02-03T12:00:01.000Z"
}
```

### WSS端末プロトコル

指令センター端末は443番ポートにWSS接続:

```javascript
const ws = new WebSocket('wss://gateway.example.com/ws/terminal');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'REQUEST') {
    // 通報受信
    handleRequest(message);

    // レスポンス送信
    ws.send(JSON.stringify({
      type: 'RESPONSE',
      requestMessageId: message.messageId,
      resultCode: 'ACCEPTED'
    }));
  }
};
```

## セキュリティ

- **IP制限**: STOMP接続は登録済み事業者IPからのみ許可
- **TLS 1.2以上**: 通信は全て暗号化
- **キュー分離**: 各事業者は自分のキューのみ購読可能
- **トランザクション禁止**: TS-1022要件によりtransaction不使用

## 参考リンク

- [TS-1022 NET119相互接続仕様](https://www.ttc.or.jp/application/files/5315/5442/5368/TS-1022v1.pdf)
- [STOMP 1.2 Specification](https://stomp.github.io/stomp-specification-1.2.html)
- [OCI Always Free](https://www.oracle.com/jp/cloud/free/)
- [OCI Reserved Public IP](https://docs.oracle.com/iaas/Content/Network/Tasks/managingpublicIPs.htm)

## ライセンス

MIT
