# Expected results with egress `internet` (sourced by packets.sh).
pr C1 $C1 tcp 8.8.8.8 443 ok; pr C1 $C1 tcp 8.8.8.8 80 ok
pr C1 $C1 tcp 8.8.8.8 22 refused; pr C1 $C1 tcp 8.8.8.8 8443 refused; pr C1 $C1 tcp 8.8.8.8 53 refused
pr C1 $C1 udp 8.8.8.8 53 unreachable; pr C1 $C1 udp 8.8.8.8 443 unreachable
pr C1 $C1 udp 169.254.169.253 53 ok; pr C1 $C1 tcp 169.254.169.253 53 ok; pr C1 $C1 tcp 169.254.169.253 443 timeout
pr C1 $C1 tcp 169.254.169.254 80 timeout; pr C1 $C1 tcp 169.254.170.2 80 timeout
pr C1 $C1 tcp 10.91.0.5 443 timeout; pr C1 $C1 tcp 198.51.100.7 443 timeout; pr C1 $C1 tcp 100.64.0.9 443 timeout
pr C1 $C1 tcp 10.201.0.3 9000 timeout; pr C2 $C2 tcp 10.201.0.2 9000 timeout; pr C1 $C1 tcp 10.200.7.2 9000 timeout
pr C1 $C1 tcp 172.17.0.1 8088 ok; pr C1 $C1 tcp 172.17.0.1 2222 timeout; pr C1 $C1 tcp 10.201.0.1 8088 timeout
pr C1 $C1 tcp 10.201.0.1 2222 timeout; pr C1 $C1 tcp 1.2.3.1 2222 timeout
pr P1 $P1 tcp 8.8.8.8 443 timeout; pr P1 $P1 udp 169.254.169.253 53 timeout; pr P1 $P1 tcp 10.201.0.2 9000 timeout
pr P1 $P1 tcp 172.17.0.1 8088 ok
pr W $W tcp 10.201.0.2 9000 timeout
WANT_PEERS='1.2.3.1 '
