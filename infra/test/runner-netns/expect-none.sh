# Expected results with egress `none` (sourced by packets.sh): nothing forwarded from any bridge.
pr C1 $C1 tcp 8.8.8.8 443 timeout; pr C1 $C1 tcp 8.8.8.8 80 timeout; pr C1 $C1 udp 169.254.169.253 53 timeout
pr C1 $C1 tcp 169.254.169.254 80 timeout; pr C1 $C1 tcp 10.201.0.3 9000 timeout; pr C1 $C1 tcp 10.200.7.2 9000 timeout
pr C1 $C1 tcp 172.17.0.1 8088 ok; pr C1 $C1 tcp 172.17.0.1 2222 timeout
pr P1 $P1 tcp 8.8.8.8 443 timeout; pr P1 $P1 tcp 172.17.0.1 8088 ok
WANT_PEERS=''
