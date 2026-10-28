package mailclient

import (
	"archive/zip"
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/text/encoding/charmap"
)

func TestEffectiveType(t *testing.T) {
	assert.Equal(t, "application/pdf", EffectiveType("application/octet-stream", "Смета.PDF"))
	assert.Equal(t, "image/jpeg", EffectiveType("image/jpg", "a.jpg"))
	assert.Equal(t, "application/zip", EffectiveType("application/x-zip-compressed", "a.zip"))
	assert.Equal(t, "text/plain", EffectiveType("TEXT/PLAIN; charset=utf-8", "a"))
	assert.Equal(t, "application/vnd.ms-excel", EffectiveType("application/vnd.ms-excel", "a.xls"))
	assert.Equal(t, "application/octet-stream", EffectiveType("", "a.bin"))
}

func TestTextOf(t *testing.T) {
	cp1251, _ := charmap.Windows1251.NewEncoder().String("Привет, мир")
	text, truncated := TextOf([]byte(cp1251), "windows-1251")
	assert.Equal(t, "Привет, мир", text)
	assert.False(t, truncated)

	text, _ = TextOf([]byte(cp1251), "")
	assert.Equal(t, "Привет, мир", text, "Russian text without a charset is windows-1251")

	text, _ = TextOf([]byte("\xEF\xBB\xBFstart;конец"), "")
	assert.Equal(t, "start;конец", text, "the BOM is dropped")

	big := bytes.Repeat([]byte("я"), MaxViewText)
	text, truncated = TextOf(big, "utf-8")
	assert.True(t, truncated)
	assert.NotContains(t, text, "�", "a letter cut in half is dropped")
}

func makeZip(t *testing.T, files map[string]string, cp866 bool) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if cp866 {
			encoded, err := charmap.CodePage866.NewEncoder().String(name)
			require.NoError(t, err)
			h.Name, h.NonUTF8 = encoded, true
		}
		w, err := zw.CreateHeader(h)
		require.NoError(t, err)
		_, _ = w.Write([]byte(content))
	}
	require.NoError(t, zw.Close())
	return buf.Bytes()
}

func TestZip(t *testing.T) {
	data := makeZip(t, map[string]string{"Договор.docx": "doc", "папка/Смета.txt": "смета"}, true)
	entries, more, err := ZipEntries(data)
	require.NoError(t, err)
	assert.False(t, more)
	names := map[string]int{}
	for _, e := range entries {
		names[e.Name] = e.Index
	}
	require.Contains(t, names, "Договор.docx", "CP866 names of Windows archives")
	require.Contains(t, names, "папка/Смета.txt")

	name, content, err := ZipFile(data, names["папка/Смета.txt"])
	require.NoError(t, err)
	assert.Equal(t, "Смета.txt", name)
	assert.Equal(t, "смета", string(content))

	_, _, err = ZipFile(data, 99)
	assert.Error(t, err)
	_, _, err = ZipEntries([]byte("not a zip"))
	assert.Error(t, err)
}

const embeddedMessage = "From: Anna <anna@example.ru>\r\n" +
	"To: Ivan <ivan@example.ru>\r\n" +
	"Subject: =?utf-8?B?0KHQvNC10YLQsA==?=\r\n" +
	"Date: Mon, 26 Oct 2026 10:00:00 +0300\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=b1\r\n\r\n" +
	"--b1\r\nContent-Type: text/plain; charset=windows-1251\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" +
	"\xcf\xf0\xe8\xe2\xe5\xf2\r\n" +
	"--b1\r\nContent-Type: application/pdf; name=\"smeta.pdf\"\r\nContent-Disposition: attachment; filename=\"smeta.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
	"JVBERi0xLjQK\r\n" +
	"--b1--\r\n"

func TestEmbedded(t *testing.T) {
	msg, err := ParseEmbedded([]byte(embeddedMessage))
	require.NoError(t, err)
	assert.Equal(t, "Смета", msg.Subject)
	assert.Equal(t, "anna@example.ru", msg.From[0].Email)
	assert.Equal(t, "Привет", msg.Text, "charset of the part is applied")
	require.Len(t, msg.Attachments, 1)
	assert.Equal(t, "smeta.pdf", msg.Attachments[0].Filename)
	assert.Equal(t, int64(9), msg.Attachments[0].Size)

	meta, data, err := EmbeddedPart([]byte(embeddedMessage), 2)
	require.NoError(t, err)
	assert.Equal(t, "smeta.pdf", meta.Filename)
	assert.Equal(t, "%PDF-1.4\n", string(data))
	_, _, err = EmbeddedPart([]byte(embeddedMessage), 5)
	assert.Error(t, err)
}
