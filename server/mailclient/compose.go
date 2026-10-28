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

	"github.com/emersion/go-message"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-message/textproto"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// InlineImage is a picture referenced from the HTML body as cid:ContentID,
// e.g. the photo in a signature. Unlike data: URLs, such pictures are
// shown by Mail.ru, Gmail and Outlook alike.
type InlineImage struct {
	ContentID   string
	ContentType string
	Filename    string
	Data        []byte
}

// OutgoingAttachment is a file attached to a new message.
type OutgoingAttachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

// Outgoing is a message to send.
type Outgoing struct {
	From    Address
	To      []Address
	Cc      []Address
	Bcc     []Address
	Subject string
	Text    string
	// HTML is optional; when set the message carries both versions
	// (multipart/alternative), e.g. to keep the formatting of a quote.
	HTML        string
	InReplyTo   string
	References  []string
	Attachments []OutgoingAttachment
	Inline      []InlineImage
	Date        time.Time
	// KeepBcc writes Bcc into the headers: drafts must remember it, sent
	// messages must not show it.
	KeepBcc bool
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
	if o.KeepBcc && len(o.Bcc) > 0 {
		h.SetAddressList("Bcc", toMailAddresses(o.Bcc))
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
	html := normalizeNewlines(o.HTML)

	// The body is a tree: text, or text and HTML side by side
	// (alternative), with pictures for the HTML (related), with files
	// (mixed). Only the levels that are needed are created.
	body := leafPart("text/plain", map[string]string{"charset": "utf-8"}, "quoted-printable", []byte(text))
	if html != "" {
		body = multiPart("alternative", body, leafPart("text/html", map[string]string{"charset": "utf-8"}, "quoted-printable", []byte(html)))
		if len(o.Inline) > 0 {
			related := []*mimePart{body}
			for _, img := range o.Inline {
				related = append(related, inlinePart(img))
			}
			body = multiPart("related", related...)
		}
	}
	if len(o.Attachments) > 0 {
		mixed := []*mimePart{body}
		for _, a := range o.Attachments {
			mixed = append(mixed, attachmentPart(a))
		}
		body = multiPart("mixed", mixed...)
	}

	top := h.Header.Copy()
	for _, f := range []string{"Content-Type", "Content-Transfer-Encoding", "Content-Disposition"} {
		top.Del(f)
	}
	body.header.Header = mergeHeaders(top.Header, body.header.Header)
	var buf bytes.Buffer
	if err := body.write(&buf, nil); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), messageID, nil
}

// mimePart is a node of the message body tree.
type mimePart struct {
	header   message.Header
	body     []byte
	children []*mimePart
}

func leafPart(mediaType string, params map[string]string, encoding string, body []byte) *mimePart {
	p := &mimePart{body: body}
	p.header.SetContentType(mediaType, params)
	p.header.Set("Content-Transfer-Encoding", encoding)
	return p
}

func multiPart(subtype string, children ...*mimePart) *mimePart {
	p := &mimePart{children: children}
	p.header.SetContentType("multipart/"+subtype, nil)
	return p
}

func safeContentType(contentType, fallback string) string {
	if t, _, err := mime.ParseMediaType(contentType); err == nil && t != "" && !strings.HasPrefix(t, "multipart/") {
		return t
	}
	return fallback
}

func attachmentPart(a OutgoingAttachment) *mimePart {
	var ah mail.AttachmentHeader
	ah.SetContentType(safeContentType(a.ContentType, "application/octet-stream"), nil)
	ah.SetFilename(sanitizeFilename(a.Filename))
	ah.Set("Content-Transfer-Encoding", "base64")
	return &mimePart{header: ah.Header, body: a.Data}
}

func inlinePart(img InlineImage) *mimePart {
	var ih mail.AttachmentHeader
	ih.SetContentType(safeContentType(img.ContentType, "image/png"), nil)
	ih.SetFilename(sanitizeFilename(img.Filename))
	ih.SetContentDisposition("inline", map[string]string{"filename": sanitizeFilename(img.Filename)})
	ih.Set("Content-ID", "<"+strings.Trim(img.ContentID, "<>")+">")
	ih.Set("Content-Transfer-Encoding", "base64")
	return &mimePart{header: ih.Header, body: img.Data}
}

func mergeHeaders(top, part textproto.Header) textproto.Header {
	out := top.Copy()
	fields := part.Fields()
	for fields.Next() {
		out.Add(fields.Key(), fields.Value())
	}
	return out
}

// write renders the part; parent is nil for the message itself.
func (p *mimePart) write(w io.Writer, parent *message.Writer) error {
	var mw *message.Writer
	var err error
	if parent == nil {
		mw, err = message.CreateWriter(w, p.header)
	} else {
		mw, err = parent.CreatePart(p.header)
	}
	if err != nil {
		return err
	}
	if len(p.children) > 0 {
		for _, c := range p.children {
			if err = c.write(nil, mw); err != nil {
				return err
			}
		}
	} else if _, err = mw.Write(p.body); err != nil {
		return err
	}
	return mw.Close()
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
