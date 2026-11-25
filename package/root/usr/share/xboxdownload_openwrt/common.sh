RUNDIR=/var/run/xboxdownload_openwrt
DATA=/usr/share/xboxdownload_openwrt
UPDATE_HISTORY=/etc/xboxdownload_openwrt
DNS_PORT=15353
HTTP_PORT=18080
HTTP_ADDRESS=192.0.0.8
DNS_ZONE=53953
# Consumed by the init script when generating nftables rules.
# shellcheck disable=SC2034
HTTP_ZONE=53980
HEALTH_HOST=xboxdownload-openwrt.invalid
HTTP_HEALTH_ERROR='Could not verify HTTP 302 redirects'
RULE_CLEANUP_ERROR='Could not remove interception rules'
SERVICE_LOCK=/var/lock/xboxdownload_openwrt_lifecycle.flock
# Consumed by supervise and rpcd respectively.
# shellcheck disable=SC2034
LISTENER_LOCK=/var/lock/xboxdownload_openwrt_listeners.flock
# shellcheck disable=SC2034
CONFIG_LOCK=/var/lock/xboxdownload_openwrt_config.flock
# shellcheck disable=SC2034
UPGRADE_LOCK=/var/lock/xboxdownload_openwrt_upgrade.flock
SERVICE_START_TIMEOUT=25
UPSTREAM_FILE="$RUNDIR/upstreams.conf"
UPSTREAM_STATE="$RUNDIR/upstream-state"
# Shared by the init script and supervisor.
# shellcheck disable=SC2034
HTTPS_ORIGINS="$RUNDIR/https-origins"
# shellcheck disable=SC2034
DNS_PROFILES="$RUNDIR/dns-profiles"
NODE_KEYS="main_ip legacy_ip global_ip app_ip ps_ip ns_ip ea_ip battle_ip"
LEGACY_IPV6_KEYS="ipv6_dns ipv6_block ipv6_block_ip ipv6_block_mac"
EXTRA_KEYS="upstream probe_domain global_ip app_ip ps_ip ns_ip ea_ip battle_ip mode filter_aaaa log_mode log_path ipv6_devices device_routes"
SETTINGS_KEYS="enabled client main_ip legacy_ip $EXTRA_KEYS"

record_update_time() (
	umask 077
	mkdir -p "$UPDATE_HISTORY" || exit 1
	temp=$(mktemp "$UPDATE_HISTORY/.time.XXXXXX") || exit 1
	trap 'rm -f "$temp"' EXIT
	date +%s > "$temp" && mv -f "$temp" "$UPDATE_HISTORY/$1"
)

write_upstream() {
	local temp file=${2:-$UPSTREAM_FILE}
	temp=$(mktemp "$RUNDIR/upstream.XXXXXX") || return 1
	if printf 'server=%s\n' "$1" > "$temp" && chmod 0644 "$temp" && mv -f "$temp" "$file"; then
		return 0
	fi
	rm -f "$temp"
	return 1
}

address_check() {
	printf '%s\n' "$2" | LC_ALL=C awk -v check="$1" -v subnets="${lan_subnets:-}" -f "$DATA/addresses.awk"
}

ipv4() { address_check ipv4 "$1"; }
client_ipv4() { address_check unicast4 "$1"; }
public_ipv4() { address_check public4 "$1"; }

