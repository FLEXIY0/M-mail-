package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	defaultPageSize = 40
	maxPageSize     = 100
	maxRecipients   = 100
	maxSubjectRunes = 500
	maxTextBytes    = 1 << 20
	maxHTMLBytes    = 6 << 20
	maxShareText    = 3000
	maxForwardRaw   = 25 << 20
	sentCopyDelay   = 3 * time.Second
)

// accountFor loads the account or writes "not connected".
func (p *Plugin) accountFor(w http.ResponseWriter, userID string) *store.Account {
	account, err := p.store.GetAccount(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return nil
	}
	if account == nil {
		writeError(w, http.StatusNotFound, codeNotConnected, "")
		return nil
	}
	return account
}

// mailRequest runs fn on the user's IMAP connection with the request's
// timeout. It writes the error response itself and returns false on error.
func (p *Plugin) mailRequest(w http.ResponseWriter, r *http.Request, fn func(ctx context.Context, account *store.Account, conn *mailclient.IMAP) error) bool {
	userID := userIDFrom(r)
	account := p.accountFor(w, userID)
	if account == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	err := p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		return fn(ctx, account, conn)
	})
	if err != nil {
		writeMailError(w, err)
		return false
	}
	return true
}

// GET /folders
func (p *Plugin) handleFolders(w http.ResponseWriter, r *http.Request) {
	var folders []mailclient.Folder
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		var err error
		folders, err = conn.Folders(ctx)
		return err
	}) {
		return
	}
	p.rememberUnseen(userIDFrom(r), folders)
	writeJSON(w, http.StatusOK, map[string]any{"folders": folders})
}

// rememberUnseen keeps the Inbox counter in the sync state fresh, so that the
// panel title and the background check agree.
func (p *Plugin) rememberUnseen(userID string, folders []mailclient.Folder) {
	for _, f := range folders {
		if f.Role != mailclient.RoleInbox {
			continue
		}
		state, err := p.store.GetSyncState(userID)
		if err != nil || state.Unseen == f.Unseen {
			return
		}
		state.Unseen = f.Unseen
		_ = p.store.SaveSyncState(userID, state)
		return
	}
}

func queryInt(r *http.Request, key string, def, lo, hi int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func folderParam(r *http.Request) string {
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		return "INBOX"
	}
	return folder
}

// GET /messages?folder=…&offset=…&limit=…&q=…&filter=unseen|flagged|attachments
func (p *Plugin) handleMessages(w http.ResponseWriter, r *http.Request) {
	folder := folderParam(r)
	offset := queryInt(r, "offset", 0, 0, 1<<30)
	limit := queryInt(r, "limit", defaultPageSize, 1, maxPageSize)
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	filter := r.URL.Query().Get("filter")
	switch filter {
	case "", mailclient.FilterUnseen, mailclient.FilterFlagged, mailclient.FilterAttachments:
	default:
		writeError(w, http.StatusBadRequest, codeBadRequest, "unknown filter")
		return
	}
	var page *mailclient.Page
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		var err error
		if query != "" || filter != "" {
			page, err = conn.Search(ctx, folder, query, filter, offset, limit)
		} else {
			page, err = conn.List(ctx, folder, offset, limit)
		}
		return err
	}) {
		return
	}
	var emails []string
	for _, m := range page.Messages {
		for _, list := range [][]mailclient.Address{m.From, m.To} {
			for _, a := range list {
				emails = append(emails, a.Email)
			}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		*mailclient.Page
		Avatars map[string]string `json:"avatars"`
	}{page, p.directory.lookup(p, emails)})
}

func uidParam(r *http.Request) (uint32, bool) {
	v, err := strconv.ParseUint(r.URL.Query().Get("uid"), 10, 32)
	return uint32(v), err == nil && v > 0
}

