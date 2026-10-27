package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"golang.org/x/mod/semver"
)

const (
	defaultUpdateSource = "FLEXIY0/M-mail-"
	updateCheckTTL      = 10 * time.Minute
	updateNotifiedKey   = "update:notified"
)

// release is the part of a GitHub (or Gitea) release the updater needs.
type release struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	HTMLURL     string    `json:"html_url"`
	PublishedAt time.Time `json:"published_at"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

func (r *release) version() string {
	return strings.TrimPrefix(strings.TrimSpace(r.TagName), "v")
}

type updater struct {
	mu        sync.Mutex
	latest    *release
	checkedAt time.Time
	lastErr   error
	http      *http.Client
}

func newUpdater() *updater {
	return &updater{http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *configuration) updateSource() string {
	if s := strings.TrimSpace(c.UpdateSource); s != "" {
		return s
	}
	return defaultUpdateSource
}

// releaseAPIURL accepts "owner/repo" (GitHub) or a full URL of a
// GitHub-compatible "latest release" endpoint (e.g. a self-hosted Gitea).
func releaseAPIURL(source string) (string, error) {
	source = strings.TrimSpace(source)
	if strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "http://") {
		return source, nil
	}
	parts := strings.Split(strings.Trim(source, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("источник обновлений должен быть в виде владелец/репозиторий, а не %q", source)
	}
	return "https://api.github.com/repos/" + parts[0] + "/" + parts[1] + "/releases/latest", nil
}

// newerThan compares plugin versions; build metadata (+hash) is ignored.
func newerThan(candidate, current string) bool {
	c, cur := "v"+strings.TrimPrefix(candidate, "v"), "v"+strings.TrimPrefix(current, "v")
	if !semver.IsValid(c) {
		return false
	}
	if !semver.IsValid(cur) {
		return true
	}
	return semver.Compare(c, cur) > 0
}

// pickAsset chooses the smallest bundle that runs on this server: the
// platform specific one when published, the universal one otherwise.
func pickAsset(r *release, pluginID string) (name, url string) {
	platform := fmt.Sprintf("-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	var universal, anyBundle [2]string
	for _, a := range r.Assets {
		if !strings.HasSuffix(a.Name, ".tar.gz") {
			continue
		}
		if strings.HasSuffix(a.Name, platform) {
			return a.Name, a.URL
		}
		if anyBundle[0] == "" {
			anyBundle = [2]string{a.Name, a.URL}
		}
		isPlatform := false
		for _, os := range []string{"-linux-", "-darwin-", "-windows-"} {
			if strings.Contains(a.Name, os) {
				isPlatform = true
			}
		}
		if !isPlatform && strings.HasPrefix(a.Name, pluginID) && universal[0] == "" {
			universal = [2]string{a.Name, a.URL}
		}
	}
	if universal[0] != "" {
		return universal[0], universal[1]
	}
	return anyBundle[0], anyBundle[1]
}

func (u *updater) fetchLatest(ctx context.Context, source string) (*release, error) {
	apiURL, err := releaseAPIURL(source)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, http.NoBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgentUpdater)
	resp, err := u.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("не удалось связаться с GitHub: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, errors.New("в репозитории пока нет опубликованных релизов")
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		return nil, errors.New("GitHub временно ограничил запросы, попробуйте позже")
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GitHub ответил HTTP %d", resp.StatusCode)
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&r); err != nil {
		return nil, fmt.Errorf("неожиданный ответ GitHub: %w", err)
	}
	return &r, nil
}

const userAgentUpdater = "Mattermost-Calendar-Plugin-Updater"

// latestRelease returns the cached release, refreshing it when stale.
func (p *Plugin) latestRelease(ctx context.Context, force bool) (*release, error) {
	u := p.updater
	u.mu.Lock()
	defer u.mu.Unlock()
	if !force && time.Since(u.checkedAt) < updateCheckTTL {
		return u.latest, u.lastErr
	}
	r, err := u.fetchLatest(ctx, p.getConfiguration().updateSource())
	u.checkedAt = time.Now()
	u.lastErr = err
	if err == nil {
		u.latest = r
	}
	return u.latest, err
}

func (p *Plugin) uploadsEnabled() bool {
	cfg := p.API.GetConfig()
	return cfg != nil && cfg.PluginSettings.EnableUploads != nil && *cfg.PluginSettings.EnableUploads
}

func (p *Plugin) isSystemAdmin(userID string) bool {
	return p.API.HasPermissionTo(userID, model.PermissionManageSystem)
}

type updateInfo struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	Name            string `json:"name,omitempty"`
	Notes           string `json:"notes,omitempty"`
	URL             string `json:"url,omitempty"`
	PublishedAt     string `json:"published_at,omitempty"`
	Asset           string `json:"asset,omitempty"`
	AssetURL        string `json:"asset_url,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
	UploadsEnabled  bool   `json:"uploads_enabled"`
	Source          string `json:"source"`
	CheckError      string `json:"check_error,omitempty"`
}

