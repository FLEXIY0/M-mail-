package mailclient

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	testUser     = "ivan@example.ru"
	testPassword = "app-password"
)

type testServer struct {
	endpoint Endpoint
	user     *imapmemserver.User
	policy   Policy
}

// startIMAP runs an in-memory IMAP server. With useTLS the server speaks
// implicit TLS with a self-signed certificate the client trusts.
func startIMAP(t *testing.T, useTLS bool) *testServer {
	t.Helper()
	mem := imapmemserver.New()
	user := imapmemserver.NewUser(testUser, testPassword)
	mem.AddUser(user)
	for _, name := range []string{"INBOX", "Отправленные", "Корзина", "Спам", "Работа"} {
		require.NoError(t, user.Create(name, nil))
	}
	server := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return mem.NewSession(), nil, nil
		},
		Caps:         imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapIMAP4rev2: {}},
		InsecureAuth: true,
		Logger:       nopLogger{},
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	policy := Policy{AllowPrivateNetworks: true, Timeout: 5 * time.Second}
	security := SecurityNone
	if useTLS {
		cert, pool := selfSigned(t)
		ln = tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{cert}})
		policy.TLSConfig = &tls.Config{RootCAs: pool, ServerName: "localhost"}
		security = SecurityTLS
	}
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { _ = server.Close() })
	port := ln.Addr().(*net.TCPAddr).Port
	return &testServer{endpoint: Endpoint{Host: "127.0.0.1", Port: port, Security: security}, user: user, policy: policy}
}

type nopLogger struct{}

func (nopLogger) Printf(string, ...interface{}) {}