// GET /message?folder=…&uid=…
func (p *Plugin) handleMessage(w http.ResponseWriter, r *http.Request) {
	folder := folderParam(r)
	uid, ok := uidParam(r)
	if !ok {
		writeError(w, http.StatusBadRequest, codeBadRequest, "uid is required")
		return
	}
	markSeen := r.URL.Query().Get("peek") != "1"
	var msg *mailclient.Message
	if !p.mailRequest(w, r, func(ctx context.Context, account *store.Account, conn *mailclient.IMAP) error {
		var err error
		msg, err = conn.Get(ctx, folder, uid, markSeen && account.Settings.MarkReadOnOpen)
		return err
	}) {
		return
	}
	var emails []string
	for _, list := range [][]mailclient.Address{msg.From, msg.To, msg.Cc} {
		for _, a := range list {
			emails = append(emails, a.Email)
		}
	}
	writeJSON(w, http.StatusOK, struct {
		*mailclient.Message
		Avatars map[string]string `json:"avatars"`
	}{msg, p.directory.lookup(p, emails)})
}

// inlineTypes may be shown in the browser; everything else is downloaded.
var inlineTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
	"application/pdf": true, "text/plain": true,
}

// GET /attachment?folder=…&uid=…&part=…[&inline=1]
func (p *Plugin) handleAttachment(w http.ResponseWriter, r *http.Request) {
	folder := folderParam(r)
	uid, ok := uidParam(r)
	part := r.URL.Query().Get("part")
	if !ok || part == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "uid and part are required")
		return
	}
	var meta *mailclient.Attachment
	var data []byte
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		var err error
		meta, data, err = conn.Download(ctx, folder, uid, part)
		return err
	}) {
		return
	}
	contentType := meta.ContentType
	disposition := "attachment"
	if r.URL.Query().Get("inline") == "1" && inlineTypes[contentType] {
		disposition = "inline"
	}
	if !inlineTypes[contentType] && !strings.HasPrefix(contentType, "image/") {
		// Never let the browser render HTML or SVG from a message on the
		// Mattermost origin.
		contentType = "application/octet-stream"
	}
	if contentType == "image/svg+xml" {
		contentType = "application/octet-stream"
		disposition = "attachment"
	}
	if contentType == "text/plain" {
		contentType = "text/plain; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": meta.Filename}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

type messagesRequest struct {
	Folder string   `json:"folder"`
	UIDs   []uint32 `json:"uids"`
}

func (req *messagesRequest) valid() bool {
	if req.Folder == "" || len(req.UIDs) == 0 || len(req.UIDs) > 500 {
		return false
	}
	for _, uid := range req.UIDs {
		if uid == 0 {
			return false
		}
	}
	return true
}

// POST /flags {folder, uids, flag: seen|flagged, value}
func (p *Plugin) handleFlags(w http.ResponseWriter, r *http.Request) {
	var req struct {
		messagesRequest
		Flag  string `json:"flag"`
		Value bool   `json:"value"`
	}
	if err := decodeBody(r, &req); err != nil || !req.valid() || (req.Flag != "seen" && req.Flag != "flagged") {
		writeError(w, http.StatusBadRequest, codeBadRequest, "folder, uids and flag are required")
		return
	}
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		return conn.SetFlags(ctx, req.Folder, req.UIDs, req.Flag, req.Value)
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /move {folder, uids, to}
func (p *Plugin) handleMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		messagesRequest
		To   string `json:"to"`
		Role string `json:"role"`
	}
	if err := decodeBody(r, &req); err != nil || !req.valid() || (req.To == "" && req.Role == "") {
		writeError(w, http.StatusBadRequest, codeBadRequest, "folder, uids and target are required")
		return
	}
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		to := req.To
		if to == "" {
			var err error
			if to, err = conn.FolderByRole(ctx, req.Role); err != nil {
				return err
			}
			if to == "" {
				return &mailclient.Error{Code: mailclient.CodeNotFound, Op: "move", Err: fmt.Errorf("no %s folder", req.Role)}
			}
		}
		return conn.Move(ctx, req.Folder, req.UIDs, to)
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /delete {folder, uids}
func (p *Plugin) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req messagesRequest
	if err := decodeBody(r, &req); err != nil || !req.valid() {
		writeError(w, http.StatusBadRequest, codeBadRequest, "folder and uids are required")
		return
	}
	permanent := false
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		var err error
		permanent, err = conn.Delete(ctx, req.Folder, req.UIDs)
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "permanent": permanent})
}

