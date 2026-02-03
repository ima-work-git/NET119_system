# NET119 相互接続システム - Docker イメージ
# マルチステージビルド

# ビルドステージ
FROM node:20-alpine AS builder

WORKDIR /app

# 依存関係インストール
COPY package*.json ./
RUN npm ci

# ソースコピーとビルド
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 本番ステージ
FROM node:20-alpine AS production

# セキュリティ: 非rootユーザー
RUN addgroup -g 1001 -S net119 && \
    adduser -u 1001 -S net119 -G net119

WORKDIR /app

# 本番依存関係のみインストール
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ビルド成果物をコピー
COPY --from=builder /app/dist ./dist

# 証明書ディレクトリ
RUN mkdir -p /etc/net119/certs && chown -R net119:net119 /etc/net119

# ユーザー切り替え
USER net119

# ポート公開
EXPOSE 61614 443

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('net').connect(61614, 'localhost').on('error', () => process.exit(1)).end()" || exit 1

# デフォルトコマンド
CMD ["node", "dist/stomp-broker.js"]