// GET /admin/update — shown in the System Console.
func (p *Plugin) handleUpdateInfo(w http.ResponseWriter, r *http.Request) {
	if !p.isSystemAdmin(userIDFrom(r)) {
		writeError(w, http.StatusForbidden, codeBadRequest, "system admin only")
		return
	}
	info := updateInfo{
		Current:        manifest.Version,
		UploadsEnabled: p.uploadsEnabled(),
		Source:         p.getConfiguration().updateSource(),
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	rel, err := p.latestRelease(ctx, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		info.CheckError = err.Error()
	}
	if rel != nil {
		info.Latest = rel.version()
		info.Name = rel.Name
		info.Notes = rel.Body
		info.URL = rel.HTMLURL
		if !rel.PublishedAt.IsZero() {
			info.PublishedAt = rel.PublishedAt.Format(time.RFC3339)
		}
		info.Asset, info.AssetURL = pickAsset(rel, manifest.Id)
		info.UpdateAvailable = newerThan(info.Latest, manifest.Version) && info.Asset != ""
	}
	writeJSON(w, http.StatusOK, info)
}

// runUpdateCheck is a background job that tells system admins once about
// every new release.
func (p *Plugin) runUpdateCheck() {
	if !p.getConfiguration().notifyAdminsAboutUpdates() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rel, err := p.latestRelease(ctx, true)
	if err != nil || rel == nil || !newerThan(rel.version(), manifest.Version) {
		return
	}
	var notified string
	_ = p.client.KV.Get(updateNotifiedKey, &notified)
	if notified == rel.version() {
		return
	}
	if _, err := p.client.KV.Set(updateNotifiedKey, rel.version()); err != nil {
		return
	}
	message := fmt.Sprintf("#### :package: Доступна новая версия плагина «Почта»: %s\nУстановлена версия %s.\n", rel.version(), manifest.Version)
	if notes := strings.TrimSpace(rel.Body); notes != "" {
		if runes := []rune(notes); len(runes) > 1200 {
			notes = string(runes[:1200]) + "…"
		}
		message += "\n" + notes + "\n"
	}
	if name, url := pickAsset(rel, manifest.Id); url != "" {
		message += fmt.Sprintf("\nСкачайте [%s](%s) и загрузите его: **Системная консоль → Плагины → Управление плагинами → «Загрузить плагин»**, на вопрос о замене ответьте «Перезаписать». Подключённые ящики и настройки пользователей сохранятся.", escape(name), safeLink(url))
	} else if rel.HTMLURL != "" {
		message += "\nФайл плагина — на странице релиза: " + safeLink(rel.HTMLURL)
	}
	for page := range 10 {
		admins, appErr := p.API.GetUsers(&model.UserGetOptions{Role: model.SystemAdminRoleId, Page: page, PerPage: 100, Inactive: false})
		if appErr != nil || len(admins) == 0 {
			break
		}
		for _, admin := range admins {
			if !admin.IsBot && admin.DeleteAt == 0 {
				p.sendDM(admin.Id, message)
			}
		}
	}
}
