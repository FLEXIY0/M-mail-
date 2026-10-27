package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
)

func TestParseServer(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want mailclient.Endpoint
	}{
		{"imap.mail.ru:993", mailclient.Endpoint{Host: "imap.mail.ru", Port: 993, Security: mailclient.SecurityTLS}},
		{"Mail.Company.ru:143", mailclient.Endpoint{Host: "mail.company.ru", Port: 143, Security: mailclient.SecurityStartTLS}},
		{"mail.company.ru:587", mailclient.Endpoint{Host: "mail.company.ru", Port: 587, Security: mailclient.SecurityStartTLS}},
		{"mail.company.ru:2525/starttls", mailclient.Endpoint{Host: "mail.company.ru", Port: 2525, Security: mailclient.SecurityStartTLS}},
		{"10.0.0.5:143/none", mailclient.Endpoint{Host: "10.0.0.5", Port: 143, Security: mailclient.SecurityNone}},
		{"mail.company.ru", mailclient.Endpoint{Host: "mail.company.ru", Port: 993, Security: mailclient.SecurityTLS}},
		{" imaps://imap.yandex.ru:993 ", mailclient.Endpoint{Host: "imap.yandex.ru", Port: 993, Security: mailclient.SecurityTLS}},
	} {
		got, err := parseServer(tc.in, 993)
		require.NoError(t, err, tc.in)
		assert.Equal(t, tc.want, got, tc.in)
	}
	for _, bad := range []string{"", "host:abc", "host:993/rot13", "a b:993"} {
		_, err := parseServer(bad, 993)
		assert.Error(t, err, bad)
	}
}

func TestResolveServersAndPrivatePolicy(t *testing.T) {
	p := &Plugin{}
	p.setConfiguration(&configuration{
		EnableVKWorkSpace:     true,
		VKWorkSpaceIMAPServer: "mail.corp.ru:993",
		EnableMailRu:          true,
		EnableCustom:          true,
		CustomIMAPServer:      "10.1.1.1:143",
	})

	// Fixed providers ignore what the browser sends.
	imapEndpoint, smtpEndpoint, err := p.resolveServers(providerMailRu, mailclient.Endpoint{Host: "evil.example", Port: 993}, mailclient.Endpoint{})
	require.NoError(t, err)
	assert.Equal(t, "imap.mail.ru", imapEndpoint.Host)
	assert.Equal(t, "smtp.mail.ru", smtpEndpoint.Host)

	imapEndpoint, smtpEndpoint, err = p.resolveServers(providerVKWorkSpace, mailclient.Endpoint{Host: "evil.example", Port: 993}, mailclient.Endpoint{})
	require.NoError(t, err)
	assert.Equal(t, "mail.corp.ru", imapEndpoint.Host, "administrator's on-premises server")
	assert.Equal(t, "smtp.mail.ru", smtpEndpoint.Host, "default SMTP when not configured")

	// Custom: SMTP defaults to the IMAP host.
	imapEndpoint, smtpEndpoint, err = p.resolveServers(providerCustom, mailclient.Endpoint{Host: "Mail.Example.com", Port: 143}, mailclient.Endpoint{})
	require.NoError(t, err)
	assert.Equal(t, mailclient.Endpoint{Host: "mail.example.com", Port: 143, Security: mailclient.SecurityStartTLS}, imapEndpoint)
	assert.Equal(t, mailclient.Endpoint{Host: "mail.example.com", Port: 465, Security: mailclient.SecurityTLS}, smtpEndpoint)

	_, _, err = p.resolveServers(providerYandex, mailclient.Endpoint{}, mailclient.Endpoint{})
	assert.ErrorIs(t, err, errProviderDisabled)

	assert.False(t, p.allowPrivateFor(providerMailRu, imapEndpoint))
	assert.True(t, p.allowPrivateFor(providerVKWorkSpace, imapEndpoint))
	assert.False(t, p.allowPrivateFor(providerCustom, mailclient.Endpoint{Host: "192.168.0.10"}))
	assert.True(t, p.allowPrivateFor(providerCustom, mailclient.Endpoint{Host: "10.1.1.1"}), "the administrator's server is trusted")
	assert.False(t, p.allowPrivateFor(providerCustom, mailclient.Endpoint{Host: "10.1.1.1"}, mailclient.Endpoint{Host: "10.9.9.9"}))
}

func TestFormatShared(t *testing.T) {
	msg := &mailclient.Message{
		Summary: mailclient.Summary{Subject: "Отчёт *срочно*", From: []mailclient.Address{{Name: "Анна", Email: "anna@example.ru"}}},
		Text:    "Строка 1\nСтрока 2",
	}
	got := formatShared("Посмотрите", msg)
	assert.Contains(t, got, "Посмотрите\n\n")
	assert.Contains(t, got, `:email: **Отчёт \*срочно\***`)
	assert.Contains(t, got, "От: Анна <anna@example.ru>")
	assert.Contains(t, got, "> Строка 1\n> Строка 2\n")
}
