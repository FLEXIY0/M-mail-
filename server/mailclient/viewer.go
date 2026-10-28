package mailclient

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/emersion/go-message"
	"github.com/emersion/go-message/charset"
	"github.com/emersion/go-message/mail"
	"golang.org/x/text/encoding/charmap"
)

// Attachments are shown in the panel without downloading them. These
// helpers turn the bytes of an attachment into something the panel can
// show: text, the list of files in an archive, a forwarded message.

const (
	// MaxViewText is how much of a text file the panel shows.
	MaxViewText = 1 << 20
	// MaxZipEntries and MaxZipEntryBytes protect against archive bombs.
	MaxZipEntries    = 2000
	MaxZipEntryBytes = 100 << 20
)

// extTypes give a type to attachments sent as application/octet-stream,
// which is what many mail programs do.
var extTypes = map[string]string{
	".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
	".txt": "text/plain", ".log": "text/plain", ".md": "text/plain", ".ini": "text/plain", ".conf": "text/plain",
	".csv": "text/csv", ".json": "application/json", ".xml": "text/xml",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
	".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
	".eml": "message/rfc822", ".zip": "application/zip",
}

// EffectiveType is the type of an attachment for viewing: the declared one,
// or the one of the file extension when the declared type says nothing.
func EffectiveType(contentType, filename string) string {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if mt, _, err := mime.ParseMediaType(ct); err == nil {
		ct = mt
	}
	switch ct {
	case "", "application/octet-stream", "application/x-unknown", "application/unknown", "binary/octet-stream", "application/x-download", "application/force-download":
		if t, ok := extTypes[strings.ToLower(path.Ext(filename))]; ok {
			return t
		}
	case "application/x-zip-compressed", "application/x-zip", "multipart/x-zip":
		return "application/zip"
	case "image/jpg", "image/pjpeg":
		return "image/jpeg"
	}
	if ct == "" {
		return "application/octet-stream"
	}
	return ct
}

// TextOf decodes a text attachment for showing: the declared charset, or
// windows-1251 for Russian files saved without one. truncated tells that
// only the beginning is returned.
func TextOf(data []byte, charsetName string) (text string, truncated bool) {
	if len(data) > MaxViewText {
		data, truncated = data[:MaxViewText], true
	}
	if charsetName != "" && !strings.EqualFold(charsetName, "utf-8") && !strings.EqualFold(charsetName, "us-ascii") {
		if r, err := charset.Reader(charsetName, bytes.NewReader(data)); err == nil {
			if decoded, err := io.ReadAll(r); err == nil {
				return strings.ToValidUTF8(string(decoded), "�"), truncated
			}
		}
	}
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	if utf8.Valid(data) || (truncated && utf8.Valid(bytesToValidUTF8(data))) {
		return string(bytesToValidUTF8(data)), truncated
	}
	if decoded, err := charmap.Windows1251.NewDecoder().Bytes(data); err == nil {
		return string(decoded), truncated
	}
	return strings.ToValidUTF8(string(data), "�"), truncated
}

// ZipEntry is a file in an archive.
type ZipEntry struct {
	Index    int       `json:"index"`
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Dir      bool      `json:"dir,omitempty"`
	Modified time.Time `json:"modified"`
}

// zipName decodes a file name: archives made on Windows in Russia keep
// names in CP866 and do not set the UTF-8 flag.
func zipName(f *zip.File) string {
	if !f.NonUTF8 && utf8.ValidString(f.Name) {
		return f.Name
	}
	if decoded, err := charmap.CodePage866.NewDecoder().String(f.Name); err == nil {
		return decoded
	}
	return strings.ToValidUTF8(f.Name, "�")
}

// ZipEntries lists the files of an archive.
func ZipEntries(data []byte) (entries []ZipEntry, more bool, err error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, false, newError(CodeUnknown, "zip", err)
	}
	for i, f := range zr.File {
		if len(entries) >= MaxZipEntries {
			return entries, true, nil
		}
		entries = append(entries, ZipEntry{
			Index:    i,
			Name:     zipName(f),
			Size:     int64(f.UncompressedSize64),
			Dir:      f.FileInfo().IsDir(),
			Modified: f.Modified,
		})
	}
	return entries, false, nil
}

// ZipFile extracts one file of an archive.
func ZipFile(data []byte, index int) (name string, content []byte, err error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", nil, newError(CodeUnknown, "zip", err)
	}
	if index < 0 || index >= len(zr.File) || zr.File[index].FileInfo().IsDir() {
		return "", nil, newError(CodeNotFound, "zip", fmt.Errorf("no file %d in the archive", index))
	}
	f := zr.File[index]
	if f.UncompressedSize64 > MaxZipEntryBytes {
		return "", nil, newError(CodeTooLarge, "zip", fmt.Errorf("%s is %d bytes", f.Name, f.UncompressedSize64))
	}
	rc, err := f.Open()
	if err != nil {
		return "", nil, newError(CodeUnknown, "zip", err)
	}
	defer func() { _ = rc.Close() }()
	// The declared size can lie: never read more than the limit.
	content, err = io.ReadAll(io.LimitReader(rc, MaxZipEntryBytes+1))
	if err != nil {
		return "", nil, newError(CodeUnknown, "zip", err)
	}
	if len(content) > MaxZipEntryBytes {
		return "", nil, newError(CodeTooLarge, "zip", errors.New("the file is too large"))
	}
	return path.Base(zipName(f)), content, nil
}

