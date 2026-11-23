RUNDIR=/var/run/xboxdownload_openwrt
DATA=/usr/share/xboxdownload_openwrt
DNS_PORT=15353
HTTP_PORT=18080
HTTP_ADDRESS=192.0.0.8
DNS_ZONE=53953
HEALTH_HOST=xboxdownload-openwrt.invalid
HTTP_HEALTH_ERROR='Could not verify HTTP 302 redirects'
RULE_CLEANUP_ERROR='Could not remove interception rules'
SERVICE_LOCK=/var/lock/xboxdownload_openwrt_service.lock
UPSTREAM_FILE="$RUNDIR/upstreams.conf"
UPSTREAM_STATE="$RUNDIR/upstream-state"
NODE_KEYS="main_ip legacy_ip global_ip app_ip ps_ip ns_ip ea_ip battle_ip"
LEGACY_IPV6_KEYS="ipv6_dns ipv6_block ipv6_block_ip ipv6_block_mac"
EXTRA_KEYS="upstream probe_domain global_ip app_ip ps_ip ns_ip ea_ip battle_ip mode filter_aaaa log_mode log_path ipv6_devices"
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

legacy_ipv6_devices() {
	local mode=system ip addresses rows= matched=0
	case "$ipv6_dns:$ipv6_block" in
		1:0) mode=dns ;;
		0:1) mode=block ;;
		0:0) ;;
		*) return 1 ;;
	esac
	addresses=$(normalize_clients "$client") || return 1
	for ip in $(printf '%s' "$addresses" | tr ',' ' '); do
		if [ "$ip" = "$ipv6_block_ip" ] && [ "$mode" != system ]; then
			rows="${rows:+$rows,}$ip/$ipv6_block_mac/$mode"
			matched=1
		else
			rows="${rows:+$rows,}$ip//system"
		fi
	done
	if [ "$matched" = 0 ] && [ "$mode" != system ] && [ -n "$ipv6_block_ip$ipv6_block_mac" ]; then
		rows="${rows:+$rows,}$ipv6_block_ip/$ipv6_block_mac/$mode"
	fi
	printf '%s' "$rows"
}

normalize_ipv6_devices() {
	local row ip rest mac policy rows= seen_ips= seen_macs=
	case "$1" in
		*[!0-9A-Za-z.:/,]*|,*|*,|*,,*) printf ipv6_device; return 1 ;;
	esac
	[ "${#1}" -le 400 ] || { printf ipv6_device; return 1; }
	for row in $(printf '%s' "$1" | tr ',' ' '); do
		case "$row" in */*/*) ;; *) printf ipv6_device; return 1 ;; esac
		ip=${row%%/*}
		rest=${row#*/}
		mac=${rest%%/*}
		policy=${rest#*/}
		case ",$client," in *",$ip,"*) ;; *) printf ipv6_device; return 1 ;; esac
		[ -n "$ip" ] || { printf ipv6_device; return 1; }
		case ",$seen_ips," in *",$ip,"*) printf ipv6_device; return 1 ;; esac
		case "$policy" in dns|block|system) ;; *) printf ipv6_device; return 1 ;; esac
		if [ -n "$mac" ] || [ "$policy" != system ]; then
			client_mac "$mac" || { printf ipv6_device; return 1; }
			mac=$(printf '%s' "$mac" | tr 'a-f' 'A-F')
			case ",$seen_macs," in *",$mac,"*) printf ipv6_mac_duplicate; return 1 ;; esac
			seen_macs="${seen_macs:+$seen_macs,}$mac"
		fi
		seen_ips="${seen_ips:+$seen_ips,}$ip"
		rows="${rows:+$rows,}$ip/$mac/$policy"
	done
	printf '%s' "$rows"
}

ipv6_policy_macs() {
	printf '%s\n' "$ipv6_devices" | tr ',' '\n' | awk -F/ -v policy="$1" '
		$3 == policy { printf "%s%s", separator, $2; separator=", " }'
}

load_settings() {
	local key default
	config_load xboxdownload_openwrt
	legacy_ipv6_config=0
	for key in $SETTINGS_KEYS $LEGACY_IPV6_KEYS; do
		default=
		case "$key" in
			enabled|filter_aaaa|log_path|ipv6_dns|ipv6_block) default=0 ;;
			mode) default=redirect ;;
			log_mode) default=http ;;
			ipv6_devices) default=legacy ;;
		esac
		config_get "$key" main "$key" "$default"
	done
	case "$ipv6_devices" in
		none) ipv6_devices= ;;
		legacy)
			legacy_ipv6_config=1
			ipv6_devices=$(legacy_ipv6_devices) || ipv6_devices=invalid
			;;
	esac
}

validate_settings() {
	local key value normalized
	case "$mode" in redirect|dns) ;; *) printf invalid; return 1 ;; esac
	case "$log_mode" in off|http|all) ;; *) printf invalid; return 1 ;; esac
	case "$enabled:$filter_aaaa:$log_path" in
		[01]:[01]:[01]) ;; *) printf invalid; return 1 ;;
	esac
	client=$(normalize_clients "$client") || { printf client; return 1; }
	[ "$enabled" = 0 ] || [ -n "$client" ] || { printf client; return 1; }
	normalized=$(normalize_ipv6_devices "$ipv6_devices") || { printf '%s' "$normalized"; return 1; }
	case ",$normalized," in
		*/dns,*) [ "$filter_aaaa" = 0 ] || { printf ipv6_filter; return 1; } ;;
	esac
	case "$upstream" in
		'') ;;
		*:*) public_ipv6 "$upstream" || { printf upstream; return 1; } ;;
		*) client_ipv4 "$upstream" || { printf upstream; return 1; } ;;
	esac
	if [ -n "$probe_domain" ]; then
		local domain=${probe_domain%.}
		[ "${#domain}" -le 253 ] && printf '%s\n' "$domain" | LC_ALL=C awk -F. '
			NR != 1 || NF < 2 || $NF !~ /[A-Za-z]/ { bad = 1 }
			{ for (i = 1; i <= NF; i++) if (length($i) > 63 || $i !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/) bad = 1 }
			END { exit (NR != 1 || bad) }' || { printf probe_domain; return 1; }
	fi
	for key in $NODE_KEYS; do
		eval "value=\${$key}"
		[ -z "$value" ] && continue
		node_ip "$value" || { printf cdn; return 1; }
		case ",$normalized," in
			*/block,*) case "$value" in *:*) printf ipv6_cdn; return 1 ;; esac ;;
		esac
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
