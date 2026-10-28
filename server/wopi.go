package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi"
)

// Office documents are shown by Collabora Online over WOPI: the panel opens
// Collabora in a frame, and Collabora fetches the file from the plugin with
// a short-lived token. Mattermost is the "WOPI host"; Collabora must trust
// its address (aliasgroup in coolwsd.xml).

const (
	wopiPrefix        = "w:"
	wopiTokenTTL      = 4 * time.Hour
	discoveryTTL      = time.Hour
	discoveryFailTTL  = time.Minute
	discoveryTimeout  = 8 * time.Second
	maxDiscoveryBytes = 4 << 20
	codeOfficeOff     = "office_unavailable"
)

func init() {
	errorMessages[codeOfficeOff] = "Просмотр документов не настроен или этот формат Collabora не открывает. Файл можно скачать."
}

type discoveryXML struct {
	Zones []struct {
		Apps []struct {
			Name    string `xml:"name,attr"`
			Actions []struct {
				Name   string `xml:"name,attr"`
				Ext    string `xml:"ext,attr"`
				URLSrc string `xml:"urlsrc,attr"`
			} `xml:"action"`
		} `xml:"app"`
	} `xml:"net-zone"`
}

// officeDiscovery is what Collabora can open: file extension → address of
// its viewer.
type officeDiscovery struct {
	url     string
	views   map[string]string
	fetched time.Time
	err     error
}

type officeState struct {
	mu   sync.Mutex
	disc *officeDiscovery
}

var rePlaceholder = regexp.MustCompile(`<[^>]*>`)

func fetchDiscovery(ctx context.Context, base string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/hosting/discovery", nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discovery: HTTP %d", res.StatusCode)
	}
	var doc discoveryXML
	if err = xml.NewDecoder(io.LimitReader(res.Body, maxDiscoveryBytes)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("discovery: not a Collabora answer: %w", err)
	}
	views := map[string]string{}
	edits := map[string]string{}
	for _, z := range doc.Zones {
		for _, a := range z.Apps {
			for _, act := range a.Actions {
				ext := strings.ToLower(act.Ext)
				if ext == "" || act.URLSrc == "" {
					continue
				}
				// Templates such as <ui=UI_LLCC&> are optional parameters.
				src := rePlaceholder.ReplaceAllString(act.URLSrc, "")
				switch act.Name {
				case "view":
					views[ext] = src
				case "edit":
					edits[ext] = src
				}
			}
		}
	}
	// Formats Collabora only "edits" are opened read-only all the same.
	for ext, src := range edits {
		if _, ok := views[ext]; !ok {
			views[ext] = src
		}
	}
	if len(views) == 0 {
		return nil, errors.New("discovery: no formats")
	}
	return views, nil
}

// officeViews returns the formats of the configured Collabora, cached.
func (p *Plugin) officeViews(ctx context.Context) (map[string]string, error) {
	base := p.getConfiguration().collaboraURL()
	if base == "" {
		return nil, errors.New("collabora is not configured")
	}
	p.office.mu.Lock()
	defer p.office.mu.Unlock()
	d := p.office.disc
	if d != nil && d.url == base {
		ttl := discoveryTTL
		if d.err != nil {
			ttl = discoveryFailTTL
		}
		if time.Since(d.fetched) < ttl {
			return d.views, d.err
		}
	}
	views, err := fetchDiscovery(ctx, base)
	p.office.disc = &officeDiscovery{url: base, views: views, fetched: time.Now(), err: err}
	if err != nil {
		p.API.LogWarn("Collabora Online is not available", "url", base, "err", err.Error())
	}
	return views, err
}

func fileExt(name string) string {
	return strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
}

// officeSupports tells whether Collabora shows files like this one. Images,
// PDF and media are left to the browser.
func (p *Plugin) officeSupports(ctx context.Context, filename string) bool {
	if p.getConfiguration().collaboraURL() == "" {
		return false
	}
	views, err := p.officeViews(ctx)
	if err != nil {
		return false
	}
	_, ok := views[fileExt(filename)]
	return ok
}

