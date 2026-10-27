// Package mailclient is a small IMAP/SMTP client for the plugin.
//
// It wraps go-imap and go-smtp with what the plugin needs: connection
// policy (TLS, private network protection, deadlines), stable error codes
// for the UI and helpers that turn raw MIME into something a panel can show.
package mailclient

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// Security is how the connection is protected.
type Security string

const (
	SecurityTLS      Security = "tls"      // implicit TLS (IMAPS 993, SMTPS 465)
	SecurityStartTLS Security = "starttls" // plain connection upgraded with STARTTLS (143, 587)
	SecurityNone     Security = "none"     // no encryption, only for trusted internal servers
)

// ParseSecurity accepts the values stored in settings and sent by the webapp.
func ParseSecurity(s string) (Security, bool) {
	switch Security(strings.ToLower(strings.TrimSpace(s))) {
	case SecurityTLS, "ssl":
		return SecurityTLS, true
	case SecurityStartTLS:
		return SecurityStartTLS, true
	case SecurityNone, "plain":
		return SecurityNone, true
	}
	return "", false
}

// Endpoint is one server: the IMAP or the SMTP side of an account.
type Endpoint struct {
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Security Security `json:"security"`
}

// Validate checks the endpoint before any network access.
func (e Endpoint) Validate() error {
	host := strings.TrimSpace(e.Host)
	if host == "" {
		return newError(CodeInvalidServer, "", errors.New("server address is empty"))
	}
	if strings.ContainsAny(host, "/:@ \t") && net.ParseIP(host) == nil {
		return newError(CodeInvalidServer, "", fmt.Errorf("invalid host %q", host))
	}
	if e.Port <= 0 || e.Port > 65535 {
		return newError(CodeInvalidServer, "", fmt.Errorf("invalid port %d", e.Port))
	}
	if _, ok := ParseSecurity(string(e.Security)); !ok {
		return newError(CodeInvalidServer, "", fmt.Errorf("invalid security %q", e.Security))
	}
	return nil
}

// Address returns host:port.
func (e Endpoint) Address() string {
	return net.JoinHostPort(strings.TrimSpace(e.Host), strconv.Itoa(e.Port))
}

// Credentials of one mailbox.
type Credentials struct {
	Username string
	Password string
}

// Policy decides where the client may connect.
type Policy struct {
	// AllowPrivateNetworks allows loopback, link-local and private
	// addresses. It must stay false for addresses entered by end users,
	// otherwise the plugin could be abused to probe the internal network.
	AllowPrivateNetworks bool
	// Timeout of a single network operation. Defaults to 30 seconds.
	Timeout time.Duration
	// TLSConfig is used by tests to trust a self-signed certificate.
	TLSConfig *tls.Config
}

func (p Policy) timeout() time.Duration {
	if p.Timeout > 0 {
		return p.Timeout
	}
	return 30 * time.Second
}

func (p Policy) tlsConfig(host string) *tls.Config {
	var cfg *tls.Config
	if p.TLSConfig != nil {
		cfg = p.TLSConfig.Clone()
	} else {
		cfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	if cfg.ServerName == "" {
		cfg.ServerName = host
	}
	return cfg
}

// dial opens a TCP connection to the endpoint. The host is resolved once and
// every address is checked against the policy before connecting, so a DNS
// answer can not point the plugin into the internal network.
func dial(ctx context.Context, endpoint Endpoint, policy Policy, op string) (net.Conn, error) {
	if err := endpoint.Validate(); err != nil {
		return nil, err
	}
	host := strings.TrimSpace(endpoint.Host)
	ips, err := resolve(ctx, host)
	if err != nil {
		return nil, classify(op, err)
	}
	if !policy.AllowPrivateNetworks {
		if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
			return nil, newError(CodeBlockedAddress, op, &blockedError{host: host})
		}
		for _, ip := range ips {
			if isPrivateIP(ip) {
				return nil, newError(CodeBlockedAddress, op, &blockedError{host: host})
			}
		}
	}

	dialer := &net.Dialer{Timeout: policy.timeout()}
	var lastErr error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(endpoint.Port)))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, classify(op, lastErr)
}

func resolve(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	if len(ips) == 0 {
		return nil, &net.DNSError{Err: "no addresses", Name: host, IsNotFound: true}
	}
	return ips, nil
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast()
}

// IsPrivateHost reports whether the host is or resolves to a private address.
// Unresolvable hosts are reported as not private: connecting will fail anyway.
func IsPrivateHost(ctx context.Context, host string) bool {
	host = strings.TrimSpace(host)
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	ips, err := resolve(ctx, host)
	if err != nil {
		return false
	}
	for _, ip := range ips {
		if isPrivateIP(ip) {
			return true
		}
	}
	return false
}

// handshake wraps conn into TLS and completes the handshake within the deadline.
func handshake(ctx context.Context, conn net.Conn, host string, policy Policy, op string) (net.Conn, error) {
	tlsConn := tls.Client(conn, policy.tlsConfig(host))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, newError(CodeTimeout, op, err)
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, newError(CodeTimeout, op, err)
		}
		return nil, newError(CodeTLS, op, err)
	}
	return tlsConn, nil
}
