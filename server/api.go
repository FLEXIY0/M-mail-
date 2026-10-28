package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/mux"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	maxBodyBytes  = 64 << 10
	checkTimeout  = 40 * time.Second
	maxSignature  = 2000
	maxNameLength = 100
)

func (p *Plugin) initRouter() *mux.Router {
	router := mux.NewRouter()
	router.Use(p.requireUser)

	api := router.PathPrefix("/api/v1").Subrouter()
	api.HandleFunc("/config", p.handleConfig).Methods(http.MethodGet)
	api.HandleFunc("/me", p.handleMe).Methods(http.MethodGet)
	api.HandleFunc("/check", p.handleCheck).Methods(http.MethodPost)
	api.HandleFunc("/connect", p.handleConnect).Methods(http.MethodPost)
	api.HandleFunc("/settings", p.handleSettings).Methods(http.MethodPut)
	api.HandleFunc("/disconnect", p.handleDisconnect).Methods(http.MethodPost)
	api.HandleFunc("/sync", p.handleSync).Methods(http.MethodPost)
	api.HandleFunc("/preferences", p.handlePreferences).Methods(http.MethodPut)
	api.HandleFunc("/admin/update", p.handleUpdateInfo).Methods(http.MethodGet)

	api.HandleFunc("/folders", p.handleFolders).Methods(http.MethodGet)
	api.HandleFunc("/messages", p.handleMessages).Methods(http.MethodGet)
	api.HandleFunc("/message", p.handleMessage).Methods(http.MethodGet)
	api.HandleFunc("/attachment", p.handleAttachment).Methods(http.MethodGet)
	api.HandleFunc("/flags", p.handleFlags).Methods(http.MethodPost)
	api.HandleFunc("/move", p.handleMove).Methods(http.MethodPost)
	api.HandleFunc("/delete", p.handleDelete).Methods(http.MethodPost)
	api.HandleFunc("/send", p.handleSend).Methods(http.MethodPost)
	api.HandleFunc("/drafts", p.handleSaveDraft).Methods(http.MethodPost)
	api.HandleFunc("/folders/create", p.handleCreateFolder).Methods(http.MethodPost)
	api.HandleFunc("/folders/rename", p.handleRenameFolder).Methods(http.MethodPost)
	api.HandleFunc("/folders/delete", p.handleDeleteFolder).Methods(http.MethodPost)
	api.HandleFunc("/folders/read", p.handleReadAll).Methods(http.MethodPost)
	api.HandleFunc("/folders/empty", p.handleEmptyFolder).Methods(http.MethodPost)
	api.HandleFunc("/signature-image", p.handleGetSignatureImage).Methods(http.MethodGet)
	api.HandleFunc("/signature-image", p.handlePutSignatureImage).Methods(http.MethodPut)
	api.HandleFunc("/signature-image/delete", p.handleDeleteSignatureImage).Methods(http.MethodPost)
	api.HandleFunc("/share", p.handleShare).Methods(http.MethodPost)
	api.HandleFunc("/actions/open", p.handleActionOpen).Methods(http.MethodPost)
	api.HandleFunc("/actions/read", p.handleActionRead).Methods(http.MethodPost)
	return router
}

func (p *Plugin) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Mattermost-User-ID") == "" {
			writeError(w, http.StatusUnauthorized, codeBadRequest, "not authorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func userIDFrom(r *http.Request) string {
	return r.Header.Get("Mattermost-User-ID")
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, details string) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: messageFor(code), Details: details}})
}

// writeMailError reports a mail problem. Most are the user's problems
// (wrong password, wrong address), so they use 422, not 500.
func writeMailError(w http.ResponseWriter, err error) {
	code := errorCode(err)
	status := http.StatusUnprocessableEntity
	switch code {
	case codeInternal:
		status = http.StatusInternalServerError
	case string(mailclient.CodeNotFound):
		status = http.StatusNotFound
	}
	writeError(w, status, code, err.Error())
}

func decodeBody(r *http.Request, v any) error {
	return decodeLimited(r, v, maxBodyBytes)
}

func decodeLimited(r *http.Request, v any, limit int64) error {
	return json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(v)
}

