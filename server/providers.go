package main

import (
	"errors"
	"net"
	"slices"
	"strconv"
	"strings"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	providerVKWorkSpace = "vkworkspace"
	providerMailRu      = "mailru"
	providerYandex      = "yandex"
	providerCustom      = "custom"

	mailRuIMAP  = "imap.mail.ru:993"
	mailRuSMTP  = "smtp.mail.ru:465"
	mailRuWeb   = "https://e.mail.ru/inbox/"
	yandexIMAP  = "imap.yandex.ru:993"
	yandexSMTP  = "smtp.yandex.ru:465"
	yandexWeb   = "https://mail.yandex.ru/"
	defaultIMAP = 993
	defaultSMTP = 465
)

// Provider is a mail service the user can connect. Rich, step by step
// instructions for every provider live in the webapp; the server only keeps
// what is needed to connect and to build links.
type Provider struct {
	ID   string              `json:"id"`
	Name string              `json:"name"`
	IMAP mailclient.Endpoint `json:"imap"`
	SMTP mailclient.Endpoint `json:"smtp"`
	// ServerEditable lets the user enter the servers (custom provider).
	ServerEditable bool     `json:"server_editable"`
	WebURL         string   `json:"web_url,omitempty"`
	AppPasswordURL string   `json:"app_password_url,omitempty"`
	HelpURL        string   `json:"help_url,omitempty"`
	Domains        []string `json:"domains,omitempty"`
	// Recommended marks the service the organization uses: the
	// administrator's default, VK WorkSpace if none is set.
	Recommended bool `json:"recommended,omitempty"`
}

// parseServer reads "host", "host:port" or "host:port/starttls". The
// security is guessed from the port when not given: 993 and 465 use TLS,
// 143, 587 and 25 use STARTTLS.
func parseServer(raw string, defaultPort int) (mailclient.Endpoint, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "imaps://"), "smtps://")
	if raw == "" {
		return mailclient.Endpoint{}, &mailclient.Error{Code: mailclient.CodeInvalidServer, Err: errors.New("server address is empty")}
	}
	var security mailclient.Security
	if slash := strings.LastIndex(raw, "/"); slash >= 0 {
		s, ok := mailclient.ParseSecurity(raw[slash+1:])
		if !ok {
			return mailclient.Endpoint{}, &mailclient.Error{Code: mailclient.CodeInvalidServer, Err: errors.New("unknown security " + raw[slash+1:])}
		}
		security = s
		raw = raw[:slash]
	}
	host, port := raw, defaultPort
	if h, p, err := net.SplitHostPort(raw); err == nil {
		n, convErr := strconv.Atoi(p)
		if convErr != nil {
			return mailclient.Endpoint{}, &mailclient.Error{Code: mailclient.CodeInvalidServer, Err: convErr}
		}
		host, port = h, n
	}
	if security == "" {
		security = securityForPort(port)
	}
	e := mailclient.Endpoint{Host: strings.ToLower(host), Port: port, Security: security}
	return e, e.Validate()
}

func securityForPort(port int) mailclient.Security {
	switch port {
	case 143, 587, 25:
		return mailclient.SecurityStartTLS
	}
	return mailclient.SecurityTLS
}

func mustServer(raw string, defaultPort int) mailclient.Endpoint {
	e, _ := parseServer(raw, defaultPort)
	return e
}

func serverOr(raw, fallback string, defaultPort int) mailclient.Endpoint {
	if e, err := parseServer(raw, defaultPort); err == nil {
		return e
	}
	return mustServer(fallback, defaultPort)
}

func (p *Plugin) providers() []Provider {
	cfg := p.getConfiguration()
	all := !cfg.EnableMailRu && !cfg.EnableVKWorkSpace && !cfg.EnableYandex && !cfg.EnableCustom

	var list []Provider
	if all || cfg.EnableVKWorkSpace {
		web := strings.TrimSpace(cfg.VKWorkSpaceWebURL)
		if web == "" {
			web = mailRuWeb
		}
		list = append(list, Provider{
			ID:             providerVKWorkSpace,
			Name:           "VK WorkSpace",
			IMAP:           serverOr(cfg.VKWorkSpaceIMAPServer, mailRuIMAP, defaultIMAP),
			SMTP:           serverOr(cfg.VKWorkSpaceSMTPServer, mailRuSMTP, defaultSMTP),
			WebURL:         web,
			AppPasswordURL: "https://account.mail.ru/user/2-step-auth/passwords/",
			HelpURL:        "https://help.mail.ru/biz/mail/",
		})
	}
	if all || cfg.EnableMailRu {
		list = append(list, Provider{
			ID:             providerMailRu,
			Name:           "Почта Mail.ru",
			IMAP:           mustServer(mailRuIMAP, defaultIMAP),
			SMTP:           mustServer(mailRuSMTP, defaultSMTP),
			WebURL:         mailRuWeb,
			AppPasswordURL: "https://account.mail.ru/user/2-step-auth/passwords/",
			HelpURL:        "https://help.mail.ru/mail/mailer/popsmtp",
			Domains:        []string{"mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru", "my.com", "mail.ua"},
		})
	}
	if all || cfg.EnableYandex {
		list = append(list, Provider{
			ID:             providerYandex,
			Name:           "Яндекс Почта",
			IMAP:           mustServer(yandexIMAP, defaultIMAP),
			SMTP:           mustServer(yandexSMTP, defaultSMTP),
			WebURL:         yandexWeb,
			AppPasswordURL: "https://id.yandex.ru/security/app-passwords",
			HelpURL:        "https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others",
			Domains:        []string{"yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz", "narod.ru"},
		})
	}
	if all || cfg.EnableCustom {
		list = append(list, Provider{
			ID:             providerCustom,
			Name:           "Другой IMAP-сервер",
			IMAP:           serverOr(cfg.CustomIMAPServer, "", defaultIMAP),
			SMTP:           serverOr(cfg.CustomSMTPServer, "", defaultSMTP),
			ServerEditable: true,
			WebURL:         strings.TrimSpace(cfg.CustomWebURL),
		})
	}
	recommended := cfg.DefaultProvider
	if recommended == "" {
		recommended = providerVKWorkSpace
	}
	for i := range list {
		if list[i].ID == recommended {
			list[i].Recommended = true
			// The recommended service goes first.
			list = append(append([]Provider{list[i]}, list[:i]...), list[i+1:]...)
			break
		}
	}
	return list
}