// wopiFile is what a token opens.
type wopiFile struct {
	TokenHash string        `json:"token_hash"`
	UserID    string        `json:"user_id"`
	Ref       attachmentRef `json:"ref"`
	Filename  string        `json:"filename"`
	Size      int64         `json:"size"`
	Expires   int64         `json:"expires"`
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// wopiBase is the address of Mattermost as Collabora sees it.
func (p *Plugin) wopiBase() string {
	if u := strings.TrimRight(strings.TrimSpace(p.getConfiguration().CollaboraWOPIURL), "/"); u != "" {
		return u
	}
	return p.siteURL()
}

// siteURL is the address of Mattermost in the browser.
func (p *Plugin) siteURL() string {
	if cfg := p.API.GetConfig(); cfg != nil && cfg.ServiceSettings.SiteURL != nil {
		return strings.TrimRight(*cfg.ServiceSettings.SiteURL, "/")
	}
	return ""
}

func (p *Plugin) wopiSrc(fileID string) string {
	return p.wopiBase() + "/plugins/" + manifest.Id + "/wopi/files/" + fileID
}

// POST /office/open {folder, uid, part, sub} — a token for Collabora.
func (p *Plugin) handleOfficeOpen(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var ref attachmentRef
	if err := decodeBody(r, &ref); err != nil || ref.Part == "" || ref.UID == 0 {
		writeError(w, http.StatusBadRequest, codeBadRequest, "folder, uid and part are required")
		return
	}
	account := p.accountFor(w, userID)
	if account == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
	defer cancel()
	views, err := p.officeViews(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, codeOfficeOff, err.Error())
		return
	}
	meta, data, err := p.loadAttachment(ctx, userID, account, ref)
	if err != nil {
		writeMailError(w, err)
		return
	}
	action, ok := views[fileExt(meta.Filename)]
	if !ok {
		writeError(w, http.StatusBadRequest, codeOfficeOff, "format "+fileExt(meta.Filename))
		return
	}
	if p.wopiBase() == "" {
		writeError(w, http.StatusServiceUnavailable, codeOfficeOff, "Site URL is not set")
		return
	}
	token := randomToken()
	fileID := model.NewId()
	expires := time.Now().Add(wopiTokenTTL)
	rec := wopiFile{TokenHash: hashToken(token), UserID: userID, Ref: ref, Filename: meta.Filename, Size: int64(len(data)), Expires: expires.Unix()}
	if _, err = p.client.KV.Set(wopiPrefix+fileID, rec, pluginapi.SetExpiry(wopiTokenTTL)); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	sep := "?"
	if strings.Contains(action, "?") {
		sep = "&"
		if strings.HasSuffix(action, "?") || strings.HasSuffix(action, "&") {
			sep = ""
		}
	}
	actionURL := action + sep + "WOPISrc=" + url.QueryEscape(p.wopiSrc(fileID)) + "&lang=ru-RU&closebutton=0"
	writeJSON(w, http.StatusOK, map[string]any{
		"action_url":       actionURL,
		"access_token":     token,
		"access_token_ttl": expires.UnixMilli(),
		"filename":         meta.Filename,
	})
}

// wopiFileFor checks the token of a request from Collabora.
func (p *Plugin) wopiFileFor(r *http.Request) (*wopiFile, bool) {
	fileID := mux.Vars(r)["id"]
	token := r.URL.Query().Get("access_token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if !model.IsValidId(fileID) || token == "" {
		return nil, false
	}
	var rec wopiFile
	if err := p.client.KV.Get(wopiPrefix+fileID, &rec); err != nil || rec.UserID == "" {
		return nil, false
	}
	if time.Now().Unix() > rec.Expires || subtle.ConstantTimeCompare([]byte(rec.TokenHash), []byte(hashToken(token))) != 1 {
		return nil, false
	}
	return &rec, true
}