type messageRef struct {
	Folder string `json:"folder"`
	UID    uint32 `json:"uid"`
}

type attachmentInput struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Data        string `json:"data"` // base64
}

// recipient is an e-mail address or a Mattermost user whose address the
// plugin fills in (it may be hidden from other users by privacy settings).
type recipient struct {
	Name   string `json:"name"`
	Email  string `json:"email"`
	UserID string `json:"user_id"`
}

type sendRequest struct {
	To          []recipient       `json:"to"`
	Cc          []recipient       `json:"cc"`
	Bcc         []recipient       `json:"bcc"`
	Subject     string            `json:"subject"`
	Text        string            `json:"text"`
	HTML        string            `json:"html"`
	ReplyTo     *messageRef       `json:"reply_to,omitempty"`
	Forward     *messageRef       `json:"forward,omitempty"`
	Attachments []attachmentInput `json:"attachments"`
	// ForwardParts are attachments of the forwarded message to include.
	ForwardParts []string `json:"forward_parts"`
	// MattermostFiles are ids of files from Mattermost posts to attach.
	MattermostFiles []string `json:"mattermost_files"`
}

func (p *Plugin) cleanAddresses(list []recipient) ([]mailclient.Address, error) {
	out := make([]mailclient.Address, 0, len(list))
	for _, a := range list {
		email := strings.TrimSpace(a.Email)
		name := a.Name
		if a.UserID != "" {
			if !model.IsValidId(a.UserID) {
				return nil, fmt.Errorf("неверный получатель")
			}
			user, err := p.client.User.Get(a.UserID)
			if err != nil || user.DeleteAt != 0 || user.IsBot {
				return nil, fmt.Errorf("пользователь не найден")
			}
			if user.Email == "" {
				return nil, fmt.Errorf("у пользователя @%s нет адреса почты", user.Username)
			}
			email = user.Email
			if name == "" {
				name = strings.TrimSpace(user.FirstName + " " + user.LastName)
			}
		}
		if !looksLikeEmail(email) || strings.ContainsAny(email, "\r\n\"") {
			return nil, fmt.Errorf("неверный адрес %q", email)
		}
		out = append(out, mailclient.Address{Name: cleanName(name), Email: email})
	}
	return out, nil
}

