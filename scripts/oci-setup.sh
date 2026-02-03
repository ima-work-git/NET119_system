#!/bin/bash
# OCI Always Free 環境セットアップスクリプト
# 前提: OCI CLI がインストール・設定済み

set -e

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}NET119 OCI Always Free セットアップ${NC}"
echo -e "${GREEN}========================================${NC}"

# 設定
COMPARTMENT_NAME="${COMPARTMENT_NAME:-net119}"
REGION="${REGION:-ap-tokyo-1}"

# OCI CLI確認
if ! command -v oci &> /dev/null; then
    echo -e "${RED}Error: OCI CLI がインストールされていません${NC}"
    echo "インストール: https://docs.oracle.com/ja-jp/iaas/Content/API/SDKDocs/cliinstall.htm"
    exit 1
fi

echo -e "${YELLOW}1. Tenancy情報取得...${NC}"
TENANCY_OCID=$(oci iam tenancy get --query 'data.id' --raw-output 2>/dev/null || echo "")

if [ -z "$TENANCY_OCID" ]; then
    echo -e "${RED}Error: OCI CLI が設定されていません${NC}"
    echo "設定: oci setup config"
    exit 1
fi

echo "Tenancy OCID: $TENANCY_OCID"

echo -e "${YELLOW}2. Compartment確認/作成...${NC}"
COMPARTMENT_OCID=$(oci iam compartment list --compartment-id "$TENANCY_OCID" \
    --query "data[?name=='$COMPARTMENT_NAME'].id | [0]" --raw-output 2>/dev/null || echo "")

if [ -z "$COMPARTMENT_OCID" ] || [ "$COMPARTMENT_OCID" == "null" ]; then
    echo "Compartment '$COMPARTMENT_NAME' を作成します..."
    COMPARTMENT_OCID=$(oci iam compartment create \
        --compartment-id "$TENANCY_OCID" \
        --name "$COMPARTMENT_NAME" \
        --description "NET119 Interconnect System" \
        --query 'data.id' --raw-output)
    echo "作成完了: $COMPARTMENT_OCID"
    echo "Compartmentがアクティブになるまで待機..."
    sleep 30
else
    echo "既存Compartment使用: $COMPARTMENT_OCID"
fi

echo -e "${YELLOW}3. Always Free リソース上限確認...${NC}"
echo "サービス制限を確認中..."

# Compute上限確認
echo -n "  VM.Standard.E2.1.Micro: "
oci limits resource-availability get \
    --compartment-id "$TENANCY_OCID" \
    --service-name compute \
    --limit-name standard-e2-1-micro-core-count \
    --availability-domain "$(oci iam availability-domain list --query 'data[0].name' --raw-output)" \
    --query 'data.available' --raw-output 2>/dev/null || echo "確認失敗"

echo -n "  VM.Standard.A1.Flex OCPUs: "
oci limits resource-availability get \
    --compartment-id "$TENANCY_OCID" \
    --service-name compute \
    --limit-name standard-a1-core-count \
    --availability-domain "$(oci iam availability-domain list --query 'data[0].name' --raw-output)" \
    --query 'data.available' --raw-output 2>/dev/null || echo "確認失敗"

echo -e "${YELLOW}4. terraform.tfvars 生成...${NC}"
USER_OCID=$(oci iam user list --compartment-id "$TENANCY_OCID" --query 'data[0].id' --raw-output)

cat > oci/terraform.tfvars << EOF
# OCI Always Free 設定
# 自動生成: $(date)

tenancy_ocid     = "$TENANCY_OCID"
user_ocid        = "$USER_OCID"
compartment_ocid = "$COMPARTMENT_OCID"
region           = "$REGION"

# API Key (要設定)
fingerprint      = "YOUR_FINGERPRINT"
private_key_path = "~/.oci/oci_api_key.pem"

# SSH Key
ssh_public_key_path = "~/.ssh/id_rsa.pub"

# Instance設定 (Always Free)
# E2.1.Micro: AMD, 1GB RAM, 無料2台まで
# A1.Flex: ARM, 最大4OCPU/24GB RAM, 無料3000 OCPU時間/月
instance_shape = "VM.Standard.E2.1.Micro"

# NET119設定
operator_code = "tokyo"
allowed_ips   = []  # 本番環境では許可IPを設定
EOF

echo -e "${GREEN}terraform.tfvars を生成しました${NC}"
echo ""
echo -e "${YELLOW}次のステップ:${NC}"
echo "1. oci/terraform.tfvars の fingerprint を設定"
echo "2. cd oci && terraform init"
echo "3. terraform plan"
echo "4. terraform apply"
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}OCI Always Free 無料枠の確認:${NC}"
echo -e "${GREEN}========================================${NC}"
echo "- Compute: VM.Standard.E2.1.Micro x 2台"
echo "- Compute: VM.Standard.A1.Flex 最大4OCPU/24GB"
echo "- Block Volume: 200GB (2 Boot Volumes)"
echo "- Object Storage: 20GB"
echo "- Reserved Public IP: 無課金"
echo "- Outbound Data: 10TB/月"
echo ""
echo "詳細: https://www.oracle.com/jp/cloud/free/"