func (p *Plugin) provider(id string) (*Provider, bool) {
	for _, pr := range p.providers() {
		if pr.ID == id {
			return &pr, true
		}
	}
	return nil, false
}

// defaultProviderFor picks the provider to preselect in the wizard: by the
// user's e-mail domain first, then by the administrator's choice.
func (p *Plugin) defaultProviderFor(email string) string {
	providers := p.providers()
	domain := ""
	if at := strings.LastIndex(email, "@"); at >= 0 {
		domain = strings.ToLower(email[at+1:])
	}
	for _, pr := range providers {
		if slices.Contains(pr.Domains, domain) {
			return pr.ID
		}
	}
	if preferred := p.getConfiguration().DefaultProvider; preferred != "" {
		for _, pr := range providers {
			if pr.ID == preferred {
				return pr.ID
			}
		}
	}
	if len(providers) > 0 {
		return providers[0].ID
	}
	return ""
}

var errProviderDisabled = errors.New("этот сервис отключён администратором")

// resolveServers decides which servers to connect to.
//
//   - Mail.ru, Yandex and VK WorkSpace use the fixed or administrator's
//     servers, whatever the client sends.
//   - Custom servers use what the user typed. Private addresses are only
//     allowed when the administrator enabled them, or when the host is the
//     one the administrator configured.
func (p *Plugin) resolveServers(providerID string, imapIn, smtpIn mailclient.Endpoint) (mailclient.Endpoint, mailclient.Endpoint, error) {
	pr, ok := p.provider(providerID)
	if !ok {
		return mailclient.Endpoint{}, mailclient.Endpoint{}, errProviderDisabled
	}
	if !pr.ServerEditable {
		return pr.IMAP, pr.SMTP, nil
	}
	imapEndpoint := normalizeEndpoint(imapIn, pr.IMAP)
	smtpEndpoint := normalizeEndpoint(smtpIn, pr.SMTP)
	if smtpEndpoint.Host == "" {
		// Most servers receive and send mail on the same host.
		smtpEndpoint = mailclient.Endpoint{Host: imapEndpoint.Host, Port: defaultSMTP, Security: mailclient.SecurityTLS}
	}
	for _, e := range []mailclient.Endpoint{imapEndpoint, smtpEndpoint} {
		if err := e.Validate(); err != nil {
			return mailclient.Endpoint{}, mailclient.Endpoint{}, err
		}
	}
	return imapEndpoint, smtpEndpoint, nil
}

func normalizeEndpoint(in, fallback mailclient.Endpoint) mailclient.Endpoint {
	out := mailclient.Endpoint{Host: strings.ToLower(strings.TrimSpace(in.Host)), Port: in.Port, Security: in.Security}
	if out.Host == "" {
		return fallback
	}
	if out.Port == 0 {
		out.Port = fallback.Port
	}
	if s, ok := mailclient.ParseSecurity(string(out.Security)); ok {
		out.Security = s
	} else {
		out.Security = securityForPort(out.Port)
	}
	return out
}

// allowPrivateFor re-evaluates the private network policy for an account,
// so that tightening the settings applies to existing users too.
func (p *Plugin) allowPrivateFor(providerID string, endpoints ...mailclient.Endpoint) bool {
	switch providerID {
	case providerMailRu, providerYandex:
		return false
	case providerVKWorkSpace:
		// The administrator chose these servers.
		return true
	}
	cfg := p.getConfiguration()
	if cfg.AllowPrivateNetworks {
		return true
	}
	trusted := map[string]bool{}
	for _, raw := range []string{cfg.CustomIMAPServer, cfg.CustomSMTPServer} {
		if e, err := parseServer(raw, defaultIMAP); err == nil {
			trusted[e.Host] = true
		}
	}
	for _, e := range endpoints {
		if !trusted[strings.ToLower(e.Host)] {
			return false
		}
	}
	return len(endpoints) > 0
}

func (p *Plugin) policyFor(account *store.Account) mailclient.Policy {
	return mailclient.Policy{AllowPrivateNetworks: p.allowPrivateFor(account.Provider, account.IMAP, account.SMTP)}
}

// webURLFor returns the link that opens the provider's own web mail.
func (p *Plugin) webURLFor(providerID string) string {
	if pr, ok := p.provider(providerID); ok {
		return pr.WebURL
	}
	return ""
}
