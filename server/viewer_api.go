package main

import (
	"context"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

// Attachments are shown in the panel: images, PDF, audio and video by the
// browser itself, text, archives and attached messages as JSON, office
// documents by Collabora Online (wopi.go).

// browserTypes may be shown by the browser; everything else is downloaded.
var browserTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/bmp": true,
	"application/pdf": true, "text/plain": true,
	"audio/mpeg": true, "audio/wav": true, "audio/ogg": true, "audio/mp4": true,
	"video/mp4": true, "video/webm": true, "video/ogg": true, "video/quicktime": true,
}

// attachmentRef points to an attachment: a part of a message, or a part of
// a message attached to it (sub, numbered from 1).
type attachmentRef struct {
	Folder string `json:"folder"`
	UID    uint32 `json:"uid"`
	Part   string `json:"part"`
	Sub    int    `json:"sub,omitempty"`
}

func attachmentRefFrom(r *http.Request) (attachmentRef, bool) {
	uid, ok := uidParam(r)
	ref := attachmentRef{Folder: folderParam(r), UID: uid, Part: r.URL.Query().Get("part")}
	if s := r.URL.Query().Get("sub"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			return ref, false
		}
		ref.Sub = n
	}
	return ref, ok && ref.Part != ""
}

// loadAttachment downloads an attachment over the user's connection.
func (p *Plugin) loadAttachment(ctx context.Context, userID string, account *store.Account, ref attachmentRef) (*mailclient.Attachment, []byte, error) {
	var meta *mailclient.Attachment
	var data []byte
	err := p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		var err error
		meta, data, err = conn.Download(ctx, ref.Folder, ref.UID, ref.Part)
		return err
	})
	if err != nil || ref.Sub == 0 {
		return meta, data, err
	}
	return mailclient.EmbeddedPart(data, ref.Sub)
}

// attachmentRequest loads the attachment of a request and writes errors.
func (p *Plugin) attachmentRequest(w http.ResponseWriter, r *http.Request) (*mailclient.Attachment, []byte, bool) {
	ref, ok := attachmentRefFrom(r)
	if !ok {
		writeError(w, http.StatusBadRequest, codeBadRequest, "uid and part are required")
		return nil, nil, false
	}
	userID := userIDFrom(r)
	account := p.accountFor(w, userID)
	if account == nil {
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
	defer cancel()
	meta, data, err := p.loadAttachment(ctx, userID, account, ref)
	if err != nil {
		writeMailError(w, err)
		return nil, nil, false
	}
	return meta, data, true
}

// writeFile sends an attachment to the browser. Only types the browser
// shows safely are inline; HTML and SVG from a message never render on the
// Mattermost origin.
func writeFile(w http.ResponseWriter, filename, contentType string, data []byte, inline bool) {
	disposition := "attachment"
	if inline && browserTypes[contentType] {
		disposition = "inline"
	}
	if !browserTypes[contentType] {
		contentType = "application/octet-stream"
	}
	if contentType == "text/plain" {
		contentType = "text/plain; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if contentType == "application/pdf" && disposition == "inline" {
		// The PDF viewer of Chrome does not start in a sandboxed document;
		// it runs in its own process and does not execute the file's code
		// on this origin.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; object-src 'self'; plugin-types application/pdf")
	} else {
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

// GET /attachment?folder=…&uid=…&part=…[&sub=…][&inline=1]
func (p *Plugin) handleAttachment(w http.ResponseWriter, r *http.Request) {
	meta, data, ok := p.attachmentRequest(w, r)
	if !ok {
		return
	}
	writeFile(w, meta.Filename, mailclient.EffectiveType(meta.ContentType, meta.Filename), data, r.URL.Query().Get("inline") == "1")
}

// GET /attachment/zip?…&entry=N — one file of an archive.
func (p *Plugin) handleZipEntry(w http.ResponseWriter, r *http.Request) {
	index, err := strconv.Atoi(r.URL.Query().Get("entry"))
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "entry is required")
		return
	}
	_, data, ok := p.attachmentRequest(w, r)
	if !ok {
		return
	}
	name, content, err := mailclient.ZipFile(data, index)
	if err != nil {
		writeMailError(w, err)
		return
	}
	writeFile(w, name, mailclient.EffectiveType("", name), content, r.URL.Query().Get("inline") == "1")
}

type viewResponse struct {
	// Kind is text, zip, eml or file (anything else: shown by the browser
	// from /attachment, by Collabora, or downloaded).
	Kind        string                `json:"kind"`
	Filename    string                `json:"filename"`
	ContentType string                `json:"content_type"`
	Size        int64                 `json:"size"`
	Text        string                `json:"text,omitempty"`
	Truncated   bool                  `json:"truncated,omitempty"`
	Entries     []mailclient.ZipEntry `json:"entries,omitempty"`
	More        bool                  `json:"more,omitempty"`
	Message     *mailclient.Embedded  `json:"message,omitempty"`
	Office      bool                  `json:"office,omitempty"`
}

func isTextType(ct string) bool {
	return strings.HasPrefix(ct, "text/") && ct != "text/html" || ct == "application/json" || ct == "application/xml"
}

// GET /attachment/view?folder=…&uid=…&part=…[&sub=…]
func (p *Plugin) handleAttachmentView(w http.ResponseWriter, r *http.Request) {
	meta, data, ok := p.attachmentRequest(w, r)
	if !ok {
		return
	}
	ct := mailclient.EffectiveType(meta.ContentType, meta.Filename)
	res := viewResponse{Kind: "file", Filename: meta.Filename, ContentType: ct, Size: int64(len(data))}
	switch {
	case isTextType(ct):
		res.Kind = "text"
		res.Text, res.Truncated = mailclient.TextOf(data, meta.Charset)
	case ct == "application/zip":
		entries, more, err := mailclient.ZipEntries(data)
		if err == nil {
			res.Kind, res.Entries, res.More = "zip", entries, more
		}
	case ct == "message/rfc822":
		msg, err := mailclient.ParseEmbedded(data)
		if err == nil {
			res.Kind, res.Message = "eml", msg
		}
	default:
		res.Office = p.officeSupports(r.Context(), meta.Filename)
	}
	writeJSON(w, http.StatusOK, res)
}
