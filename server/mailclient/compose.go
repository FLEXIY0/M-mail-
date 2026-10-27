package mailclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"regexp"
	"strings"
	"time"

	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// OutgoingAttachment is a file attached to a new message.
type OutgoingAttachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

// Outgoing is a message to send.
type Outgoing struct {
	From        Address
	To          []Address
	Cc          []Address
	Bcc         []Address
	Subject     string
	Text        string
	InReplyTo   string
	References  []string
	Attachments []OutgoingAttachment
	Date        time.Time
}

// Recipients returns every envelope recipient, deduplicated.
func (o *Outgoing) Recipients() []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range [][]Address{o.To, o.Cc, o.Bcc} {
		for _, a := range list {
			key := strings.ToLower(a.Email)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, a.Email)
		}
	}
	return out
}

func toMailAddresses(list []Address) []*mail.Address {
	out := make([]*mail.Address, 0, len(list))
	for _, a := range list {
		out = append(out, &mail.Address{Name: a.Name, Address: a.Email})
	}
	return out
}

// Build renders the message as RFC 5322 bytes. Bcc is not written into the
// headers. It returns the generated Message-ID (without brackets).
func (o *Outgoing) Build() ([]byte, string, error) {
	var h mail.Header
	date := o.Date
	if date.IsZero() {
		date = time.Now()
	}
	h.SetDate(date)
	h.SetAddressList("From", toMailAddresses([]Address{o.From}))
	if len(o.To) > 0 {
		h.SetAddressList("To", toMailAddresses(o.To))
	}
	if len(o.Cc) > 0 {
		h.SetAddressList("Cc", toMailAddresses(o.Cc))
	}
	h.SetSubject(o.Subject)
	domain := "mattermost.local"
	if at := strings.LastIndex(o.From.Email, "@"); at >= 0 && at < len(o.From.Email)-1 {
		domain = o.From.Email[at+1:]
	}
	if err := h.GenerateMessageIDWithHostname(domain); err != nil {
		return nil, "", err
	}
	messageID, _ := h.MessageID()
	if o.InReplyTo != "" {
		h.SetMsgIDList("In-Reply-To", []string{strings.Trim(o.InReplyTo, "<>")})
	}
	if len(o.References) > 0 {
		h.SetMsgIDList("References", o.References)
	}
	h.Set("MIME-Version", "1.0")
	h.Set("User-Agent", "Mattermost Mail Plugin")

	text := normalizeNewlines(o.Text)
	var buf bytes.Buffer
	if len(o.Attachments) == 0 {
		var ih mail.InlineHeader
		ih.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
		h.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
		h.Set("Content-Transfer-Encoding", "quoted-printable")
		w, err := mail.CreateSingleInlineWriter(&buf, h)
		if err != nil {
			return nil, "", err
		}
		if _, err = io.WriteString(w, text); err != nil {
			return nil, "", err
		}
		if err = w.Close(); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), messageID, nil
	}

	w, err := mail.CreateWriter(&buf, h)
	if err != nil {
		return nil, "", err
	}
	var ih mail.InlineHeader
	ih.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
	ih.Set("Content-Transfer-Encoding", "quoted-printable")
	tw, err := w.CreateSingleInline(ih)
	if err != nil {
		return nil, "", err
	}
	if _, err = io.WriteString(tw, text); err != nil {
		return nil, "", err
	}
	if err = tw.Close(); err != nil {
		return nil, "", err
	}
	for _, a := range o.Attachments {
		var ah mail.AttachmentHeader
		contentType := a.ContentType
		if _, _, parseErr := mime.ParseMediaType(contentType); contentType == "" || parseErr != nil {
			contentType = "application/octet-stream"
		}
		ah.SetContentType(contentType, nil)
		ah.SetFilename(sanitizeFilename(a.Filename))
		ah.Set("Content-Transfer-Encoding", "base64")
		aw, err := w.CreateAttachment(ah)
		if err != nil {
			return nil, "", err
		}
		if _, err = aw.Write(a.Data); err != nil {
			return nil, "", err
		}
		if err = aw.Close(); err != nil {
			return nil, "", err
		}
	}
	if err = w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), messageID, nil
}

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}