// GET /config — everything the wizard needs before the user connects.
func (p *Plugin) handleConfig(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	email, name := "", ""
	if user, err := p.client.User.Get(userID); err == nil {
		email = user.Email
		name = strings.TrimSpace(user.FirstName + " " + user.LastName)
	}
	cfg := p.getConfiguration()
	writeJSON(w, http.StatusOK, map[string]any{
		"providers":            p.providers(),
		"default_provider":     p.defaultProviderFor(email),
		"help_text":            cfg.helpText(),
		"email":                email,
		"display_name":         name,
		"default_settings":     store.DefaultSettings(),
		"bot_username":         botUsername,
		"max_attachment_bytes": cfg.maxAttachmentBytes(),
	})
}

type meResponse struct {
	Connected    bool                 `json:"connected"`
	Provider     string               `json:"provider,omitempty"`
	ProviderName string               `json:"provider_name,omitempty"`
	Username     string               `json:"username,omitempty"`
	Email        string               `json:"email,omitempty"`
	DisplayName  string               `json:"display_name,omitempty"`
	IMAP         *mailclient.Endpoint `json:"imap,omitempty"`
	SMTP         *mailclient.Endpoint `json:"smtp,omitempty"`
	WebURL       string               `json:"web_url,omitempty"`
	Settings     *store.Settings      `json:"settings,omitempty"`
	Sync         *syncInfo            `json:"sync,omitempty"`
	Icon         iconInfo             `json:"icon"`
}

type syncInfo struct {
	LastSuccess  *time.Time `json:"last_success,omitempty"`
	LastAttempt  *time.Time `json:"last_attempt,omitempty"`
	ErrorCode    string     `json:"error_code,omitempty"`
	ErrorMessage string     `json:"error_message,omitempty"`
	ErrorDetails string     `json:"error_details,omitempty"`
	AuthFailed   bool       `json:"auth_failed,omitempty"`
	Unseen       int        `json:"unseen"`
}

