# 2つのEC2間での本部転送セットアップ

## 構成概要

```
+---------------------------+          STOMP          +---------------------------+
|   EC2-A (川崎消防局)      | <-------------------->  |   EC2-B (横浜消防局)      |
|   IP: 18.177.238.97       |       Port 61614        |   IP: xxx.xxx.xxx.xxx     |
+---------------------------+                         +---------------------------+
    |                                                     |
    | WebSocket                                           | WebSocket
    |                                                     |
+-------+                                             +-------+
| 指令員 |                                             | 指令員 |
+-------+                                             +-------+
```

## Step 1: 2つ目のEC2を作成（横浜消防局用）

### 1.1 AWSコンソールでEC2作成

1. AWS Console → EC2 → インスタンスを起動
2. 設定:
   - 名前: `net119-yokohama`
   - AMI: Amazon Linux 2023
   - インスタンスタイプ: t2.micro（無料枠）
   - キーペア: 既存または新規作成
   - セキュリティグループ:
     - SSH (22): 自分のIP
     - STOMP (61614): 18.177.238.97/32（川崎EC2のIP）
     - HTTPS (443): 0.0.0.0/0
     - HTTP (8080): 0.0.0.0/0
3. 起動

### 1.2 Elastic IP 割り当て

1. EC2 → Elastic IP → Elastic IP アドレスの割り当て
2. 新しいIPを横浜EC2に関連付け
3. このIPをメモ（例: `54.xxx.xxx.xxx`）

## Step 2: 横浜EC2にNET119をセットアップ

SSH接続後、以下を実行:

```bash
# Node.js インストール
sudo dnf install -y nodejs

# ディレクトリ作成
sudo mkdir -p /opt/net119
sudo chown ec2-user:ec2-user /opt/net119
cd /opt/net119

# package.json作成
cat > package.json << 'EOF'
{
  "name": "net119-interconnect",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start:web": "node dist/web-server.js",
    "start:broker": "node dist/stomp-broker.js"
  },
  "dependencies": {
    "@stomp/stompjs": "^7.0.0",
    "stompit": "^1.0.0",
    "ws": "^8.16.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/uuid": "^9.0.7",
    "@types/ws": "^8.5.10",
    "typescript": "^5.3.3"
  }
}
EOF

npm install
```

## Step 3: ソースコードをコピー

川崎EC2（18.177.238.97）からファイルをコピーするか、手動で作成。

### 方法A: SCPでコピー

川崎EC2上で:
```bash
# 横浜EC2のIPを設定
YOKOHAMA_IP="54.xxx.xxx.xxx"

# ファイルをtar化
cd /opt/net119
tar czf /tmp/net119.tar.gz src/ web/ tsconfig.json certs/

# 転送（横浜EC2の鍵が必要）
scp -i ~/.ssh/yokohama-key.pem /tmp/net119.tar.gz ec2-user@$YOKOHAMA_IP:/opt/net119/
```

横浜EC2上で:
```bash
cd /opt/net119
tar xzf net119.tar.gz
npm run build
```

### 方法B: Git経由（推奨）

両方のEC2で:
```bash
cd /opt/net119
git clone https://github.com/YOUR_REPO/NET119_system.git .
npm install
npm run build
```

## Step 4: IP認証設定を更新

### 4.1 川崎EC2（18.177.238.97）

`/opt/net119/src/utils/ip-auth.ts` を編集:

```typescript
const ALLOWED_IPS: Record<string, string> = {
  '127.0.0.1': 'kawasaki',
  '18.177.238.97': 'kawasaki',
  '54.xxx.xxx.xxx': 'yokohama',  // ← 横浜EC2のIPを追加
};
```

### 4.2 横浜EC2（54.xxx.xxx.xxx）

`/opt/net119/src/utils/ip-auth.ts` を編集:

```typescript
const ALLOWED_IPS: Record<string, string> = {
  '127.0.0.1': 'yokohama',
  '54.xxx.xxx.xxx': 'yokohama',
  '18.177.238.97': 'kawasaki',  // ← 川崎EC2のIPを追加
};
```

## Step 5: web-server.ts の本部設定を更新

両方のEC2で `/opt/net119/src/web-server.ts` を編集:

```typescript
const HEADQUARTERS: Record<string, { name: string; host: string; port: number }> = {
  kawasaki: { name: '川崎市消防局', host: '18.177.238.97', port: 61614 },
  yokohama: { name: '横浜市消防局', host: '54.xxx.xxx.xxx', port: 61614 },
};
```

## Step 6: 証明書を作成（横浜EC2）

```bash
cd /opt/net119
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -subj "/CN=net119-yokohama/O=Yokohama Fire/C=JP"
```

## Step 7: サービスを起動

### 7.1 川崎EC2

```bash
# 再ビルド
cd /opt/net119
npm run build

# サービス再起動
sudo systemctl restart net119-broker
sudo systemctl restart net119-web

# 環境変数設定（/etc/systemd/system/net119-web.service）
# Environment="OPERATOR_CODE=kawasaki"
# Environment="CONNECT_STOMP=true"
# Environment="BROKER_HOST=127.0.0.1"
```

### 7.2 横浜EC2

```bash
# systemdサービス作成
sudo tee /etc/systemd/system/net119-broker.service << 'EOF'
[Unit]
Description=NET119 STOMP Broker
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/net119
ExecStart=/usr/bin/node dist/stomp-broker.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/net119-web.service << 'EOF'
[Unit]
Description=NET119 Web Server
After=network.target net119-broker.service

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/net119
Environment="WEB_PORT=8080"
Environment="OPERATOR_CODE=yokohama"
Environment="CONNECT_STOMP=true"
Environment="BROKER_HOST=127.0.0.1"
ExecStart=/usr/bin/node dist/web-server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable net119-broker net119-web
sudo systemctl start net119-broker net119-web
```

## Step 8: セキュリティグループを更新

### 川崎EC2のセキュリティグループ
- インバウンド: TCP 61614 を `54.xxx.xxx.xxx/32`（横浜EC2）から許可

### 横浜EC2のセキュリティグループ
- インバウンド: TCP 61614 を `18.177.238.97/32`（川崎EC2）から許可

## Step 9: 動作確認

### 9.1 ブラウザでアクセス

- 川崎指令台: http://18.177.238.97:8080/dispatcher
- 横浜指令台: http://54.xxx.xxx.xxx:8080/dispatcher

### 9.2 転送テスト

1. 川崎指令台を開く
2. 市民UI（http://18.177.238.97:8080/citizen）から通報
3. 川崎指令台に通報が表示される
4. 「他本部へ転送」→「横浜市消防局」を選択
5. 転送実行
6. 横浜指令台に転送された通報が表示される

## トラブルシューティング

### STOMP接続エラー

```bash
# ログ確認
sudo journalctl -u net119-broker -f
sudo journalctl -u net119-web -f

# 接続テスト
openssl s_client -connect 54.xxx.xxx.xxx:61614
```

### セキュリティグループ確認

```bash
# AWS CLIで確認
aws ec2 describe-security-groups --group-ids sg-xxxxx
```

### ファイアウォール確認（EC2内部）

```bash
# 開いているポート確認
sudo ss -tlnp
```
