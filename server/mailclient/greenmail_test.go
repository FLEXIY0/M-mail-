package mailclient

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestGreenMail runs against a real IMAP/SMTP server, the GreenMail service
// from docker-compose.yml: GREENMAIL_HOST=localhost go test ./server/mailclient/
func TestGreenMail(t *testing.T) {
	host := os.Getenv("GREENMAIL_HOST")
	if host == "" {
		t.Skip("GREENMAIL_HOST is not set")
	}
	ctx := context.Background()
	policy := Policy{AllowPrivateNetworks: true, Timeout: 10 * time.Second}
	imapEndpoint := Endpoint{Host: host, Port: 3143, Security: SecurityNone}
	smtpEndpoint := Endpoint{Host: host, Port: 3025, Security: SecurityNone}
	anna := Credentials{Username: "anna@example.ru", Password: "app-password"}
	ivan := Credentials{Username: "ivan@example.ru", Password: "app-password"}

	// GreenMail accepts any password, so wrong credentials are covered by
	// the in-memory server tests only.
	require.NoError(t, VerifySMTP(ctx, smtpEndpoint, anna, policy))

	conn, err := DialIMAP(ctx, imapEndpoint, ivan, policy)
	require.NoError(t, err)
	defer conn.Close()
	before, err := conn.Status(ctx, "INBOX")
	require.NoError(t, err)

	subject := "Проверка " + time.Now().Format("15:04:05.000")
	out := &Outgoing{
		From:        Address{Name: "Анна Смирнова", Email: anna.Username},
		To:          []Address{{Name: "Иван", Email: ivan.Username}},
		Subject:     subject,
		Text:        "Привет!\nВо вложении смета.",
		Attachments: []OutgoingAttachment{{Filename: "смета.txt", ContentType: "text/plain", Data: []byte("итого: 100")}},
	}
	raw, _, err := out.Build()
	require.NoError(t, err)
	require.NoError(t, Send(ctx, smtpEndpoint, anna, policy, anna.Username, out.Recipients(), raw))

	var fresh []Summary
	for i := 0; i < 20 && len(fresh) == 0; i++ {
		time.Sleep(200 * time.Millisecond)
		fresh, err = conn.NewSince(ctx, "INBOX", before.UIDNext, 5)
		require.NoError(t, err)
	}
	require.NotEmpty(t, fresh, "the message was delivered")
	assert.Equal(t, subject, fresh[0].Subject)
	assert.Equal(t, "Анна Смирнова", fresh[0].From[0].Name)
	assert.True(t, fresh[0].HasAttachments)

	msg, err := conn.Get(ctx, "INBOX", fresh[0].UID, true)
	require.NoError(t, err)
	assert.Equal(t, "Привет!\r\nВо вложении смета.", msg.Text)
	require.Len(t, msg.Attachment, 1)
	assert.Equal(t, "смета.txt", msg.Attachment[0].Filename)
	_, data, err := conn.Download(ctx, "INBOX", fresh[0].UID, msg.Attachment[0].Part)
	require.NoError(t, err)
	assert.Equal(t, "итого: 100", string(data))

	folders, err := conn.Folders(ctx)
	require.NoError(t, err)
	assert.Equal(t, RoleInbox, folders[0].Role)
}
