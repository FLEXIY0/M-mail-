package mailclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset" // windows-1251, koi8-r and friends
	"github.com/emersion/go-message/textproto"
)

const (
	// maxTextBytes limits the text and HTML parts shown in the panel.
	maxTextBytes = 2 << 20
	// maxInlineImage and maxInlineTotal limit images embedded into the
	// HTML body as data: URLs (cid: references).
	maxInlineImage = 1 << 20
	maxInlineTotal = 4 << 20
	// MaxAttachmentBytes limits a single attachment download.
	MaxAttachmentBytes = 50 << 20
)

// Attachment describes a part that can be downloaded.
type Attachment struct {
	Part        string `json:"part"` // IMAP section, e.g. "2" or "1.3"
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	Inline      bool   `json:"inline,omitempty"`
	ContentID   string `json:"content_id,omitempty"`
	// Charset of a text attachment, for showing it; not sent to the browser.
	Charset string `json:"-"`
}

// Message is a message prepared for reading.
type Message struct {
	Summary
	Cc []Address `json:"cc"`
	// Bcc is known only for own messages: drafts and some "Sent" copies.
	Bcc        []Address    `json:"bcc,omitempty"`
	ReplyTo    []Address    `json:"reply_to"`
	InReplyTo  string       `json:"in_reply_to,omitempty"`
	References []string     `json:"references,omitempty"`
	Text       string       `json:"text"`
	HTML       string       `json:"html,omitempty"`
	Truncated  bool         `json:"truncated,omitempty"`
	Attachment []Attachment `json:"attachments"`
}

type textPart struct {
	path      []int
	part      *imap.BodyStructureSinglePart
	mediaType string
}

// partKey formats a section path like "1.2".
func partKey(path []int) string {
	parts := make([]string, len(path))
	for i, n := range path {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ".")
}

// ParsePart parses "1.2" back into a section path.
func ParsePart(s string) ([]int, error) {
	if s == "" {
		return nil, errors.New("empty part")
	}
	fields := strings.Split(s, ".")
	if len(fields) > 20 {
		return nil, errors.New("part is too deep")
	}
	path := make([]int, 0, len(fields))
	for _, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil || n <= 0 || n > 10000 {
			return nil, fmt.Errorf("invalid part %q", s)
		}
		path = append(path, n)
	}
	return path, nil
}

// isAttachment decides whether a leaf part is a file rather than body text.
func isAttachment(part *imap.BodyStructureSinglePart) bool {
	disp := part.Disposition()
	if disp != nil && strings.EqualFold(disp.Value, "attachment") {
		return true
	}
	mediaType := part.MediaType()
	if strings.HasPrefix(mediaType, "text/plain") || strings.HasPrefix(mediaType, "text/html") {
		return partFilename(part) != "" && disp != nil && !strings.EqualFold(disp.Value, "inline")
	}
	if strings.HasPrefix(mediaType, "multipart/") {
		return false
	}
	// Images referenced from the HTML body are not attachments, unless
	// they have a file name and no Content-ID.
	if strings.HasPrefix(mediaType, "image/") && part.ID != "" && (disp == nil || strings.EqualFold(disp.Value, "inline")) {
		return false
	}
	return true
}

// collectAttachments lists downloadable parts. Forwarded messages
// (message/rfc822) are offered as .eml files.
func collectAttachments(bs imap.BodyStructure) []Attachment {
	var list []Attachment
	bs.Walk(func(path []int, part imap.BodyStructure) bool {
		single, ok := part.(*imap.BodyStructureSinglePart)
		if !ok {
			return true
		}
		if !isAttachment(single) {
			return false
		}
		name := partFilename(single)
		mediaType := single.MediaType()
		if name == "" {
			name = defaultFilename(single, len(list)+1)
		}
		list = append(list, Attachment{
			Part:        partKey(path),
			Filename:    name,
			ContentType: mediaType,
			Size:        estimateDecodedSize(single),
			ContentID:   strings.Trim(single.ID, "<>"),
		})
		return false
	})
	return list
}