// POST /send — send a new message, a reply or a forward.
func (p *Plugin) handleSend(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	cfg := p.getConfiguration()
	limit := cfg.maxAttachmentBytes()*4/3 + maxTextBytes + maxHTMLBytes + maxBodyBytes
	var req sendRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(&req); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, codeAttachmentsLarge, err.Error())
		return
	}
	account := p.accountFor(w, userID)
	if account == nil {
		return
	}
	if !p.sendLimiter.allow(userID) {
		writeError(w, http.StatusTooManyRequests, codeRateLimited, "")
		return
	}

	out, err := p.buildOutgoing(account, &req)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidMessage, err.Error())
		return
	}
	if err = p.attachMattermostFiles(userID, out, req.MattermostFiles); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidMessage, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
	defer cancel()

	// Threading headers and forwarded files come from the server, not
	// from the browser.
	if req.ReplyTo != nil || req.Forward != nil {
		err = p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
			if ref := req.ReplyTo; ref != nil {
				original, getErr := conn.Get(ctx, ref.Folder, ref.UID, false)
				if getErr != nil {
					return getErr
				}
				if original.MessageID != "" {
					out.InReplyTo = original.MessageID
					out.References = append(append([]string{}, original.References...), original.MessageID)
				}
			}
			if ref := req.Forward; ref != nil && len(req.ForwardParts) > 0 {
				for _, part := range req.ForwardParts {
					meta, data, dlErr := conn.Download(ctx, ref.Folder, ref.UID, part)
					if dlErr != nil {
						return dlErr
					}
					out.Attachments = append(out.Attachments, mailclient.OutgoingAttachment{Filename: meta.Filename, ContentType: meta.ContentType, Data: data})
				}
			}
			return nil
		})
		if err != nil {
			writeMailError(w, err)
			return
		}
	}
	var total int64
	for _, a := range out.Attachments {
		total += int64(len(a.Data))
	}
	if total > cfg.maxAttachmentBytes() {
		writeError(w, http.StatusRequestEntityTooLarge, codeAttachmentsLarge, fmt.Sprintf("%d MB max", cfg.maxAttachmentBytes()>>20))
		return
	}

	raw, messageID, err := out.Build()
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
		return
	}
	creds, err := p.credentialsFor(account)
	if err != nil {
		writeMailError(w, err)
		return
	}
	if err = mailclient.Send(ctx, account.SMTP, creds, p.policyFor(account), account.Email, out.Recipients(), raw); err != nil {
		if mailclient.IsAuth(err) {
			p.markAuthFailed(userID, err)
		}
		writeMailError(w, err)
		return
	}
	p.API.LogInfo("Mail sent", "user_id", userID, "recipients", len(out.Recipients()), "bytes", len(raw))

	go p.afterSend(userID, account, req.ReplyTo, messageID, raw)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message_id": messageID})
}

func (p *Plugin) buildOutgoing(account *store.Account, req *sendRequest) (*mailclient.Outgoing, error) {
	to, err := p.cleanAddresses(req.To)
	if err != nil {
		return nil, err
	}
	cc, err := p.cleanAddresses(req.Cc)
	if err != nil {
		return nil, err
	}
	bcc, err := p.cleanAddresses(req.Bcc)
	if err != nil {
		return nil, err
	}
	out := &mailclient.Outgoing{
		From:    mailclient.Address{Name: account.DisplayName, Email: account.Email},
		To:      to,
		Cc:      cc,
		Bcc:     bcc,
		Subject: strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(req.Subject)),
		Text:    req.Text,
		HTML:    req.HTML,
	}
	if n := len(out.Recipients()); n == 0 {
		return nil, fmt.Errorf("укажите хотя бы одного получателя")
	} else if n > maxRecipients {
		return nil, fmt.Errorf("не больше %d получателей в одном письме", maxRecipients)
	}
	if utf8.RuneCountInString(out.Subject) > maxSubjectRunes {
		return nil, fmt.Errorf("слишком длинная тема")
	}
	if len(out.Text) > maxTextBytes || len(out.HTML) > maxHTMLBytes {
		return nil, fmt.Errorf("слишком длинный текст письма")
	}
	for _, a := range req.Attachments {
		data, decodeErr := base64.StdEncoding.DecodeString(a.Data)
		if decodeErr != nil {
			return nil, fmt.Errorf("не удалось прочитать вложение %q", a.Filename)
		}
		out.Attachments = append(out.Attachments, mailclient.OutgoingAttachment{Filename: a.Filename, ContentType: a.ContentType, Data: data})
	}
	return out, nil
}

// attachMattermostFiles attaches files from Mattermost posts. The user must
// be able to read the channel the file was posted in.
func (p *Plugin) attachMattermostFiles(userID string, out *mailclient.Outgoing, ids []string) error {
	if len(ids) > 20 {
		return fmt.Errorf("слишком много файлов")
	}
	for _, id := range ids {
		if !model.IsValidId(id) {
			return fmt.Errorf("неверный файл")
		}
		info, appErr := p.API.GetFileInfo(id)
		if appErr != nil {
			return fmt.Errorf("файл не найден")
		}
		if info.PostId == "" {
			return fmt.Errorf("файл не прикреплён к сообщению")
		}
		post, appErr := p.API.GetPost(info.PostId)
		if appErr != nil || !p.API.HasPermissionToChannel(userID, post.ChannelId, model.PermissionReadChannelContent) {
			return fmt.Errorf("нет доступа к файлу %q", info.Name)
		}
		if info.Size > p.getConfiguration().maxAttachmentBytes() {
			return fmt.Errorf("файл %q слишком большой", info.Name)
		}
		data, appErr := p.API.GetFile(id)
		if appErr != nil {
			return fmt.Errorf("не удалось прочитать файл %q", info.Name)
		}
		out.Attachments = append(out.Attachments, mailclient.OutgoingAttachment{Filename: info.Name, ContentType: info.MimeType, Data: data})
	}
	return nil
}