// GET /wopi/files/{id} — CheckFileInfo.
func (p *Plugin) handleWopiInfo(w http.ResponseWriter, r *http.Request) {
	if mux.Vars(r)["id"] == "check" {
		// The connection test of Collabora (wopiAccessCheck) lands here.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	rec, ok := p.wopiFileFor(r)
	if !ok {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	name := rec.UserID
	if user, err := p.client.User.Get(rec.UserID); err == nil {
		name = strings.TrimSpace(user.FirstName + " " + user.LastName)
		if name == "" {
			name = user.Username
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"BaseFileName":            rec.Filename,
		"Size":                    rec.Size,
		"OwnerId":                 "mail",
		"UserId":                  rec.UserID,
		"UserFriendlyName":        name,
		"Version":                 strconv.FormatInt(rec.Expires, 10),
		"ReadOnly":                true,
		"UserCanWrite":            false,
		"UserCanNotWriteRelative": true,
		"SupportsUpdate":          false,
		"SupportsLocks":           false,
		"HideSaveOption":          true,
		"HideExportOption":        false,
		"DisablePrint":            false,
		"DisableExport":           false,
		"DisableCopy":             false,
		"EnableOwnerTermination":  false,
		"PostMessageOrigin":       p.siteURL(),
	})
}

// GET /wopi/files/{id}/contents — GetFile.
func (p *Plugin) handleWopiContents(w http.ResponseWriter, r *http.Request) {
	rec, ok := p.wopiFileFor(r)
	if !ok {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	account, err := p.store.GetAccount(rec.UserID)
	if err != nil || account == nil {
		http.Error(w, "mailbox is not connected", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
	defer cancel()
	_, data, err := p.loadAttachment(ctx, rec.UserID, account, rec.Ref)
	if err != nil {
		http.Error(w, "cannot read the attachment", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-WOPI-ItemVersion", strconv.FormatInt(rec.Expires, 10))
	_, _ = w.Write(data)
}

// Everything else (PutFile, Lock…) is refused: documents are read-only.
func (p *Plugin) handleWopiReadOnly(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "read-only", http.StatusNotImplemented)
}

// officeCheckStep is one line of the check in the System Console.
type officeCheckStep struct {
	Title  string `json:"title"`
	OK     bool   `json:"ok"`
	Text   string `json:"text"`
	Warn   bool   `json:"warn,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// describeNetError explains why Mattermost could not reach Collabora.
func describeNetError(err error) string {
	var dnsErr *net.DNSError
	var urlErr *url.Error
	switch {
	case errors.As(err, &dnsErr):
		return "Сервер Mattermost не нашёл такой адрес (DNS). Проверьте адрес или DNS внутри сети."
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &urlErr) && urlErr.Timeout()):
		return "Collabora не ответила вовремя: возможно, сервер Mattermost не видит её по сети (фаервол, прокси)."
	case strings.Contains(err.Error(), "certificate"):
		return "Сертификат Collabora не принят сервером Mattermost (самоподписанный или просроченный)."
	case strings.Contains(err.Error(), "connection refused"):
		return "Соединение отклонено: по этому адресу и порту Collabora не слушает."
	}
	return err.Error()
}

// GET /admin/collabora/check — what works and what to ask the
// administrator of Collabora.
func (p *Plugin) handleCollaboraCheck(w http.ResponseWriter, r *http.Request) {
	if !p.isSystemAdmin(userIDFrom(r)) {
		writeError(w, http.StatusForbidden, codeBadRequest, "system admin only")
		return
	}
	base := p.getConfiguration().collaboraURL()
	wopiBase := p.wopiBase()
	steps := []officeCheckStep{}
	result := map[string]any{"collabora_url": base, "wopi_url": wopiBase}
	if base == "" {
		steps = append(steps, officeCheckStep{Title: "Адрес Collabora", Text: "Не указан: офисные документы скачиваются. Впишите адрес, сохраните настройки и проверьте снова."})
		result["steps"] = steps
		writeJSON(w, http.StatusOK, result)
		return
	}
	if wopiBase == "" {
		steps = append(steps, officeCheckStep{Title: "Адрес Mattermost", Text: "Не задан Site URL в настройках Mattermost (Environment → Web Server) — Collabora не узнает, откуда брать файлы."})
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	views, err := fetchDiscovery(ctx, base)
	p.office.mu.Lock()
	p.office.disc = &officeDiscovery{url: base, views: views, fetched: time.Now(), err: err}
	p.office.mu.Unlock()
	if err != nil {
		steps = append(steps, officeCheckStep{Title: "Mattermost → Collabora", Text: describeNetError(err), Detail: err.Error()})
		result["steps"] = steps
		writeJSON(w, http.StatusOK, result)
		return
	}
	_, docx := views["docx"]
	_, xlsx := views["xlsx"]
	steps = append(steps, officeCheckStep{Title: "Mattermost → Collabora", OK: true, Text: fmt.Sprintf("Collabora отвечает, форматов для просмотра: %d (Word: %s, Excel: %s).", len(views), yesNo(docx), yesNo(xlsx))})

	// Collabora 24.04+ can test the way back itself: whether it trusts
	// this Mattermost and can reach it.
	status, err := wopiAccessCheck(ctx, base, wopiBase+"/plugins/"+manifest.Id+"/wopi/files/check")
	switch {
	case err != nil:
		steps = append(steps, officeCheckStep{Title: "Collabora → Mattermost", Warn: true, Text: "Эта версия Collabora не умеет самопроверку. Доверие к Mattermost проверится при открытии первого документа.", Detail: err.Error()})
	case status == "Ok":
		steps = append(steps, officeCheckStep{Title: "Collabora → Mattermost", OK: true, Text: "Collabora доверяет этому Mattermost и достаёт файлы. Всё готово."})
	case status == "WopiHostNotAllowed":
		steps = append(steps, officeCheckStep{Title: "Collabora → Mattermost", Text: "Collabora не доверяет адресу Mattermost. Попросите администратора Collabora добавить его (строки ниже) и перезапустить Collabora.", Detail: status})
	default:
		steps = append(steps, officeCheckStep{Title: "Collabora → Mattermost", Text: wopiStatusText(status), Detail: status})
	}
	result["steps"] = steps
	if u, err := url.Parse(wopiBase); err == nil && u.Host != "" {
		port := u.Port()
		if port == "" {
			port = map[bool]string{true: "443", false: "80"}[u.Scheme == "https"]
		}
		hostport := u.Scheme + "://" + u.Hostname() + ":" + port
		result["alias_line"] = "aliasgroup1=" + hostport
		result["xml"] = "<storage><wopi allow=\"true\"><alias_groups mode=\"groups\"><group><host desc=\"Mattermost\" allow=\"true\">" + hostport + "</host></group></alias_groups></wopi></storage>"
	}
	writeJSON(w, http.StatusOK, result)
}

func yesNo(b bool) string {
	if b {
		return "да"
	}
	return "нет"
}

func wopiStatusText(status string) string {
	switch status {
	case "HostNotFound":
		return "Collabora не нашла адрес Mattermost (DNS со стороны Collabora). Возможно, нужен внутренний адрес — укажите его в поле «Адрес Mattermost для Collabora»."
	case "Timeout", "ConnectionAborted":
		return "Collabora не может достучаться до Mattermost по сети (фаервол или прокси между ними)."
	case "CertificateValidation", "SslHandshakeFail":
		return "Collabora не принимает сертификат Mattermost."
	case "NotHttps":
		return "Collabora требует https-адрес Mattermost."
	case "NotHttpSuccess":
		return "Mattermost ответил Collabora ошибкой: проверьте, что плагин включён и адрес указан верно."
	}
	return "Collabora сообщила: " + status
}

// wopiAccessCheck asks Collabora to test a WOPI host address.
func wopiAccessCheck(ctx context.Context, base, callback string) (string, error) {
	body, _ := json.Marshal(map[string]string{"callbackUrl": callback})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/hosting/wopiAccessCheck", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("wopiAccessCheck: HTTP %d", res.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil || out.Status == "" {
		return "", fmt.Errorf("wopiAccessCheck: unexpected answer")
	}
	return out.Status, nil
}
