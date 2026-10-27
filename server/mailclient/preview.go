package mailclient

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

const (
	// Text parts up to these sizes are downloaded for the preview. Partial
	// fetches (BODY[1]<0.1024>) would be cheaper, but some servers answer
	// them in a form go-imap can not parse, which breaks the connection.
	previewPlainBytes = 32 << 10
	previewHTMLBytes  = 48 << 10
	// previewPageBudget limits the download for one page of the list.
	previewPageBudget = 1536 << 10
	previewRunes      = 200
	previewCacheSize  = 20000
)

// PreviewCache keeps the beginnings of messages, so that scrolling back and
// forth in the list does not download them again. Keys include UIDVALIDITY:
// a UID always means the same message within one validity.
type PreviewCache struct {
	mu      sync.Mutex
	entries map[string]string
}

func NewPreviewCache() *PreviewCache {
	return &PreviewCache{entries: map[string]string{}}
}

func (c *PreviewCache) get(key string) (string, bool) {
	if c == nil {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.entries[key]
	return v, ok
}

func (c *PreviewCache) put(key, value string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= previewCacheSize {
		c.entries = map[string]string{}
	}
	c.entries[key] = value
}

// SetPreviewCache makes the connection use a cache that outlives it.
func (m *IMAP) SetPreviewCache(c *PreviewCache) {
	m.previews = c
}

var (
	reUnclosedBlock = regexp.MustCompile(`(?is)<(style|script|head|title)[^>]*>.*$`)
	reUnclosedTag   = regexp.MustCompile(`<[^>]*$`)
	reQuoteHeader   = regexp.MustCompile(`(?m)^>.*$`)
)

// previewOf turns the beginning of a body part into one line of text.
func previewOf(data []byte, isHTML bool) string {
	text := string(bytesToValidUTF8(data))
	if isHTML {
		text = reBlockTags.ReplaceAllString(text, "")
		text = reUnclosedBlock.ReplaceAllString(text, "")
		text = reUnclosedTag.ReplaceAllString(text, "")
		text = HTMLToText(text)
	}
	text = reQuoteHeader.ReplaceAllString(text, "")
	text = strings.Join(strings.Fields(strings.ReplaceAll(text, " ", " ")), " ")
	if utf8.RuneCountInString(text) > previewRunes {
		text = string([]rune(text)[:previewRunes])
	}
	return text
}

func bytesToValidUTF8(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	// A multibyte character cut in half at the end is simply dropped.
	for i := 0; i < 3 && len(b) > 0 && !utf8.Valid(b); i++ {
		b = b[:len(b)-1]
	}
	return []byte(strings.ToValidUTF8(string(b), ""))
}

// fillPreviews downloads the text of every message that is not cached yet
// and keeps its beginning. Messages are grouped by the position of their text
// part, so a page needs a couple of FETCH commands, not one per message.
func (m *IMAP) fillPreviews(ctx context.Context, folder string, uidValidity uint32, bufs []*imapclient.FetchMessageBuffer, out []Summary) {
	type target struct {
		index int
		part  *textPart
		html  bool
	}
	byPart := map[string][]target{}
	budget := int64(previewPageBudget)
	for i, buf := range bufs {
		key := fmt.Sprintf("%s|%d|%d", folder, uidValidity, buf.UID)
		if v, ok := m.previews.get(key); ok {
			out[i].Preview = v
			continue
		}
		if buf.BodyStructure == nil {
			continue
		}
		plain, html, _ := findTextParts(buf.BodyStructure)
		switch {
		case plain != nil && int64(plain.part.Size) <= previewPlainBytes && int64(plain.part.Size) <= budget:
			budget -= int64(plain.part.Size)
			byPart["p"+partKey(plain.path)] = append(byPart["p"+partKey(plain.path)], target{index: i, part: plain})
		case html != nil && int64(html.part.Size) <= previewHTMLBytes && int64(html.part.Size) <= budget:
			budget -= int64(html.part.Size)
			byPart["h"+partKey(html.path)] = append(byPart["h"+partKey(html.path)], target{index: i, part: html, html: true})
		}
	}
	for _, targets := range byPart {
		size := int64(previewPlainBytes)
		if targets[0].html {
			size = previewHTMLBytes
		}
		section := &imap.FetchItemBodySection{Part: targets[0].part.path, Peek: true}
		uids := make([]imap.UID, 0, len(targets))
		byUID := map[imap.UID]target{}
		for _, t := range targets {
			uids = append(uids, bufs[t.index].UID)
			byUID[bufs[t.index].UID] = t
		}
		data, err := m.fetchUIDs(ctx, uids, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{section}})
		if err != nil {
			// Previews are a nicety: the list works without them.
			return
		}

		for _, d := range data {
			t, ok := byUID[d.UID]
			if !ok {
				continue
			}
			decoded, _ := decodePart(t.part.part, d.FindBodySection(section), size*2)
			preview := previewOf(decoded, t.html)
			out[t.index].Preview = preview
			m.previews.put(fmt.Sprintf("%s|%d|%d", folder, uidValidity, d.UID), preview)
		}
	}
}