// afterSend marks the original as answered and makes sure a copy of the
// sent message is in "Sent". Mail.ru and Yandex save it themselves, most
// other servers do not, so the plugin looks first and appends only when
// the copy is missing.
func (p *Plugin) afterSend(userID string, account *store.Account, replyTo *messageRef, messageID string, raw []byte) {
	time.Sleep(sentCopyDelay)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	err := p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		if replyTo != nil {
			if err := conn.SetFlags(ctx, replyTo.Folder, []uint32{replyTo.UID}, "answered", true); err != nil {
				p.API.LogDebug("Failed to mark the message as answered", "err", err.Error())
			}
		}
		sent, err := conn.FolderByRole(ctx, mailclient.RoleSent)
		if err != nil || sent == "" {
			return err
		}
		found, err := conn.HasMessageID(ctx, sent, messageID)
		if err != nil || found {
			return err
		}
		return conn.Append(ctx, sent, raw, []string{`\Seen`})
	})
	if err != nil {
		p.API.LogWarn("Failed to save a copy of the sent message", "user_id", userID, "err", err.Error())
	}
	p.publish(userID, wsMailUpdated, nil)
}

// POST /share {folder, uid, channel_id, comment} — post a message into a
// channel as the user, with the original attached as an .eml file.
func (p *Plugin) handleShare(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req struct {
		messageRef
		ChannelID string `json:"channel_id"`
		RootID    string `json:"root_id"`
		Comment   string `json:"comment"`
		WithFile  bool   `json:"with_file"`
	}
	if err := decodeBody(r, &req); err != nil || req.Folder == "" || req.UID == 0 || !model.IsValidId(req.ChannelID) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "folder, uid and channel_id are required")
		return
	}
	if req.RootID != "" && !model.IsValidId(req.RootID) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid root_id")
		return
	}
	if !p.API.HasPermissionToChannel(userID, req.ChannelID, model.PermissionCreatePost) {
		writeError(w, http.StatusForbidden, codeBadRequest, "no permission to post in this channel")
		return
	}
	var msg *mailclient.Message
	var raw []byte
	if !p.mailRequest(w, r, func(ctx context.Context, _ *store.Account, conn *mailclient.IMAP) error {
		var err error
		if msg, err = conn.Get(ctx, req.Folder, req.UID, false); err != nil {
			return err
		}
		if req.WithFile {
			raw, err = conn.Raw(ctx, req.Folder, req.UID, maxForwardRaw)
			if mailclient.CodeOf(err) == mailclient.CodeTooLarge {
				raw, err = nil, nil
			}
		}
		return err
	}) {
		return
	}
	post := &model.Post{UserId: userID, ChannelId: req.ChannelID, RootId: req.RootID, Message: formatShared(req.Comment, msg)}
	if len(raw) > 0 {
		name := sanitizeAttachmentName(msg.Subject) + ".eml"
		info, appErr := p.API.UploadFile(raw, req.ChannelID, name)
		if appErr == nil {
			post.FileIds = []string{info.Id}
		} else {
			p.API.LogWarn("Failed to upload the message file", "err", appErr.Error())
		}
	}
	created, appErr := p.API.CreatePost(post)
	if appErr != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, appErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "post_id": created.Id})
}

func sanitizeAttachmentName(subject string) string {
	name := strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(subject))
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	if name == "" {
		return "message"
	}
	return name
}