func selfSigned(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	require.NoError(t, err)
	parsed, err := x509.ParseCertificate(der)
	require.NoError(t, err)
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

func (s *testServer) appendRaw(t *testing.T, folder, raw string, flags ...imap.Flag) {
	t.Helper()
	data := []byte(strings.ReplaceAll(raw, "\n", "\r\n"))
	_, err := s.user.Append(folder, literal{bytes.NewReader(data), int64(len(data))}, &imap.AppendOptions{Flags: flags, Time: time.Now()})
	require.NoError(t, err)
}

type literal struct {
	*bytes.Reader
	size int64
}

func (l literal) Size() int64 { return l.size }

func (s *testServer) dial(t *testing.T) *IMAP {
	t.Helper()
	conn, err := DialIMAP(context.Background(), s.endpoint, Credentials{Username: testUser, Password: testPassword}, s.policy)
	require.NoError(t, err)
	t.Cleanup(conn.Close)
	return conn
}

const plainCP1251 = "From: =?windows-1251?B?yOLg7SDP5fLw7uI=?= <ivan@example.ru>\n" +
	"To: team@example.ru\n" +
	"Subject: =?windows-1251?B?z+vg7bjw6uA=?=\n" +
	"Date: Mon, 26 Oct 2026 10:00:00 +0300\n" +
	"Message-ID: <first@example.ru>\n" +
	"MIME-Version: 1.0\n" +
	"Content-Type: text/plain; charset=windows-1251\n" +
	"Content-Transfer-Encoding: base64\n" +
	"\n" +
	"z/Do4uXyLCDq7uvr5ePoIQ==\n"

const multipartMessage = `From: Anna <anna@example.ru>
To: ivan@example.ru
Cc: boss@example.ru
Subject: Report
Date: Tue, 27 Oct 2026 09:30:00 +0300
Message-ID: <second@example.ru>
In-Reply-To: <first@example.ru>
References: <zero@example.ru> <first@example.ru>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed"

--mixed
Content-Type: multipart/related; boundary="related"

--related
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

=D0=9E=D1=82=D1=87=D1=91=D1=82 =D0=B3=D0=BE=D1=82=D0=BE=D0=B2
--alt
Content-Type: text/html; charset=utf-8

<html><body><p>Отчёт <b>готов</b></p><img src="cid:logo@x"></body></html>
--alt--
--related
Content-Type: image/png
Content-ID: <logo@x>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--related--
--mixed
Content-Type: application/pdf
Content-Disposition: attachment; filename*=utf-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--mixed--
`

func TestLoginErrors(t *testing.T) {
	s := startIMAP(t, false)
	_, err := DialIMAP(context.Background(), s.endpoint, Credentials{Username: testUser, Password: "wrong"}, s.policy)
	require.Error(t, err)
	assert.Equal(t, CodeUnauthorized, CodeOf(err))
	assert.True(t, IsAuth(err))

	blocked := s.policy
	blocked.AllowPrivateNetworks = false
	_, err = DialIMAP(context.Background(), s.endpoint, Credentials{Username: testUser, Password: testPassword}, blocked)
	assert.Equal(t, CodeBlockedAddress, CodeOf(err))

	closed := s.endpoint
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	closed.Port = ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	_, err = DialIMAP(context.Background(), closed, Credentials{Username: testUser, Password: testPassword}, s.policy)
	assert.Equal(t, CodeNetwork, CodeOf(err))
}

func TestTLSAndFolders(t *testing.T) {
	s := startIMAP(t, true)
	conn := s.dial(t)
	folders, err := conn.Folders(context.Background())
	require.NoError(t, err)
	roles := map[string]string{}
	for _, f := range folders {
		roles[f.Name] = f.Role
	}
	assert.Equal(t, RoleInbox, roles["INBOX"])
	assert.Equal(t, RoleSent, roles["Отправленные"])
	assert.Equal(t, RoleTrash, roles["Корзина"])
	assert.Equal(t, RoleJunk, roles["Спам"])
	assert.Equal(t, "", roles["Работа"])
	assert.Equal(t, "INBOX", folders[0].Name, "Inbox goes first")
	assert.Equal(t, "Работа", folders[len(folders)-1].Name, "user folders go last")
}

func TestListGetAndDownload(t *testing.T) {
	s := startIMAP(t, false)
	s.appendRaw(t, "INBOX", plainCP1251, imap.FlagSeen)
	s.appendRaw(t, "INBOX", multipartMessage)
	conn := s.dial(t)
	ctx := context.Background()

	page, err := conn.List(ctx, "INBOX", 0, 10)
	require.NoError(t, err)
	require.Len(t, page.Messages, 2)
	assert.Equal(t, 2, page.Total)
	assert.Equal(t, 1, page.Unseen)
	assert.False(t, page.HasMore)
	newest, oldest := page.Messages[0], page.Messages[1]
	assert.Equal(t, "Report", newest.Subject)
	assert.True(t, newest.HasAttachments, "the pdf is an attachment, the inline logo is not")
	assert.False(t, newest.Seen)
	assert.Equal(t, "Планёрка", oldest.Subject, "windows-1251 subject is decoded")
	assert.Equal(t, "Иван Петров", oldest.From[0].Name)
	assert.False(t, oldest.HasAttachments)

	paged, err := conn.List(ctx, "INBOX", 1, 1)
	require.NoError(t, err)
	require.Len(t, paged.Messages, 1)
	assert.Equal(t, oldest.UID, paged.Messages[0].UID)

	plain, err := conn.Get(ctx, "INBOX", oldest.UID, false)
	require.NoError(t, err)
	assert.Equal(t, "Привет, коллеги!", strings.TrimSpace(plain.Text))
	assert.Empty(t, plain.HTML)

	msg, err := conn.Get(ctx, "INBOX", newest.UID, true)
	require.NoError(t, err)
	assert.True(t, msg.Seen, "opening marks as read")
	assert.Equal(t, "Отчёт готов", strings.TrimSpace(msg.Text))
	assert.Contains(t, msg.HTML, "<b>готов</b>")
	assert.Contains(t, msg.HTML, "data:image/png;base64,iVBORw0KGgo=", "cid: image is embedded")
	assert.Equal(t, "first@example.ru", msg.InReplyTo)
	assert.Equal(t, []string{"zero@example.ru", "first@example.ru"}, msg.References)
	assert.Equal(t, "boss@example.ru", msg.Cc[0].Email)
	require.Len(t, msg.Attachment, 1)
	att := msg.Attachment[0]
	assert.Equal(t, "отчёт.pdf", att.Filename)
	assert.Equal(t, "application/pdf", att.ContentType)

	meta, data, err := conn.Download(ctx, "INBOX", newest.UID, att.Part)
	require.NoError(t, err)
	assert.Equal(t, "отчёт.pdf", meta.Filename)
	assert.Equal(t, "%PDF-1.4\n", string(data))

	_, _, err = conn.Download(ctx, "INBOX", newest.UID, "9")
	assert.Equal(t, CodeNotFound, CodeOf(err))

	status, err := conn.Status(ctx, "INBOX")
	require.NoError(t, err)
	assert.Equal(t, 0, status.Unseen)
}

func TestFlagsMoveDelete(t *testing.T) {
	s := startIMAP(t, false)
	s.appendRaw(t, "INBOX", plainCP1251)
	s.appendRaw(t, "INBOX", multipartMessage)
	conn := s.dial(t)
	ctx := context.Background()

	page, err := conn.List(ctx, "INBOX", 0, 10)
	require.NoError(t, err)
	uid := page.Messages[0].UID

	require.NoError(t, conn.SetFlags(ctx, "INBOX", []uint32{uid}, "flagged", true))
	require.NoError(t, conn.SetFlags(ctx, "INBOX", []uint32{uid}, "seen", true))
	page, err = conn.List(ctx, "INBOX", 0, 10)
	require.NoError(t, err)
	assert.True(t, page.Messages[0].Flagged)
	assert.True(t, page.Messages[0].Seen)

	require.NoError(t, conn.Move(ctx, "INBOX", []uint32{uid}, "Работа"))
	work, err := conn.List(ctx, "Работа", 0, 10)
	require.NoError(t, err)
	require.Len(t, work.Messages, 1)

	permanent, err := conn.Delete(ctx, "Работа", []uint32{work.Messages[0].UID})
	require.NoError(t, err)
	assert.False(t, permanent, "first delete moves to trash")
	trash, err := conn.List(ctx, "Корзина", 0, 10)
	require.NoError(t, err)
	require.Len(t, trash.Messages, 1)

	permanent, err = conn.Delete(ctx, "Корзина", []uint32{trash.Messages[0].UID})
	require.NoError(t, err)
	assert.True(t, permanent, "delete in trash is permanent")
	trash, err = conn.List(ctx, "Корзина", 0, 10)
	require.NoError(t, err)
	assert.Empty(t, trash.Messages)
}

func TestSearchAndNewSince(t *testing.T) {
	s := startIMAP(t, false)
	s.appendRaw(t, "INBOX", plainCP1251)
	conn := s.dial(t)
	ctx := context.Background()

	status, err := conn.Status(ctx, "INBOX")
	require.NoError(t, err)
	before := status.UIDNext

	fresh, err := conn.NewSince(ctx, "INBOX", before, 5)
	require.NoError(t, err)
	assert.Empty(t, fresh, "the last old message is not new")

	s.appendRaw(t, "INBOX", multipartMessage)
	fresh, err = conn.NewSince(ctx, "INBOX", before, 5)
	require.NoError(t, err)
	require.Len(t, fresh, 1)
	assert.Equal(t, "Report", fresh[0].Subject)

	found, err := conn.Search(ctx, "INBOX", "report", 10)
	require.NoError(t, err)
	require.Len(t, found.Messages, 1)
	assert.Equal(t, "Report", found.Messages[0].Subject)

	has, err := conn.HasMessageID(ctx, "INBOX", "second@example.ru")
	require.NoError(t, err)
	assert.True(t, has)
	has, err = conn.HasMessageID(ctx, "INBOX", "missing@example.ru")
	require.NoError(t, err)
	assert.False(t, has)
}

// smtpRecorder is a tiny SMTP backend that remembers delivered messages.
type smtpRecorder struct {
	mu       sync.Mutex
	from     string
	to       []string
	data     []byte
	password string
}

func (b *smtpRecorder) NewSession(*smtp.Conn) (smtp.Session, error) { return &smtpSession{b: b}, nil }

type smtpSession struct {
	b    *smtpRecorder
	auth bool
}

func (s *smtpSession) AuthMechanisms() []string { return []string{sasl.Plain} }

func (s *smtpSession) Auth(string) (sasl.Server, error) {
	return sasl.NewPlainServer(func(_, username, password string) error {
		if username != testUser || password != s.b.password {
			return errors.New("invalid credentials")
		}
		s.auth = true
		return nil
	}), nil
}

func (s *smtpSession) Mail(from string, _ *smtp.MailOptions) error {
	if !s.auth {
		return smtp.ErrAuthRequired
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.from = from
	return nil
}

func (s *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.to = append(s.b.to, to)
	return nil
}

func (s *smtpSession) Data(r io.Reader) error {
	data, err := io.ReadAll(r)
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.b.data = data
	return err
}

func (s *smtpSession) Reset()        {}
func (s *smtpSession) Logout() error { return nil }

func startSMTP(t *testing.T) (*smtpRecorder, Endpoint) {
	t.Helper()
	rec := &smtpRecorder{password: testPassword}
	server := smtp.NewServer(rec)
	server.AllowInsecureAuth = true
	server.Domain = "localhost"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { _ = server.Close() })
	return rec, Endpoint{Host: "127.0.0.1", Port: ln.Addr().(*net.TCPAddr).Port, Security: SecurityNone}
}

func TestBuildAndSend(t *testing.T) {
	rec, endpoint := startSMTP(t)
	policy := Policy{AllowPrivateNetworks: true, Timeout: 5 * time.Second}
	creds := Credentials{Username: testUser, Password: testPassword}

	require.NoError(t, VerifySMTP(context.Background(), endpoint, creds, policy))
	err := VerifySMTP(context.Background(), endpoint, Credentials{Username: testUser, Password: "bad"}, policy)
	assert.Equal(t, CodeUnauthorized, CodeOf(err))

	out := &Outgoing{
		From:        Address{Name: "Иван Петров", Email: testUser},
		To:          []Address{{Name: "Анна", Email: "anna@example.ru"}},
		Cc:          []Address{{Email: "boss@example.ru"}},
		Bcc:         []Address{{Email: "secret@example.ru"}, {Email: "ANNA@example.ru"}},
		Subject:     "Re: Отчёт",
		Text:        "Спасибо!\n\n> Отчёт готов",
		InReplyTo:   "second@example.ru",
		References:  []string{"first@example.ru", "second@example.ru"},
		Attachments: []OutgoingAttachment{{Filename: "смета.xlsx", ContentType: "application/vnd.ms-excel", Data: []byte("xlsx-bytes")}},
	}
	assert.Equal(t, []string{"anna@example.ru", "boss@example.ru", "secret@example.ru"}, out.Recipients())

	raw, messageID, err := out.Build()
	require.NoError(t, err)
	assert.True(t, strings.HasSuffix(messageID, "@example.ru"), messageID)
	assert.NotContains(t, string(raw), "secret@example.ru", "Bcc is not written into headers")

	require.NoError(t, Send(context.Background(), endpoint, creds, policy, testUser, out.Recipients(), raw))
	rec.mu.Lock()
	defer rec.mu.Unlock()
	assert.Equal(t, testUser, rec.from)
	assert.ElementsMatch(t, out.Recipients(), rec.to)

	reader, err := mail.CreateReader(bytes.NewReader(rec.data))
	require.NoError(t, err)
	subject, _ := reader.Header.Subject()
	assert.Equal(t, "Re: Отчёт", subject)
	inReplyTo, _ := reader.Header.MsgIDList("In-Reply-To")
	assert.Equal(t, []string{"second@example.ru"}, inReplyTo)
	from, _ := reader.Header.AddressList("From")
	assert.Equal(t, "Иван Петров", from[0].Name)

	var text, filename string
	var fileData []byte
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		switch h := part.Header.(type) {
		case *mail.InlineHeader:
			b, _ := io.ReadAll(part.Body)
			text = string(b)
		case *mail.AttachmentHeader:
			filename, _ = h.Filename()
			fileData, _ = io.ReadAll(part.Body)
		}
	}
	assert.Equal(t, "Спасибо!\r\n\r\n> Отчёт готов", text)
	assert.Equal(t, "смета.xlsx", filename)
	assert.Equal(t, "xlsx-bytes", string(fileData))
}