func defaultFilename(part *imap.BodyStructureSinglePart, n int) string {
	mediaType := part.MediaType()
	if mediaType == "message/rfc822" {
		if part.MessageRFC822 != nil && part.MessageRFC822.Envelope != nil && part.MessageRFC822.Envelope.Subject != "" {
			return sanitizeFilename(part.MessageRFC822.Envelope.Subject) + ".eml"
		}
		return "message.eml"
	}
	ext := ""
	if exts, _ := mime.ExtensionsByType(mediaType); len(exts) > 0 {
		ext = exts[0]
	}
	return fmt.Sprintf("attachment-%d%s", n, ext)
}

var unsafeFilename = regexp.MustCompile(`[\x00-\x1f/\\:*?"<>|]+`)

func sanitizeFilename(name string) string {
	name = strings.TrimSpace(unsafeFilename.ReplaceAllString(name, "_"))
	if len([]rune(name)) > 120 {
		name = string([]rune(name)[:120])
	}
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// partFilename decodes the file name of a part: RFC 2231 (filename*=),
// RFC 2047 encoded words and raw UTF-8 are all common.
func partFilename(part *imap.BodyStructureSinglePart) string {
	var candidates []map[string]string
	if disp := part.Disposition(); disp != nil {
		candidates = append(candidates, disp.Params)
	}
	candidates = append(candidates, part.Params)
	for _, params := range candidates {
		for _, key := range []string{"filename", "name"} {
			if v := decodeParam(params, key); v != "" {
				return sanitizeFilename(v)
			}
		}
	}
	return ""
}

func decodeParam(params map[string]string, key string) string {
	lower := map[string]string{}
	for k, v := range params {
		lower[strings.ToLower(k)] = v
	}
	if v, ok := lower[key+"*"]; ok {
		return decode2231(v)
	}
	// Continuations: filename*0*=..., filename*1*=...
	if _, ok := lower[key+"*0*"]; ok || lower[key+"*0"] != "" {
		var sb strings.Builder
		encoded := false
		for i := 0; ; i++ {
			if v, ok := lower[fmt.Sprintf("%s*%d*", key, i)]; ok {
				sb.WriteString(v)
				encoded = true
				continue
			}
			if v, ok := lower[fmt.Sprintf("%s*%d", key, i)]; ok {
				sb.WriteString(v)
				continue
			}
			break
		}
		if encoded {
			return decode2231(sb.String())
		}
		return decodeWords(sb.String())
	}
	return decodeWords(lower[key])
}

func decode2231(v string) string {
	parts := strings.SplitN(v, "'", 3)
	if len(parts) != 3 {
		if s, err := url.PathUnescape(v); err == nil {
			return s
		}
		return v
	}
	raw, err := url.PathUnescape(parts[2])
	if err != nil {
		return parts[2]
	}
	cs := strings.ToLower(parts[0])
	if cs == "" || cs == "utf-8" || cs == "us-ascii" {
		return raw
	}
	if r, err := message.CharsetReader(cs, strings.NewReader(raw)); err == nil {
		if b, err := io.ReadAll(r); err == nil {
			return string(b)
		}
	}
	return raw
}

func decodeWords(v string) string {
	if v == "" {
		return ""
	}
	if s, err := wordDecoder.DecodeHeader(v); err == nil {
		return s
	}
	return v
}

// estimateDecodedSize turns the encoded size from BODYSTRUCTURE into the
// approximate file size the user will download.
func estimateDecodedSize(part *imap.BodyStructureSinglePart) int64 {
	size := int64(part.Size)
	if strings.EqualFold(part.Encoding, "base64") {
		return size * 3 / 4
	}
	return size
}

// findTextParts picks the plain text and HTML bodies. In
// multipart/alternative the last part is the preferred one, but both are
// kept: the panel shows HTML and falls back to text.
func findTextParts(bs imap.BodyStructure) (plain, html *textPart, inline []textPart) {
	bs.Walk(func(path []int, part imap.BodyStructure) bool {
		single, ok := part.(*imap.BodyStructureSinglePart)
		if !ok {
			return true
		}
		mediaType := single.MediaType()
		if isAttachment(single) {
			if strings.HasPrefix(mediaType, "image/") && single.ID != "" {
				inline = append(inline, textPart{path: path, part: single, mediaType: mediaType})
			}
			return false
		}
		switch {
		case mediaType == "text/plain" && plain == nil:
			plain = &textPart{path: path, part: single, mediaType: mediaType}
		case mediaType == "text/html" && html == nil:
			html = &textPart{path: path, part: single, mediaType: mediaType}
		case strings.HasPrefix(mediaType, "image/") && single.ID != "":
			inline = append(inline, textPart{path: path, part: single, mediaType: mediaType})
		}
		return false
	})
	return plain, html, inline
}

// decodePart applies Content-Transfer-Encoding and, for text, the charset.
func decodePart(part *imap.BodyStructureSinglePart, raw []byte, limit int64) ([]byte, bool) {
	var h textproto.Header
	params := map[string]string{}
	for k, v := range part.Params {
		params[strings.ToLower(k)] = v
	}
	h.Set("Content-Type", mime.FormatMediaType(part.MediaType(), params))
	if part.Encoding != "" {
		h.Set("Content-Transfer-Encoding", part.Encoding)
	}
	entity, err := message.New(message.Header{Header: h}, bytes.NewReader(raw))
	if entity == nil {
		return raw, false
	}
	_ = err // unknown charset: the entity is still readable, show as is
	data, readErr := io.ReadAll(io.LimitReader(entity.Body, limit+1))
	if readErr != nil && len(data) == 0 {
		return raw, false
	}
	truncated := int64(len(data)) > limit
	if truncated {
		data = data[:limit]
	}
	return data, truncated
}

var referencesFetch = &imap.FetchItemBodySection{
	Specifier:    imap.PartSpecifierHeader,
	HeaderFields: []string{"References", "Reply-To", "In-Reply-To"},
	Peek:         true,
}

// Get loads a message for reading. Only the body text and small inline
// images are downloaded; attachments are fetched on demand.
func (m *IMAP) Get(ctx context.Context, folder string, uid uint32, markSeen bool) (*Message, error) {
	if err := m.ensureSelected(ctx, folder, markSeen); err != nil {
		return nil, err
	}
	opts := &imap.FetchOptions{
		UID:           true,
		Flags:         true,
		Envelope:      true,
		InternalDate:  true,
		RFC822Size:    true,
		BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
		BodySection:   []*imap.FetchItemBodySection{referencesFetch},
	}
	bufs, err := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, opts)
	if err != nil {
		return nil, err
	}
	if len(bufs) == 0 || bufs[0].BodyStructure == nil {
		return nil, newError(CodeNotFound, "fetch", fmt.Errorf("message %d not found in %q", uid, folder))
	}
	buf := bufs[0]
	msg := &Message{Summary: summaryOf(buf), Attachment: collectAttachments(buf.BodyStructure), Cc: []Address{}, ReplyTo: []Address{}}
	if msg.Attachment == nil {
		// The webapp expects lists, never null.
		msg.Attachment = []Attachment{}
	}
	if env := buf.Envelope; env != nil {
		msg.Cc = convertAddresses(env.Cc)
		msg.Bcc = convertAddresses(env.Bcc)
		msg.ReplyTo = convertAddresses(env.ReplyTo)
		if len(env.InReplyTo) > 0 {
			msg.InReplyTo = env.InReplyTo[0]
		}
	}
	if header := buf.FindBodySection(referencesFetch); len(header) > 0 {
		msg.References = parseReferences(header)
	}

	plain, html, inline := findTextParts(buf.BodyStructure)
	var sections []*imap.FetchItemBodySection
	add := func(tp *textPart) *imap.FetchItemBodySection {
		section := &imap.FetchItemBodySection{Part: tp.path, Peek: true}
		sections = append(sections, section)
		return section
	}
	var plainSection, htmlSection *imap.FetchItemBodySection
	if plain != nil {
		plainSection = add(plain)
	}
	if html != nil {
		htmlSection = add(html)
	}
	type inlineSection struct {
		tp      textPart
		section *imap.FetchItemBodySection
	}
	var inlineSections []inlineSection
	if html != nil {
		var total int64
		for _, tp := range inline {
			size := estimateDecodedSize(tp.part)
			if size > maxInlineImage || total+size > maxInlineTotal {
				continue
			}
			total += size
			inlineSections = append(inlineSections, inlineSection{tp: tp, section: add(&tp)})
		}
	}
	if len(sections) > 0 {
		bodies, fetchErr := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, BodySection: sections})
		if fetchErr != nil {
			return nil, fetchErr
		}
		if len(bodies) > 0 {
			body := bodies[0]
			if plainSection != nil {
				data, truncated := decodePart(plain.part, body.FindBodySection(plainSection), maxTextBytes)
				msg.Text = string(bytes.ToValidUTF8(data, []byte("�")))
				msg.Truncated = msg.Truncated || truncated
			}
			if htmlSection != nil {
				data, truncated := decodePart(html.part, body.FindBodySection(htmlSection), maxTextBytes)
				msg.HTML = string(bytes.ToValidUTF8(data, []byte("�")))
				msg.Truncated = msg.Truncated || truncated
				for _, is := range inlineSections {
					img, _ := decodePart(is.tp.part, body.FindBodySection(is.section), maxInlineImage)
					msg.HTML = replaceCID(msg.HTML, strings.Trim(is.tp.part.ID, "<>"), is.tp.mediaType, img)
				}
			}
		}
	}
	if msg.Text == "" && msg.HTML != "" {
		msg.Text = HTMLToText(msg.HTML)
	}

	if markSeen && !msg.Seen {
		if err := m.SetFlags(ctx, folder, []uint32{uid}, "seen", true); err == nil {
			msg.Seen = true
		}
	}
	return msg, nil
}