// Embedded is a message attached to another one (.eml, message/rfc822).
type Embedded struct {
	Subject     string       `json:"subject"`
	From        []Address    `json:"from"`
	To          []Address    `json:"to"`
	Cc          []Address    `json:"cc"`
	Date        time.Time    `json:"date"`
	Text        string       `json:"text"`
	HTML        string       `json:"html,omitempty"`
	Attachments []Attachment `json:"attachments"`
}

func mailAddresses(h mail.Header, key string) []Address {
	list, err := h.AddressList(key)
	out := make([]Address, 0, len(list))
	if err != nil {
		return out
	}
	for _, a := range list {
		out = append(out, Address{Name: a.Name, Email: a.Address})
	}
	return out
}

// walkEmbedded calls fn for every leaf part of a message with its number
// (1, 2…) in reading order.
func walkEmbedded(data []byte, fn func(index int, h message.Header, body io.Reader) error) (*mail.Header, error) {
	entity, err := message.Read(bytes.NewReader(data))
	if entity == nil {
		return nil, newError(CodeUnknown, "eml", err)
	}
	header := mail.Header{Header: entity.Header}
	index := 0
	var walk func(e *message.Entity) error
	walk = func(e *message.Entity) error {
		if mr := e.MultipartReader(); mr != nil {
			for {
				part, err := mr.NextPart()
				if err == io.EOF {
					return nil
				}
				if err != nil {
					// A broken part ends the message, as in mail clients.
					return nil //nolint:nilerr
				}
				if err = walk(part); err != nil {
					return err
				}
			}
		}
		index++
		return fn(index, e.Header, e.Body)
	}
	return &header, walk(entity)
}

// ParseEmbedded reads an attached message for showing it.
func ParseEmbedded(data []byte) (*Embedded, error) {
	out := &Embedded{Attachments: []Attachment{}}
	header, err := walkEmbedded(data, func(index int, h message.Header, body io.Reader) error {
		ct, params, _ := h.ContentType()
		disp, dparams, _ := h.ContentDisposition()
		filename := dparams["filename"]
		if filename == "" {
			filename = params["name"]
		}
		isText := (ct == "text/plain" || ct == "text/html" || ct == "") && disp != "attachment" && filename == ""
		if isText {
			b, _ := io.ReadAll(io.LimitReader(body, MaxViewText))
			if ct == "text/html" {
				if out.HTML == "" {
					out.HTML = string(bytesToValidUTF8(b))
				}
			} else if out.Text == "" {
				out.Text = string(bytesToValidUTF8(b))
			}
			return nil
		}
		n, _ := io.Copy(io.Discard, io.LimitReader(body, MaxAttachmentBytes))
		if filename == "" {
			filename = fmt.Sprintf("part-%d", index)
			if exts, _ := mime.ExtensionsByType(ct); len(exts) > 0 {
				filename += exts[0]
			}
		}
		out.Attachments = append(out.Attachments, Attachment{
			Part:        fmt.Sprint(index),
			Filename:    filename,
			ContentType: ct,
			Size:        n,
			Inline:      disp == "inline" && h.Get("Content-Id") != "",
			ContentID:   strings.Trim(h.Get("Content-Id"), "<>"),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	out.Subject, _ = header.Subject()
	out.From = mailAddresses(*header, "From")
	out.To = mailAddresses(*header, "To")
	out.Cc = mailAddresses(*header, "Cc")
	out.Date, _ = header.Date()
	if out.Text == "" && out.HTML != "" {
		out.Text = HTMLToText(out.HTML)
	}
	return out, nil
}

// EmbeddedPart returns one attachment of an attached message.
func EmbeddedPart(data []byte, index int) (*Attachment, []byte, error) {
	var meta *Attachment
	var content []byte
	_, err := walkEmbedded(data, func(i int, h message.Header, body io.Reader) error {
		if i != index {
			return nil
		}
		ct, params, _ := h.ContentType()
		_, dparams, _ := h.ContentDisposition()
		name := dparams["filename"]
		if name == "" {
			name = params["name"]
		}
		if name == "" {
			name = fmt.Sprintf("part-%d", i)
		}
		b, err := io.ReadAll(io.LimitReader(body, MaxAttachmentBytes))
		if err != nil {
			return err
		}
		meta = &Attachment{Part: fmt.Sprint(i), Filename: name, ContentType: ct, Size: int64(len(b)), Charset: params["charset"]}
		content = b
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	if meta == nil {
		return nil, nil, newError(CodeNotFound, "eml", fmt.Errorf("no part %d", index))
	}
	return meta, content, nil
}