resolve_https_origins() (
	local source=$1 resolver=$2 fallback=${3:-} work host alias old file
	work=$(mktemp -d "$RUNDIR/origins.XXXXXX") || exit 1
	trap 'rm -rf "$work"' EXIT
	while read -r host alias old; do
		(
			origin=$(https_origin "$host" "$resolver")
			if [ -z "$origin" ] && [ -n "$fallback" ] && [ "$fallback" != "$resolver" ]; then
				origin=$(https_origin "$host" "$fallback")
			fi
			origin=${origin:-$old}
			[ -z "$origin" ] || printf '%s %s %s\n' "$host" "$alias" "$origin" > "$work/$alias"
		) &
	done < "$source"
	wait
	for file in "$work"/*; do
		[ ! -f "$file" ] || cat "$file" || exit 1
	done
)

https_origin() {
	/bin/busybox nslookup -timeout=1 -retry=1 -type=A "$1." "$2" 2>/dev/null |
		awk '/^Name:/ { answer=1 } answer && /^Address: / { print $2 }' |
		while read -r address; do
			if public_ipv4 "$address"; then printf '%s\n' "$address"; break; fi
		done
}

write_https_elements() {
	local host alias origin
	while read -r host alias origin; do
		printf 'add element ip xboxdownload_openwrt https_origins { %s : %s }\n' "$alias" "$origin"
	done < "$1"
}

node_ip() {
	case "$1" in ''|*[!0-9a-fA-F.:]*) return 1 ;; esac
	address_check nodes "$1"
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
		client_ipv4 "$address" || return 1
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

device_policy() {
	printf '%s\n' "$ipv6_devices" | tr ',' '\n' | awk -F/ -v ip="$1" '$1 == ip { print $3; exit }'
}

device_route() {
	printf '%s\n' "$device_routes" | tr ',' '\n' | awk -F/ -v ip="$1" '$1 == ip { print; exit }'
}

read_device_route() {
	local _route_ip
	# The caller reads these settings by key when validating or writing dnsmasq records.
	# shellcheck disable=SC2034
	IFS=/ read -r _route_ip filter_aaaa upstream main_ip legacy_ip global_ip app_ip ps_ip ns_ip ea_ip battle_ip <<-EOF
	$1
	EOF
}

valid_upstream() {
	case "$1" in
		'') return 0 ;;
		*:*) address_check global6 "$1" ;;
		*) client_ipv4 "$1" ;;
	esac
}

node_family_supported() {
	case "$1:$2" in main_ip:*:*|legacy_ip:*:*) return 1 ;; esac
}

validate_device_routes() (
	local ipv6_devices=$1 row address key value policy seen=
	case "$device_routes" in *[!0-9a-fA-F.:/,]*|,*|*,|*,,*) printf device_routes; exit 1 ;; esac
	[ "${#device_routes}" -le 4096 ] || { printf device_routes; exit 1; }
	for row in $(printf '%s\n' "$device_routes" | tr ',' ' '); do
		[ "$(printf '%s\n' "$row" | awk -F/ '{ print NF }')" = 11 ] || { printf device_routes; exit 1; }
		address=${row%%/*}
		[ -n "$address" ] || { printf device_routes; exit 1; }
		case ",$client," in *",$address,"*) ;; *) printf device_routes; exit 1 ;; esac
		case ",$seen," in *",$address,"*) printf device_routes; exit 1 ;; esac
		seen="${seen:+$seen,}$address"
		read_device_route "$row"
		case "$filter_aaaa" in 0|1) ;; *) printf device_routes; exit 1 ;; esac
		valid_upstream "$upstream" || { printf upstream; exit 1; }
		policy=$(device_policy "$address")
		[ "$policy:$filter_aaaa" != dns:1 ] || { printf ipv6_filter; exit 1; }
		for key in $NODE_KEYS; do
			eval "value=\${$key}"
			[ -n "$value" ] || continue
			node_ip "$value" || { printf cdn; exit 1; }
			node_family_supported "$key" "$value" || { printf cdn_family; exit 1; }
			case "$value:$policy:$filter_aaaa" in
				*:*:block:*) printf ipv6_cdn; exit 1 ;;
				*:*:*:1) printf ipv6; exit 1 ;;
			esac
		done
	done
)

load_settings() {
	local key default
	config_load xboxdownload_openwrt
	legacy_ipv6_config=0
	device_routes=
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
	local key value normalized saved
	case "$mode" in redirect|dns) ;; *) printf invalid; return 1 ;; esac
	case "$log_mode" in off|http|all) ;; *) printf invalid; return 1 ;; esac
	case "$enabled:$filter_aaaa:$log_path" in
		[01]:[01]:[01]) ;; *) printf invalid; return 1 ;;
	esac
	client=$(normalize_clients "$client") || { printf client; return 1; }
	[ "$enabled" = 0 ] || [ -n "$client" ] || { printf client; return 1; }
	validate_client_subnets || return 1
	normalized=$(normalize_ipv6_devices "$ipv6_devices") || { printf '%s' "$normalized"; return 1; }
	valid_upstream "$upstream" || { printf upstream; return 1; }
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
		if ! node_family_supported "$key" "$value"; then
			# Preserve old settings during upgrade and stop. The resolver uses ordinary DNS for them.
			config_get saved main "$key" ''
			[ "$value" = "$saved" ] || { printf cdn_family; return 1; }
			continue
		fi
		saved=
		[ "$enabled" != 0 ] || config_get saved main "$key" ''
		if ! node_ip "$value"; then
			# Preserve an old address while disabled so the user can replace it or stop safely.
			[ "$value" = "$saved" ] && { ipv4 "$value" || address_check global6 "$value"; } ||
				{ printf cdn; return 1; }
		fi
		case "$value:$filter_aaaa" in *:*:1) printf ipv6; return 1 ;; esac
	done
	validate_device_routes "$normalized"
}

validate_client_subnets() {
	local saved checked=$client address
	if [ "$enabled" = 0 ]; then
		# An offline or renumbered LAN must still allow stopping and removing saved devices.
		config_get saved main client ''
		saved=$(normalize_clients "$saved")
		checked=
		for address in $(printf '%s' "$client" | tr ',' ' '); do
			case ",$saved," in *",$address,"*) continue ;; esac
			checked="${checked:+$checked,}$address"
		done
	fi
	[ -z "$checked" ] || validate_lan_addresses "$(printf '%s' "$checked" | tr ',' '\n')"
}

validate_lan_addresses() {
	address_check lan "$1" && return 0
	case "$?" in 2) printf lan_subnet ;; *) printf client_subnet ;; esac
	return 1
}

lan_network() {
	lan_subnets=
	network_get_subnets lan_subnets lan || lan_subnets=
	network_get_ipaddr lan_ip lan && network_get_device lan_dev lan &&
		ipv4 "$lan_ip" && [ -n "$lan_dev" ] &&
		case "$lan_dev" in *[!a-zA-Z0-9_.:-]*) false ;; *) true ;; esac
}

with_service_lock() (
	trap - EXIT
	flock -x 8 && "$@"
) 8>"$SERVICE_LOCK"

service_ready() {
	[ -n "$1" ] && [ "$(cat "$RUNDIR/instance" 2>/dev/null)" = "$1" ] &&
		[ "$(cat "$RUNDIR/ready" 2>/dev/null)" = "$1" ] &&
		nft list chain ip xboxdownload_openwrt select_xbox >/dev/null 2>&1
}

restart_and_wait() {
	local init=$1 previous instance attempt=0
	previous=$(cat "$RUNDIR/instance" 2>/dev/null)
	"$init" restart || return 1
	instance=$(cat "$RUNDIR/instance" 2>/dev/null)
	[ -n "$instance" ] && [ "$instance" != "$previous" ] || return 1
	while :; do
		service_ready "$instance" && return 0
		[ ! -s "$RUNDIR/error" ] && [ "$attempt" -lt "$SERVICE_START_TIMEOUT" ] || return 1
		[ "$(cat "$RUNDIR/instance" 2>/dev/null)" = "$instance" ] || return 1
		attempt=$((attempt + 1))
		sleep 1
	done
}

clear_rules() {
	nft -f - <<-'EOF'
		destroy table ip xboxdownload_openwrt
		destroy table inet xboxdownload_openwrt_ipv6
	EOF
}
