# Addresses are read as data. The shell callers use the same checks for saves, probes and imports.
function ipv4_number(address,    parts, i, number) {
	if (split(address, parts, "[.]") != 4)
		return -1
	for (i = 1; i <= 4; i++) {
		if (parts[i] !~ /^(0|[1-9][0-9]*)$/ || length(parts[i]) > 3 || parts[i] > 255)
			return -1
		number = number * 256 + parts[i]
	}
	return number
}

function unicast_ipv4(number,    first, second) {
	if (number < 0)
		return 0
	first = int(number / 16777216)
	second = int(number / 65536) % 256
	return first > 0 && first != 127 && first < 224 && !(first == 169 && second == 254)
}

# IANA IPv4 special-purpose ranges with no global reachability, plus deprecated 6to4.
function public_ipv4(number,    a, b, c, d) {
	if (!unicast_ipv4(number))
		return 0
	a = int(number / 16777216)
	b = int(number / 65536) % 256
	c = int(number / 256) % 256
	d = number % 256
	if (a == 10 || (a == 100 && b >= 64 && b <= 127) || (a == 172 && b >= 16 && b <= 31))
		return 0
	if (a == 192 && (b == 168 || (b == 0 && c == 2) || (b == 88 && c == 99) ||
	    (b == 0 && c == 0 && d != 9 && d != 10)))
		return 0
	return !((a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
	         (a == 203 && b == 0 && c == 113))
}

function split_hextets(address, parts,    i, j, count, value, digit) {
	if (address == "")
		return 0
	count = split(address, parts, ":")
	for (i = 1; i <= count; i++) {
		if (parts[i] !~ /^[0-9a-f]+$/ || length(parts[i]) > 4)
			return -1
		value = 0
		for (j = 1; j <= length(parts[i]); j++) {
			digit = index("0123456789abcdef", substr(parts[i], j, 1)) - 1
			value = value * 16 + digit
		}
		parts[i] = value
	}
	return count
}

function global_ipv6(address, words,    compressed, left, right, n, m, i) {
	address = tolower(address)
	if (address !~ /^[23][0-9a-f][0-9a-f][0-9a-f]:/)
		return 0
	compressed = index(address, "::")
	if (!compressed)
		return split_hextets(address, words) == 8
	n = split_hextets(substr(address, 1, compressed - 1), left)
	m = split_hextets(substr(address, compressed + 2), right)
	if (n < 1 || m < 0 || n + m >= 8)
		return 0
	for (i = 1; i <= 8; i++)
		words[i] = (i <= n ? left[i] : (i > 8 - m ? right[i - 8 + m] : 0))
	return 1
}

# Direct CDN endpoints use global unicast. Exclude documentation and transition ranges.
function public_ipv6(address,    words, second) {
	if (!global_ipv6(address, words))
		return 0
	second = words[2]
	if (words[1] == 16383)
		return second >= 4096 # 3fff::/20
	if (words[1] == 8194)
		return 0 # 2002::/16
	if (words[1] != 8193)
		return 1
	if (second >= 512)
		return second != 3512 # 2001:db8::/32
	# Globally reachable exceptions to 2001::/23.
	if (second == 1)
		return !(words[3] || words[4] || words[5] || words[6] || words[7]) &&
		       words[8] >= 1 && words[8] <= 3
	return second == 3 || (second == 4 && words[3] == 274) ||
	       (second >= 32 && second <= 63)
}

function node_ip(address, family) {
	if (index(address, ":"))
		return family != 4 && public_ipv6(address)
	return family != 6 && public_ipv4(ipv4_number(address))
}

function subnet_host(number,    i, base, size) {
	if (!unicast_ipv4(number) || router[number])
		return 0
	for (i = 1; i <= subnet_count; i++) {
		base = subnet_base[i]
		size = subnet_size[i]
		if (number >= base && number < base + size &&
		    (size <= 2 || (number != base && number != base + size - 1)))
			return 1
	}
	return 0
}

BEGIN {
	if (check == "lan") {
		count = split(subnets, cidrs, /[[:space:]]+/)
		for (i = 1; i <= count; i++) {
			if (split(cidrs[i], cidr, "/") != 2)
				continue
			number = ipv4_number(cidr[1])
			mask = cidr[2]
			if (number < 0 || mask !~ /^(0|[1-9][0-9]?)$/ || mask > 32)
				continue
			size = 2 ^ (32 - mask)
			router[number] = 1
			subnet_base[++subnet_count] = int(number / size) * size
			subnet_size[subnet_count] = size
		}
	}
}

check == "import" {
	sub(/\r$/, "")
	if (NR == 1) {
		if ($0 != group)
			exit 1
		next
	}
	ip = tolower($1)
	if (!node_ip(ip, family) || seen[ip]++)
		next
	location = ""
	if (match($0, /\([^()]*\)[[:space:]]*$/)) {
		location = substr($0, RSTART + 1, RLENGTH - 1)
		sub(/\)[[:space:]]*$/, "", location)
		gsub(/[[:cntrl:]]/, " ", location)
	}
	printf "%s\t%s\n", ip, location
	next
}

check == "cache" {
	split($0, row, "\t")
	if (node_ip(row[1], family))
		print
	next
}

check == "nodes" {
	if (NR > 24 || !node_ip($0, 0))
		exit 1
	next
}

check == "lan" {
	if (!subnet_count)
		exit 2
	if (!subnet_host(ipv4_number($0)))
		exit 1
	next
}

{
	if (NR != 1)
		exit 1
	number = ipv4_number($0)
	if (check == "ipv4" && number >= 0)
		next
	if (check == "unicast4" && unicast_ipv4(number))
		next
	if (check == "public4" && public_ipv4(number))
		next
	if (check == "global6" && global_ipv6($0, address_words))
		next
	exit 1
}