func formatAddress(a mailclient.Address) string {
	if a.Name != "" {
		return escape(a.Name) + " <" + escape(a.Email) + ">"
	}
	return escape(a.Email)
}

func formatAddressList(list []mailclient.Address) string {
	parts := make([]string, 0, len(list))
	for _, a := range list {
		parts = append(parts, formatAddress(a))
	}
	return strings.Join(parts, ", ")
}

// formatShared renders an e-mail as a Mattermost post: the comment, the
// headers and the beginning of the text as a quote.
func formatShared(comment string, msg *mailclient.Message) string {
	var b strings.Builder
	if c := strings.TrimSpace(comment); c != "" {
		b.WriteString(c)
		b.WriteString("\n\n")
	}
	subject := msg.Subject
	if strings.TrimSpace(subject) == "" {
		subject = "(без темы)"
	}
	b.WriteString(":email: **" + escape(subject) + "**\n")
	b.WriteString("От: " + formatAddressList(msg.From))
	if !msg.Date.IsZero() {
		b.WriteString(" · " + msg.Date.Format("02.01.2006 15:04"))
	}
	b.WriteString("\n")
	text := strings.TrimSpace(msg.Text)
	if utf8.RuneCountInString(text) > maxShareText {
		text = string([]rune(text)[:maxShareText]) + "…"
	}
	if text != "" {
		b.WriteString("\n")
		for _, line := range strings.Split(text, "\n") {
			b.WriteString("> " + line + "\n")
		}
	}
	return b.String()
}

func actionContext(r *http.Request) (*model.PostActionIntegrationRequest, messageRef, bool) {
	var req model.PostActionIntegrationRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes)).Decode(&req); err != nil {
		return nil, messageRef{}, false
	}
	ref := messageRef{}
	ref.Folder, _ = req.Context["folder"].(string)
	if uid, ok := req.Context["uid"].(float64); ok {
		ref.UID = uint32(uid)
	}
	owner, _ := req.Context["user_id"].(string)
	if ref.Folder == "" || ref.UID == 0 || owner != userIDFrom(r) {
		return nil, messageRef{}, false
	}
	return &req, ref, true
}

// POST /actions/open — "Open" button in a new mail notification.
func (p *Plugin) handleActionOpen(w http.ResponseWriter, r *http.Request) {
	_, ref, ok := actionContext(r)
	if !ok {
		writeJSON(w, http.StatusOK, &model.PostActionIntegrationResponse{EphemeralText: "Это письмо не из вашей почты."})
		return
	}
	p.publish(userIDFrom(r), wsOpenMessage, map[string]any{"folder": ref.Folder, "uid": ref.UID})
	writeJSON(w, http.StatusOK, &model.PostActionIntegrationResponse{})
}

// POST /actions/read — "Mark as read" button in a new mail notification.
func (p *Plugin) handleActionRead(w http.ResponseWriter, r *http.Request) {
	req, ref, ok := actionContext(r)
	if !ok {
		writeJSON(w, http.StatusOK, &model.PostActionIntegrationResponse{EphemeralText: "Это письмо не из вашей почты."})
		return
	}
	userID := userIDFrom(r)
	account, err := p.store.GetAccount(userID)
	if err != nil || account == nil {
		writeJSON(w, http.StatusOK, &model.PostActionIntegrationResponse{EphemeralText: messageFor(codeNotConnected)})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	err = p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		return conn.SetFlags(ctx, ref.Folder, []uint32{ref.UID}, "seen", true)
	})
	if err != nil {
		writeJSON(w, http.StatusOK, &model.PostActionIntegrationResponse{EphemeralText: messageFor(errorCode(err))})
		return
	}
	p.publish(userID, wsMailUpdated, nil)
	resp := &model.PostActionIntegrationResponse{}
	if post, appErr := p.API.GetPost(req.PostId); appErr == nil && post.UserId == p.botID {
		markNotificationRead(post)
		resp.Update = post
	}
	writeJSON(w, http.StatusOK, resp)
}
