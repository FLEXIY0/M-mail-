package mailclient

import (
	"bufio"
	"net"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Mail.ru and VK WorkSpace put NIL into body parameters of multiparts, e.g.
// ("boundary" NIL). The parser must not fail the whole FETCH on it.
const nilParamFetch = `* 1 FETCH (UID 7 BODYSTRUCTURE ((("text" "plain" ("charset" "utf-8") NIL NIL "base64" 120 2 NIL NIL NIL NIL)` +
	`("text" "html" ("charset" NIL) NIL NIL "quoted-printable" 300 6 NIL NIL NIL NIL) "alternative" ("boundary" NIL) NIL NIL NIL)` +
	`("application" "pdf" ("name" "smeta.pdf") NIL NIL "base64" 1000 NIL ("attachment" ("filename" NIL)) (NIL) NIL) "mixed" ("boundary" "b1" "x-unknown" NIL) NIL (NIL "ru") NIL))`

func TestFetchToleratesNilParams(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer func() { _ = clientConn.Close() }()
	go func() {
		defer func() { _ = serverConn.Close() }()
		w := bufio.NewWriter(serverConn)
		r := bufio.NewReader(serverConn)
		_, _ = w.WriteString("* OK [CAPABILITY IMAP4rev1] ready\r\n")
		_ = w.Flush()
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			tag := strings.Fields(line)[0]
			if strings.Contains(line, "FETCH") {
				_, _ = w.WriteString(nilParamFetch + "\r\n")
			}
			_, _ = w.WriteString(tag + " OK done\r\n")
			_ = w.Flush()
		}
	}()

	c := imapclient.New(clientConn, nil)
	defer func() { _ = c.Close() }()
	require.NoError(t, c.WaitGreeting())
	bufs, err := c.Fetch(imap.UIDSetNum(7), &imap.FetchOptions{UID: true, BodyStructure: &imap.FetchItemBodyStructure{Extended: true}}).Collect()
	require.NoError(t, err)
	require.Len(t, bufs, 1)

	mp, ok := bufs[0].BodyStructure.(*imap.BodyStructureMultiPart)
	require.True(t, ok)
	assert.Equal(t, "mixed", strings.ToLower(mp.Subtype))
	assert.Equal(t, "b1", mp.Extended.Params["boundary"])
	require.Len(t, mp.Children, 2)
	pdf, ok := mp.Children[1].(*imap.BodyStructureSinglePart)
	require.True(t, ok)
	assert.Equal(t, "smeta.pdf", pdf.Params["name"])
	assert.Equal(t, "smeta.pdf", partFilename(pdf), "a NIL filename falls back to the name")

	plain, html, _ := findTextParts(mp)
	assert.NotNil(t, plain)
	assert.NotNil(t, html)
}