func replaceCID(html, cid, mediaType string, data []byte) string {
	if cid == "" || len(data) == 0 {
		return html
	}
	uri := "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
	html = strings.ReplaceAll(html, "cid:"+cid, uri)
	return strings.ReplaceAll(html, "CID:"+cid, uri)
}

func parseReferences(header []byte) []string {
	h, err := textproto.ReadHeader(bufio.NewReader(bytes.NewReader(header)))
	if err != nil {
		return nil
	}
	var refs []string
	for _, f := range strings.Fields(h.Get("References")) {
		if strings.HasPrefix(f, "<") && strings.HasSuffix(f, ">") {
			refs = append(refs, strings.Trim(f, "<>"))
		}
	}
	return refs
}

// Download returns the decoded content of an attachment.
func (m *IMAP) Download(ctx context.Context, folder string, uid uint32, part string) (*Attachment, []byte, error) {
	path, err := ParsePart(part)
	if err != nil {
		return nil, nil, newError(CodeNotFound, "download", err)
	}
	if err = m.ensureSelected(ctx, folder, false); err != nil {
		return nil, nil, err
	}
	bufs, err := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, BodyStructure: &imap.FetchItemBodyStructure{Extended: true}})
	if err != nil {
		return nil, nil, err
	}
	if len(bufs) == 0 || bufs[0].BodyStructure == nil {
		return nil, nil, newError(CodeNotFound, "download", fmt.Errorf("message %d not found", uid))
	}
	var target *imap.BodyStructureSinglePart
	var meta *Attachment
	index := 0
	bufs[0].BodyStructure.Walk(func(p []int, bs imap.BodyStructure) bool {
		single, ok := bs.(*imap.BodyStructureSinglePart)
		if !ok {
			return true
		}
		index++
		if partKey(p) == part {
			target = single
			name := partFilename(single)
			if name == "" {
				name = defaultFilename(single, index)
			}
			meta = &Attachment{Part: part, Filename: name, ContentType: single.MediaType(), Size: estimateDecodedSize(single), ContentID: strings.Trim(single.ID, "<>"), Charset: single.Params["charset"]}
		}
		return false
	})
	if target == nil {
		return nil, nil, newError(CodeNotFound, "download", fmt.Errorf("part %s not found", part))
	}
	if int64(target.Size) > MaxAttachmentBytes*4/3+1024 {
		return nil, nil, newError(CodeTooLarge, "download", fmt.Errorf("part %s is %d bytes", part, target.Size))
	}
	if target.MediaType() == "message/rfc822" && (target.Encoding == "" || strings.EqualFold(target.Encoding, "7bit") || strings.EqualFold(target.Encoding, "8bit") || strings.EqualFold(target.Encoding, "binary")) {
		// Servers disagree on what BODY[n] of an attached message is: the
		// whole message or only its body. Header and text asked
		// separately are the same everywhere.
		data, rfcErr := m.fetchEmbedded(ctx, uid, path)
		if rfcErr == nil {
			meta.Size = int64(len(data))
			return meta, data, nil
		}
	}
	section := &imap.FetchItemBodySection{Part: path, Peek: true}
	var body []*imapclient.FetchMessageBuffer
	body, err = m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{section}})
	if err != nil {
		return nil, nil, err
	}
	if len(body) == 0 {
		return nil, nil, newError(CodeNotFound, "download", fmt.Errorf("message %d not found", uid))
	}
	raw := body[0].FindBodySection(section)
	if target.MediaType() == "message/rfc822" || strings.HasPrefix(target.MediaType(), "text/") {
		// Keep the original bytes and charset of forwarded messages and
		// text files; only undo the transfer encoding.
		data, _ := decodeTransfer(target.Encoding, raw)
		meta.Size = int64(len(data))
		return meta, data, nil
	}
	data, _ := decodePart(target, raw, MaxAttachmentBytes)
	meta.Size = int64(len(data))
	return meta, data, nil
}

