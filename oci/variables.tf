# OCI Terraform 変数定義
# NET119 相互接続システム - Always Free 構成

variable "tenancy_ocid" {
  description = "OCI Tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI User OCID"
  type        = string
}

variable "fingerprint" {
  description = "OCI API Key Fingerprint"
  type        = string
}

variable "private_key_path" {
  description = "Path to OCI API Private Key"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "OCI Region"
  type        = string
  default     = "ap-tokyo-1"
}

variable "compartment_ocid" {
  description = "OCI Compartment OCID"
  type        = string
}

# Always Free リソース設定
variable "instance_shape" {
  description = "Compute Instance Shape (Always Free: VM.Standard.E2.1.Micro or VM.Standard.A1.Flex)"
  type        = string
  default     = "VM.Standard.E2.1.Micro"
}

variable "instance_ocpus" {
  description = "Number of OCPUs (for A1 Flex)"
  type        = number
  default     = 1
}

variable "instance_memory_gb" {
  description = "Memory in GB (for A1 Flex)"
  type        = number
  default     = 6
}

variable "instance_image_ocid" {
  description = "OS Image OCID (Oracle Linux 8)"
  type        = string
  # Oracle Linux 8 for ap-tokyo-1 - 最新版は OCI Console で確認
  default     = ""
}

variable "ssh_public_key_path" {
  description = "Path to SSH Public Key"
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "availability_domain" {
  description = "Availability Domain"
  type        = string
  default     = "1"
}

# ネットワーク設定
variable "vcn_cidr" {
  description = "VCN CIDR Block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet CIDR Block"
  type        = string
  default     = "10.0.1.0/24"
}

# NET119 設定
variable "operator_code" {
  description = "NET119 Operator Code"
  type        = string
  default     = "tokyo"
}

variable "allowed_ips" {
  description = "Allowed IP addresses for STOMP connections (CIDR format)"
  type        = list(string)
  default     = []
}