type iconInfo struct {
	Action string `json:"action"`
	// WebURL is what the icon opens in "browser" mode: the user's own
	// address, or the default one of their provider.
	WebURL        string `json:"web_url"`
	CustomWebURL  string `json:"custom_web_url"`
	DefaultWebURL string `json:"default_web_url"`
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// iconInfoFor decides what the app bar icon opens. email picks the web
// mail of the likely provider for users who did not connect.
func (p *Plugin) iconInfoFor(prefs *store.Preferences, account *store.Account, email string) iconInfo {
	info := iconInfo{Action: "panel"}
	if prefs != nil && prefs.IconAction == "browser" {
		info.Action = "browser"
	}
	if account != nil {
		info.DefaultWebURL = p.webURLFor(account.Provider)
	} else {
		info.DefaultWebURL = p.webURLFor(p.defaultProviderFor(email))
	}
	info.WebURL = info.DefaultWebURL
	if prefs != nil && prefs.WebURL != "" {
		info.CustomWebURL = prefs.WebURL
		info.WebURL = prefs.WebURL
	}
	return info
}

func (p *Plugin) userEmail(userID string) string {
	if user, err := p.client.User.Get(userID); err == nil && user != nil {
		return user.Email
	}
	return ""
}

func (p *Plugin) buildMe(userID string) (*meResponse, error) {
	account, err := p.store.GetAccount(userID)
	if err != nil {
		return nil, err
	}
	prefs, err := p.store.GetPreferences(userID)
	if err != nil {
		return nil, err
	}
	email := ""
	if account == nil {
		email = p.userEmail(userID)
	}
	me := &meResponse{Icon: p.iconInfoFor(prefs, account, email)}
	if account == nil {
		return me, nil
	}
	settings := account.Settings
	me.Connected = true
	me.Provider = account.Provider
	me.ProviderName = account.Provider
	if pr, ok := p.provider(account.Provider); ok {
		me.ProviderName = pr.Name
	}
	me.Username = account.Username
	me.Email = account.Email
	me.DisplayName = account.DisplayName
	if account.Provider == providerCustom {
		imapEndpoint, smtpEndpoint := account.IMAP, account.SMTP
		me.IMAP, me.SMTP = &imapEndpoint, &smtpEndpoint
	}
	me.WebURL = p.webURLFor(account.Provider)
	me.Settings = &settings

	state, err := p.store.GetSyncState(userID)
	if err != nil {
		return nil, err
	}
	me.Sync = &syncInfo{
		LastSuccess:  timePtr(state.LastSuccess),
		LastAttempt:  timePtr(state.LastAttempt),
		ErrorCode:    state.ErrorCode,
		ErrorDetails: state.ErrorText,
		AuthFailed:   state.AuthFailed,
		Unseen:       state.Unseen,
	}
	if state.ErrorCode != "" {
		me.Sync.ErrorMessage = messageFor(state.ErrorCode)
	}
	return me, nil
}

// GET /me — connection state for the panel.
func (p *Plugin) handleMe(w http.ResponseWriter, r *http.Request) {
	me, err := p.buildMe(userIDFrom(r))
	if err != nil {
		p.API.LogError("Failed to build state", "err", err.Error())
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}

type credentialsRequest struct {
	Provider string              `json:"provider"`
	IMAP     mailclient.Endpoint `json:"imap"`
	SMTP     mailclient.Endpoint `json:"smtp"`
	Username string              `json:"username"`
	Password string              `json:"password"`
}

// normalizePassword removes the spaces providers insert for readability:
// Yandex and Mail.ru show app passwords in groups ("abcd efgh ijkl mnop").
func normalizePassword(password string) string {
	return strings.Join(strings.Fields(password), "")
}

type checkResult struct {
	IMAP    mailclient.Endpoint `json:"imap"`
	SMTP    mailclient.Endpoint `json:"smtp"`
	Folders int                 `json:"folders"`
	Unseen  int                 `json:"unseen"`
	Total   int                 `json:"total"`
}

// verify logs in to IMAP and SMTP with the credentials. Both are checked:
// an app password may allow reading mail but not sending it.
func (p *Plugin) verify(ctx context.Context, req credentialsRequest) (*checkResult, error) {
	imapEndpoint, smtpEndpoint, err := p.resolveServers(req.Provider, req.IMAP, req.SMTP)
	if err != nil {
		return nil, err
	}
	creds := mailclient.Credentials{Username: strings.TrimSpace(req.Username), Password: normalizePassword(req.Password)}
	policy := mailclient.Policy{AllowPrivateNetworks: p.allowPrivateFor(req.Provider, imapEndpoint, smtpEndpoint)}

	conn, err := mailclient.DialIMAP(ctx, imapEndpoint, creds, policy)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	result := &checkResult{IMAP: imapEndpoint, SMTP: smtpEndpoint}
	if status, statusErr := conn.Status(ctx, "INBOX"); statusErr == nil {
		result.Unseen = status.Unseen
		result.Total = status.Total
	}
	if folders, listErr := conn.Folders(ctx); listErr == nil {
		result.Folders = len(folders)
	}
	if err = mailclient.VerifySMTP(ctx, smtpEndpoint, creds, policy); err != nil {
		var merr *mailclient.Error
		if errors.As(err, &merr) {
			merr.Op = "smtp: " + merr.Op
		}
		return nil, err
	}
	return result, nil
}

// POST /check — "Check connection" button in the wizard.
func (p *Plugin) handleCheck(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req credentialsRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Username) == "" || normalizePassword(req.Password) == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "username and password are required")
		return
	}
	if !p.limiter.allow(userID) {
		writeError(w, http.StatusTooManyRequests, codeRateLimited, "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	result, err := p.verify(ctx, req)
	if err != nil {
		writeMailError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type connectRequest struct {
	credentialsRequest
	Email       string          `json:"email"`
	DisplayName string          `json:"display_name"`
	Settings    *store.Settings `json:"settings"`
}

func sanitizeSettings(in store.Settings) store.Settings {
	out := in
	if out.SignatureLayout != "above" {
		out.SignatureLayout = "left"
	}
	out.Signature = strings.TrimSpace(strings.ReplaceAll(in.Signature, "\r\n", "\n"))
	if utf8.RuneCountInString(out.Signature) > maxSignature {
		out.Signature = string([]rune(out.Signature)[:maxSignature])
	}
	return out
}

func cleanName(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s))
	if utf8.RuneCountInString(s) > maxNameLength {
		s = string([]rune(s)[:maxNameLength])
	}
	return s
}

// POST /connect — final step of the wizard.
func (p *Plugin) handleConnect(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req connectRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	if !p.limiter.allow(userID) {
		writeError(w, http.StatusTooManyRequests, codeRateLimited, "")
		return
	}
	settings := store.DefaultSettings()
	if req.Settings != nil {
		settings = sanitizeSettings(*req.Settings)
	}

	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	result, err := p.verify(ctx, req.credentialsRequest)
	if err != nil {
		writeMailError(w, err)
		return
	}
	box, err := p.getBox()
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
		return
	}
	encrypted, err := box.Encrypt(normalizePassword(req.Password))
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
		return
	}
	username := strings.TrimSpace(req.Username)
	email := strings.TrimSpace(req.Email)
	if !looksLikeEmail(email) {
		email = username
	}
	previous, _ := p.store.GetAccount(userID)
	account := &store.Account{
		Provider:          req.Provider,
		IMAP:              result.IMAP,
		SMTP:              result.SMTP,
		Username:          username,
		PasswordEncrypted: encrypted,
		Email:             email,
		DisplayName:       cleanName(req.DisplayName),
		Settings:          settings,
		ConnectedAt:       time.Now(),
	}
	if err = p.store.SaveAccount(userID, account); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if err = p.store.ResetSync(userID); err != nil {
		p.API.LogWarn("Failed to reset sync state", "user_id", userID, "err", err.Error())
	}
	p.sessions.drop(userID)
	// Remember the current state of Inbox right away, so that the first
	// background check does not report old unread mail as new.
	p.checkLater(userID)
	if previous == nil {
		p.sendWelcome(userID, account)
	}
	me, err := p.buildMe(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func looksLikeEmail(s string) bool {
	at := strings.LastIndex(s, "@")
	return at > 0 && at < len(s)-1 && !strings.ContainsAny(s, " <>,;")
}

func (p *Plugin) sendWelcome(userID string, account *store.Account) {
	var features []string
	if account.Settings.NotifyNew {
		features = append(features, "- :envelope_with_arrow: сообщу о новых письмах во «Входящих»")
	}
	features = append(features,
		"- :inbox_tray: письма можно читать и отвечать на них на правой панели — иконка почты справа",
		"- :outbox_tray: любое сообщение из Mattermost можно отправить по почте: «Действия» → «Отправить по почте»",
	)
	message := "#### :tada: Почта подключена\n" +
		"Ящик: **" + escape(account.Email) + "**.\n\n" +
		strings.Join(features, "\n") + "\n\n" +
		"Команды: `/mail inbox`, `/mail new`, `/mail settings`. Справка: `/mail help`."
	p.sendDM(userID, message)
}

type settingsRequest struct {
	DisplayName *string        `json:"display_name"`
	Settings    store.Settings `json:"settings"`
}

// PUT /settings — save preferences of a connected account.
func (p *Plugin) handleSettings(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req settingsRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	account, err := p.store.GetAccount(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if account == nil {
		writeError(w, http.StatusNotFound, codeNotConnected, "")
		return
	}
	hasImage := account.Settings.SignatureImage
	account.Settings = sanitizeSettings(req.Settings)
	// The picture flag is managed by /signature-image, not by the form.
	account.Settings.SignatureImage = hasImage
	if req.DisplayName != nil {
		account.DisplayName = cleanName(*req.DisplayName)
	}
	if err = p.store.SaveAccount(userID, account); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	me, err := p.buildMe(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}

// POST /disconnect — forget the account and everything cached for it.
func (p *Plugin) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	if err := p.disconnect(userID); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	me, err := p.buildMe(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func (p *Plugin) disconnect(userID string) error {
	if err := p.store.DeleteUser(userID); err != nil {
		return err
	}
	p.sessions.drop(userID)
	p.publish(userID, wsMailUpdated, map[string]any{"disconnected": true})
	return nil
}

// POST /sync — the refresh button. It also retries after an auth failure.
func (p *Plugin) handleSync(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	if err := p.checkUser(ctx, userID, true); err != nil {
		p.API.LogDebug("Manual check failed", "user_id", userID, "err", err.Error())
	}
	me, err := p.buildMe(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}

type preferencesRequest struct {
	IconAction string `json:"icon_action"`
	WebURL     string `json:"web_url"`
}

// PUT /preferences — what the app bar icon opens.
func (p *Plugin) handlePreferences(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req preferencesRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	prefs := &store.Preferences{}
	if req.IconAction == "browser" {
		prefs.IconAction = "browser"
	}
	if raw := strings.TrimSpace(req.WebURL); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			writeError(w, http.StatusBadRequest, codeInvalidWebURL, "")
			return
		}
		prefs.WebURL = u.String()
	}
	if err := p.store.SavePreferences(userID, prefs); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	account, _ := p.store.GetAccount(userID)
	writeJSON(w, http.StatusOK, p.iconInfoFor(prefs, account, p.userEmail(userID)))
}
