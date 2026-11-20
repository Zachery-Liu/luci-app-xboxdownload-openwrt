RUNDIR=/var/run/xboxdownload_openwrt
DATA=/usr/share/xboxdownload_openwrt
DNS_PORT=15353
HTTP_PORT=18080
HTTP_ADDRESS=192.0.0.8
DNS_ZONE=53953
HEALTH_HOST=xboxdownload-openwrt.invalid
SERVICE_LOCK=/var/lock/xboxdownload_openwrt_service.lock
UPSTREAM_FILE="$RUNDIR/upstreams.conf"
UPSTREAM_STATE="$RUNDIR/upstream-state"
NODE_KEYS="main_ip legacy_ip global_ip app_ip ps_ip ns_ip ea_ip battle_ip"
EXTRA_KEYS="upstream global_ip app_ip ps_ip ns_ip ea_ip battle_ip mode filter_aaaa log_mode log_path ipv6_dns ipv6_block ipv6_block_ip ipv6_block_mac"
SETTINGS_KEYS="enabled client main_ip legacy_ip $EXTRA_KEYS"

write_upstream() {
	local temp
	temp=$(mktemp "$RUNDIR/upstream.XXXXXX") || return 1
	if printf 'server=%s\n' "$1" > "$temp" && chmod 0644 "$temp" && mv -f "$temp" "$UPSTREAM_FILE"; then
		return 0
	fi
	rm -f "$temp"
	return 1
}

ipv4() {
	case "$1" in
		''|*[!0-9.]*|.*|*.) return 1 ;;
	esac
	printf '%s\n' "$1" | awk -F. '
		NF != 4 { exit 1 }
		{ for (i = 1; i <= 4; i++)
			if ($i !~ /^(0|[1-9][0-9]*)$/ || length($i) > 3 || $i > 255) exit 1 }'
}

client_ipv4() {
	ipv4 "$1" || return 1
	case "$1" in
		0.*|127.*|169.254.*|22[4-9].*|23[0-9].*|24[0-9].*|25[0-5].*) return 1 ;;
	esac
}

public_ipv4() {
	client_ipv4 "$1" || return 1
	case "$1" in
		10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|100.6[4-9].*|100.[789][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 1 ;;
	esac
}

public_ipv6() {
	case "$1" in [23][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]:*) ;; *) return 1 ;; esac
	case "$1" in *[!0-9a-fA-F:]*|*:::*) return 1 ;; esac
	printf '%s\n' "$1" | awk '
		function groups(s,    values,n,i) {
			if (s == "") return 0
			n = split(s, values, ":")
			for (i=1; i<=n; i++)
				if (values[i] == "" || length(values[i]) > 4) return 9
			return n
		}
		{
			p = index($0, "::")
			if (!p) exit (groups($0) != 8)
			right = substr($0, p + 2)
			exit (index(right, "::") || groups(substr($0, 1, p - 1)) + groups(right) >= 8)
		}'
}

node_ip() {
	case "$1" in *:*) public_ipv6 "$1" ;; *) public_ipv4 "$1" ;; esac
}

client_mac() {
	[ "$1" != 00:00:00:00:00:00 ] &&
		printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9a-fA-F][02468aAcCeE](:[0-9a-fA-F]{2}){5}$' &&
		[ "${#1}" = 17 ]
}

normalize_clients() {
	local addresses address chosen= count=0
	case "$1" in *[!0-9.,[:space:]]*) return 1 ;; esac
	addresses=$(printf '%s' "$1" | tr ',\t\r\n' '    ')
	for address in $addresses; do
		client_ipv4 "$address" && [ "$address" != "$lan_ip" ] || return 1
		case ",$chosen," in *",$address,"*) continue ;; esac
		count=$((count + 1))
		[ "$count" -le 8 ] || return 1
		chosen="${chosen:+$chosen,}$address"
	done
	printf '%s' "$chosen"
}

load_settings() {
	local key default
	config_load xboxdownload_openwrt
	for key in $SETTINGS_KEYS; do
		default=
		case "$key" in
			enabled|filter_aaaa|log_path|ipv6_dns|ipv6_block) default=0 ;;
			mode) default=redirect ;;
			log_mode) default=http ;;
		esac
		config_get "$key" main "$key" "$default"
	done
}

validate_settings() {
	local key value
	case "$mode" in redirect|dns) ;; *) printf invalid; return 1 ;; esac
	case "$log_mode" in off|http|all) ;; *) printf invalid; return 1 ;; esac
	case "$enabled:$filter_aaaa:$log_path" in
		[01]:[01]:[01]) ;; *) printf invalid; return 1 ;;
	esac
	client=$(normalize_clients "$client") || { printf client; return 1; }
	[ "$enabled" = 0 ] || [ -n "$client" ] || { printf client; return 1; }
	case "${ipv6_block:-0}:${ipv6_dns:-0}" in
		0:0) [ -z "$ipv6_block_ip$ipv6_block_mac" ] || { printf ipv6_device; return 1; } ;;
		1:0|0:1)
			if [ "$enabled:$ipv6_dns" != 0:1 ] || [ -n "$ipv6_block_ip$ipv6_block_mac" ]; then
				client_ipv4 "$ipv6_block_ip" && client_mac "$ipv6_block_mac" ||
					{ printf ipv6_device; return 1; }
				case ",$client," in
					*",$ipv6_block_ip,"*) ;;
					*) printf ipv6_device; return 1 ;;
				esac
			fi
			case "$ipv6_block:$main_ip,$legacy_ip,$global_ip" in
				1:*:*) printf ipv6_cdn; return 1 ;;
			esac
			[ "$ipv6_dns:$filter_aaaa" != 1:1 ] || { printf ipv6_filter; return 1; }
			;;
		*) printf invalid; return 1 ;;
	esac
	case "$upstream" in
		'') ;;
		*:*) public_ipv6 "$upstream" || { printf upstream; return 1; } ;;
		*) client_ipv4 "$upstream" || { printf upstream; return 1; } ;;
	esac
	for key in $NODE_KEYS; do
		eval "value=\${$key}"
		[ -z "$value" ] && continue
		node_ip "$value" || { printf cdn; return 1; }
		case "$value:$filter_aaaa" in *:*:1) printf ipv6; return 1 ;; esac
	done
}

lan_network() {
	network_get_ipaddr lan_ip lan && network_get_device lan_dev lan &&
		ipv4 "$lan_ip" && [ -n "$lan_dev" ] &&
		case "$lan_dev" in *[!a-zA-Z0-9_.:-]*) false ;; *) true ;; esac
}

clear_rules() {
	nft -f - <<-'EOF'
		destroy table ip xboxdownload_openwrt
		destroy table inet xboxdownload_openwrt_ipv6
	EOF
}