// openSMTP connects and authenticates. The caller must Close the client.
func openSMTP(ctx context.Context, endpoint Endpoint, creds Credentials, policy Policy) (*smtp.Client, error) {
	conn, err := dial(ctx, endpoint, policy, "smtp connect")
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	host := strings.TrimSpace(endpoint.Host)

	var client *smtp.Client
	switch security, _ := ParseSecurity(string(endpoint.Security)); security {
	case SecurityTLS:
		tlsConn, hsErr := handshake(ctx, conn, host, policy, "smtp connect")
		if hsErr != nil {
			return nil, hsErr
		}
		client = smtp.NewClient(tlsConn)
	case SecurityStartTLS:
		client, err = smtp.NewClientStartTLS(conn, policy.tlsConfig(host))
		if err != nil {
			_ = conn.Close()
			return nil, classifySMTPSetup("smtp starttls", err)
		}
	default:
		client = smtp.NewClient(conn)
	}

	if err = client.Hello("mattermost"); err != nil {
		_ = client.Close()
		return nil, classifySMTPSetup("smtp hello", err)
	}
	if ok, _ := client.Extension("AUTH"); ok {
		var auth sasl.Client
		switch {
		case client.SupportsAuth("PLAIN"):
			auth = sasl.NewPlainClient("", creds.Username, creds.Password)
		case client.SupportsAuth("LOGIN"):
			auth = sasl.NewLoginClient(creds.Username, creds.Password)
		default:
			_ = client.Close()
			return nil, newError(CodeServer, "smtp auth", errors.New("the server supports neither AUTH PLAIN nor AUTH LOGIN"))
		}
		if err = client.Auth(auth); err != nil {
			_ = client.Close()
			return nil, classify("smtp auth", err)
		}
	}
	return client, nil
}

// VerifySMTP checks that the server accepts the credentials for sending.
func VerifySMTP(ctx context.Context, endpoint Endpoint, creds Credentials, policy Policy) error {
	ctx, cancel := context.WithTimeout(ctx, policy.timeout())
	defer cancel()
	client, err := openSMTP(ctx, endpoint, creds, policy)
	if err != nil {
		return err
	}
	_ = client.Quit()
	_ = client.Close()
	return nil
}

// Send delivers a built message over SMTP.
func Send(ctx context.Context, endpoint Endpoint, creds Credentials, policy Policy, from string, recipients []string, raw []byte) error {
	if len(recipients) == 0 {
		return newError(CodeRejected, "smtp", errors.New("no recipients"))
	}
	ctx, cancel := context.WithTimeout(ctx, 3*policy.timeout())
	defer cancel()

	client, err := openSMTP(ctx, endpoint, creds, policy)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	if max, ok := client.MaxMessageSize(); ok && max > 0 && len(raw) > max {
		return newError(CodeTooLarge, "smtp", fmt.Errorf("message is %d bytes, the server accepts up to %d", len(raw), max))
	}
	if err = client.SendMail(from, recipients, bytes.NewReader(raw)); err != nil {
		return classify("smtp send", err)
	}
	_ = client.Quit()
	return nil
}

func classifySMTPSetup(op string, err error) error {
	merr := classify(op, err)
	if merr.Code == CodeUnknown {
		merr.Code = CodeTLS
	}
	return merr
}

var (
	reBlockTags = regexp.MustCompile(`(?is)<(script|style|head|title)[^>]*>.*?</(script|style|head|title)>`)
	reBreaks    = regexp.MustCompile(`(?i)<\s*(br|/p|/div|/tr|/h[1-6]|/table|/ul|/ol)\s*/?>`)
	reListItem  = regexp.MustCompile(`(?i)<\s*li[^>]*>`)
	reTags      = regexp.MustCompile(`(?s)<[^>]*>`)
	reSpaces    = regexp.MustCompile(`[ \t\x{00a0}]+`)
	reEmpty     = regexp.MustCompile(`\n\s*\n\s*\n+`)
)

// HTMLToText turns an HTML body into readable plain text: for quoting in
// replies, previews in notifications and mail without a text part.
func HTMLToText(s string) string {
	s = reBlockTags.ReplaceAllString(s, "")
	s = reBreaks.ReplaceAllString(s, "\n")
	s = reListItem.ReplaceAllString(s, "\n• ")
	s = reTags.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reSpaces.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	s = strings.Join(lines, "\n")
	s = reEmpty.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}