// fetchEmbedded downloads a message attached to a message.
func (m *IMAP) fetchEmbedded(ctx context.Context, uid uint32, path []int) ([]byte, error) {
	header := &imap.FetchItemBodySection{Part: path, Specifier: imap.PartSpecifierHeader, Peek: true}
	text := &imap.FetchItemBodySection{Part: path, Specifier: imap.PartSpecifierText, Peek: true}
	bufs, err := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{header, text}})
	if err != nil {
		return nil, err
	}
	if len(bufs) == 0 {
		return nil, newError(CodeNotFound, "download", fmt.Errorf("message %d not found", uid))
	}
	h := bufs[0].FindBodySection(header)
	if len(h) == 0 {
		return nil, newError(CodeNotFound, "download", errors.New("no header of the attached message"))
	}
	// The header ends with an empty line; some servers leave it out.
	out := append([]byte{}, h...)
	switch {
	case bytes.HasSuffix(out, []byte("\r\n\r\n")), bytes.HasSuffix(out, []byte("\n\n")):
	case bytes.HasSuffix(out, []byte("\n")):
		out = append(out, "\r\n"...)
	default:
		out = append(out, "\r\n\r\n"...)
	}
	return append(out, bufs[0].FindBodySection(text)...), nil
}

func decodeTransfer(encoding string, raw []byte) ([]byte, error) {
	var h textproto.Header
	h.Set("Content-Type", "application/octet-stream")
	if encoding != "" {
		h.Set("Content-Transfer-Encoding", encoding)
	}
	entity, err := message.New(message.Header{Header: h}, bytes.NewReader(raw))
	if entity == nil {
		return raw, err
	}
	data, readErr := io.ReadAll(io.LimitReader(entity.Body, MaxAttachmentBytes))
	if readErr != nil {
		return raw, readErr
	}
	return data, nil
}

// Raw returns the whole message as stored on the server (for "forward as
// attachment" and diagnostics).
func (m *IMAP) Raw(ctx context.Context, folder string, uid uint32, limit int64) ([]byte, error) {
	if err := m.ensureSelected(ctx, folder, false); err != nil {
		return nil, err
	}
	sizes, err := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, RFC822Size: true})
	if err != nil {
		return nil, err
	}
	if len(sizes) == 0 {
		return nil, newError(CodeNotFound, "fetch", fmt.Errorf("message %d not found", uid))
	}
	if sizes[0].RFC822Size > limit {
		return nil, newError(CodeTooLarge, "fetch", fmt.Errorf("message is %d bytes", sizes[0].RFC822Size))
	}
	section := &imap.FetchItemBodySection{Peek: true}
	bufs, err := m.fetchUIDs(ctx, []imap.UID{imap.UID(uid)}, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{section}})
	if err != nil {
		return nil, err
	}
	if len(bufs) == 0 {
		return nil, newError(CodeNotFound, "fetch", fmt.Errorf("message %d not found", uid))
	}
	return bufs[0].FindBodySection(section), nil
}
