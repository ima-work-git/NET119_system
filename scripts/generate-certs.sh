#!/bin/bash
# NET119 自己署名証明書生成スクリプト
# 開発・テスト用

set -e

CERT_DIR="${CERT_DIR:-./certs}"
DOMAIN="${DOMAIN:-localhost}"
DAYS="${DAYS:-365}"

echo "Creating certificate directory: $CERT_DIR"
mkdir -p "$CERT_DIR"

echo "Generating self-signed certificate for: $DOMAIN"

# CA証明書生成
openssl genrsa -out "$CERT_DIR/ca.key" 4096
openssl req -new -x509 -days "$DAYS" -key "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
  -subj "/CN=NET119 CA/O=NET119/C=JP"

# サーバー証明書生成
openssl genrsa -out "$CERT_DIR/server.key" 2048

# CSR生成
openssl req -new -key "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
  -subj "/CN=$DOMAIN/O=NET119/C=JP"

# 拡張属性ファイル
cat > "$CERT_DIR/server.ext" << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = $DOMAIN
DNS.2 = localhost
DNS.3 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# サーバー証明書署名
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -out "$CERT_DIR/server.crt" -days "$DAYS" -extfile "$CERT_DIR/server.ext"

# フルチェーン作成
cat "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt" > "$CERT_DIR/fullchain.pem"
cp "$CERT_DIR/server.key" "$CERT_DIR/privkey.pem"

# クリーンアップ
rm -f "$CERT_DIR/server.csr" "$CERT_DIR/server.ext" "$CERT_DIR/ca.srl"

# 権限設定
chmod 600 "$CERT_DIR"/*.key "$CERT_DIR"/*.pem

echo ""
echo "Certificates generated successfully:"
echo "  CA Certificate:     $CERT_DIR/ca.crt"
echo "  Server Certificate: $CERT_DIR/server.crt"
echo "  Server Key:         $CERT_DIR/server.key"
echo "  Full Chain:         $CERT_DIR/fullchain.pem"
echo "  Private Key:        $CERT_DIR/privkey.pem"
echo ""
echo "For production, use Let's Encrypt or a proper CA."