func TestHTMLToText(t *testing.T) {
	html := `<html><head><style>p{color:red}</style></head><body><p>Привет&nbsp;мир</p><ul><li>один</li><li>два</li></ul><script>alert(1)</script>Конец<br>строки</body></html>`
	assert.Equal(t, "Привет мир\n\n• один\n• два\nКонец\nстроки", HTMLToText(html))
}

func TestParseHelpers(t *testing.T) {
	path, err := ParsePart("1.2.3")
	require.NoError(t, err)
	assert.Equal(t, []int{1, 2, 3}, path)
	for _, bad := range []string{"", "0", "1..2", "a", "-1"} {
		_, err = ParsePart(bad)
		assert.Error(t, err, bad)
	}
	assert.Equal(t, "Отчёт.pdf", decode2231("utf-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf"))
	assert.Equal(t, "Отчёт", decodeWords("=?utf-8?B?0J7RgtGH0ZHRgg==?="))
	assert.Equal(t, "a_b_c", sanitizeFilename("a/b\\c"))
	sec, ok := ParseSecurity("SSL")
	assert.True(t, ok)
	assert.Equal(t, SecurityTLS, sec)
	assert.Error(t, Endpoint{Host: "imap.example.com", Port: 0, Security: SecurityTLS}.Validate())
	assert.Error(t, Endpoint{Host: "imap.example.com/x", Port: 993, Security: SecurityTLS}.Validate())
	assert.NoError(t, Endpoint{Host: "imap.example.com", Port: 993, Security: SecurityTLS}.Validate())
	assert.Equal(t, "imap.example.com:993", Endpoint{Host: "imap.example.com", Port: 993}.Address())
}
