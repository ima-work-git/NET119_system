# NET119 相互接続システム - OCI Always Free 構成
# Terraform メイン設定

terraform {
  required_version = ">= 1.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

# データソース: Availability Domains
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# データソース: Oracle Linux イメージ
data "oci_core_images" "oracle_linux" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Oracle Linux"
  operating_system_version = "8"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# VCN
resource "oci_core_vcn" "net119_vcn" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "net119-vcn"
  dns_label      = "net119"
}

# Internet Gateway
resource "oci_core_internet_gateway" "net119_igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.net119_vcn.id
  display_name   = "net119-igw"
  enabled        = true
}

# Route Table
resource "oci_core_route_table" "net119_rt" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.net119_vcn.id
  display_name   = "net119-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.net119_igw.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

# Security List
resource "oci_core_security_list" "net119_sl" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.net119_vcn.id
  display_name   = "net119-sl"

  # Egress: 全て許可
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # Ingress: SSH (管理用)
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    stateless   = false
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Ingress: STOMP/TLS (TS-1022: Port 61614)
  dynamic "ingress_security_rules" {
    for_each = length(var.allowed_ips) > 0 ? var.allowed_ips : ["0.0.0.0/0"]
    content {
      protocol    = "6" # TCP
      source      = ingress_security_rules.value
      stateless   = false
      tcp_options {
        min = 61614
        max = 61614
      }
    }
  }

  # Ingress: HTTPS/WSS (指令センター端末用)
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    stateless   = false
    tcp_options {
      min = 443
      max = 443
    }
  }

  # Ingress: HTTP (Let's Encrypt用)
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    stateless   = false
    tcp_options {
      min = 80
      max = 80
    }
  }

  # Ingress: ICMP
  ingress_security_rules {
    protocol  = "1" # ICMP
    source    = "0.0.0.0/0"
    stateless = false
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol  = "1"
    source    = var.vcn_cidr
    stateless = false
    icmp_options {
      type = 3
    }
  }
}

# Subnet
resource "oci_core_subnet" "net119_subnet" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.net119_vcn.id
  cidr_block                 = var.subnet_cidr
  display_name               = "net119-subnet"
  dns_label                  = "net119sub"
  route_table_id             = oci_core_route_table.net119_rt.id
  security_list_ids          = [oci_core_security_list.net119_sl.id]
  prohibit_public_ip_on_vnic = false
}

# Reserved Public IP (固定IP - Always Free無課金)
resource "oci_core_public_ip" "net119_public_ip" {
  compartment_id = var.compartment_ocid
  display_name   = "net119-reserved-ip"
  lifetime       = "RESERVED"
}

# Compute Instance
resource "oci_core_instance" "net119_instance" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "net119-server"
  shape               = var.instance_shape

  # A1 Flex の場合のみ shape_config が必要
  dynamic "shape_config" {
    for_each = var.instance_shape == "VM.Standard.A1.Flex" ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gb
    }
  }

  source_details {
    source_type = "image"
    source_id   = var.instance_image_ocid != "" ? var.instance_image_ocid : data.oci_core_images.oracle_linux.images[0].id
    # Always Free: 最大2つの Boot Volume (各最大200GB)
    boot_volume_size_in_gbs = 50
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.net119_subnet.id
    display_name     = "net119-vnic"
    assign_public_ip = false # Reserved IPを使用
  }

  metadata = {
    ssh_authorized_keys = file(var.ssh_public_key_path)
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
      operator_code = var.operator_code
    }))
  }

  preserve_boot_volume = false
}

# VNIC取得
data "oci_core_vnic_attachments" "net119_vnic_attachments" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.net119_instance.id
}

data "oci_core_vnic" "net119_vnic" {
  vnic_id = data.oci_core_vnic_attachments.net119_vnic_attachments.vnic_attachments[0].vnic_id
}

# Reserved IPをVNICにアタッチ
resource "oci_core_public_ip" "net119_attached_ip" {
  compartment_id = var.compartment_ocid
  display_name   = "net119-attached-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_vnic.net119_vnic.private_ip_id
}

# 出力
output "instance_id" {
  value = oci_core_instance.net119_instance.id
}

output "public_ip" {
  description = "NET119 Server Public IP (Reserved/Fixed)"
  value       = oci_core_public_ip.net119_attached_ip.ip_address
}

output "private_ip" {
  value = data.oci_core_vnic.net119_vnic.private_ip_address
}

output "stomp_endpoint" {
  description = "STOMP Broker Endpoint (TS-1022)"
  value       = "${oci_core_public_ip.net119_attached_ip.ip_address}:61614"
}

output "wss_endpoint" {
  description = "WSS Endpoint for Callee Terminals"
  value       = "wss://${oci_core_public_ip.net119_attached_ip.ip_address}:443/ws/terminal"
}

output "ssh_command" {
  value = "ssh opc@${oci_core_public_ip.net119_attached_ip.ip_address}"
}
