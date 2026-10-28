package main

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
)

const (
	checkWorkers      = 8
	checkUserTimeout  = 60 * time.Second
	maxNotifications  = 5
	maxPreviewRunes   = 300
	notificationColor = "#005ff9"
	checkSoonInterval = 15 * time.Second

	wsMailUpdated   = "mail_updated"
	wsOpenWizard    = "open_wizard"
	wsOpenPanel     = "open_panel"
	wsOpenCompose   = "open_compose"
	wsOpenMessage   = "open_message"
	wsConfigChanged = "config_changed"
)

var userLocks sync.Map

func userLock(userID string) *sync.Mutex {
	lock, _ := userLocks.LoadOrStore(userID, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

// runCheck is the background job: it looks for new mail in Inbox of every
// connected user whose last check is older than the configured interval.
func (p *Plugin) runCheck() {
	users, err := p.store.ListConnectedUsers()
	if err != nil {
		p.API.LogError("Failed to list connected users", "err", err.Error())
		return
	}
	interval := time.Duration(p.getConfiguration().checkIntervalMinutes()) * time.Minute
	queue := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < checkWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for userID := range queue {
				ctx, cancel := context.WithTimeout(context.Background(), checkUserTimeout)
				if err := p.checkUser(ctx, userID, false); err != nil {
					p.API.LogDebug("Mail check failed", "user_id", userID, "err", err.Error())
				}
				cancel()
			}
		}()
	}
	for _, userID := range users {
		state, stateErr := p.store.GetSyncState(userID)
		if stateErr != nil || state.AuthFailed {
			continue
		}
		// A few seconds of slack, so that a one minute interval does not
		// skip every other run.
		if time.Since(state.LastAttempt) < interval-10*time.Second {
			continue
		}
		queue <- userID
	}
	close(queue)
	wg.Wait()
}

// checkLater runs a check in the background, merging concurrent requests.
func (p *Plugin) checkLater(userID string) {
	if _, busy := p.checking.LoadOrStore(userID, true); busy {
		return
	}
	go func() {
		defer p.checking.Delete(userID)
		ctx, cancel := context.WithTimeout(context.Background(), checkUserTimeout)
		defer cancel()
		if err := p.checkUser(ctx, userID, false); err != nil {
			p.API.LogDebug("Mail check failed", "user_id", userID, "err", err.Error())
		}
	}()
}

// checkSoon checks Inbox when the user looks at it, so that sorting rules
// and counters do not wait for the next background run.
func (p *Plugin) checkSoon(userID string) {
	state, err := p.store.GetSyncState(userID)
	if err != nil || state.AuthFailed || time.Since(state.LastAttempt) < checkSoonInterval {
		return
	}
	p.checkLater(userID)
}

// checkUser asks the server for the Inbox counters and notifies the user
// about messages that arrived since the previous check. manual checks also
// retry after an authentication failure.
func (p *Plugin) checkUser(ctx context.Context, userID string, manual bool) error {
	lock := userLock(userID)
	lock.Lock()
	defer lock.Unlock()

	account, err := p.store.GetAccount(userID)
	if err != nil || account == nil {
		return err
	}
	state, err := p.store.GetSyncState(userID)
	if err != nil {
		return err
	}
	if state.AuthFailed && !manual {
		return nil
	}
	previousUnseen := state.Unseen
	state.LastAttempt = time.Now()

	rules, err := p.store.GetRules(userID)
	if err != nil {
		return err
	}
	rulesBefore := slices.Clone(rules)

	var status *mailclient.InboxStatus
	var fresh []mailclient.Summary
	var sorted int
	previews := map[uint32]string{}
	keep := manual || p.sessions.has(userID)
	err = p.withIMAP(ctx, userID, account, keep, func(conn *mailclient.IMAP) error {
		var err error
		status, err = conn.Status(ctx, "INBOX")
		if err != nil {
			return err
		}
		baseline := state.UIDNext == 0 || state.UIDValidity != status.UIDValidity
		if baseline || status.UIDNext <= state.UIDNext {
			return nil
		}

		// Sorting rules go first: a message moved to its folder does not
		// trigger a notification, a copied one stays in Inbox and does.
		if len(rules) > 0 {
			senders, err := conn.SendersSince(ctx, "INBOX", state.UIDNext, maxRuleBatch)
			if err != nil {
				return err
			}
			var moved int
			moved, sorted = applyRules(ctx, conn, rules, senders)
			if moved > 0 {
				if status, err = conn.Status(ctx, "INBOX"); err != nil {
					return err
				}
			}
		}
		if !account.Settings.NotifyNew {
			return nil
		}
		fresh, err = conn.NewSince(ctx, "INBOX", state.UIDNext, maxNotifications+1)
		if err != nil {
			return err
		}
		if account.Settings.NotifyPreview {
			for i, s := range fresh {
				if i >= maxNotifications {
					break
				}
				if msg, getErr := conn.Get(ctx, "INBOX", s.UID, false); getErr == nil {
					previews[s.UID] = msg.Text
				}
			}
		}
		return nil
	})
	if err != nil {
		state.ErrorCode = errorCode(err)
		state.ErrorText = err.Error()
		if mailclient.IsAuth(err) {
			state.AuthFailed = true
		}
		notify := state.AuthFailed && !state.AuthFailedNotified
		if notify {
			state.AuthFailedNotified = true
		}
		if saveErr := p.store.SaveSyncState(userID, state); saveErr != nil {
			return saveErr
		}
		if notify {
			p.notifyAuthFailed(userID, state.ErrorCode)
		}
		p.publish(userID, wsMailUpdated, nil)
		return err
	}

	state.LastSuccess = time.Now()
	state.ErrorCode, state.ErrorText = "", ""
	state.AuthFailed, state.AuthFailedNotified = false, false
	state.UIDValidity = status.UIDValidity
	state.UIDNext = status.UIDNext
	state.Unseen = status.Unseen
	state.Total = status.Total
	if err = p.store.SaveSyncState(userID, state); err != nil {
		return err
	}
	if !slices.Equal(rules, rulesBefore) {
		// Counters and errors of the rules changed.
		if err = p.store.SaveRules(userID, rules); err != nil {
			return err
		}
	}
	if len(fresh) > 0 {
		p.notifyNewMail(userID, fresh, previews)
	}
	if len(fresh) > 0 || sorted > 0 || previousUnseen != state.Unseen || manual {
		p.publish(userID, wsMailUpdated, map[string]any{"unseen": state.Unseen, "new": len(fresh)})
	}
	return nil
}

// markAuthFailed stops background checks after the server rejected the
// stored password, and tells the user once.
func (p *Plugin) markAuthFailed(userID string, cause error) {
	state, err := p.store.GetSyncState(userID)
	if err != nil {
		return
	}
	notify := !state.AuthFailedNotified
	state.AuthFailed = true
	state.AuthFailedNotified = true
	state.ErrorCode = errorCode(cause)
	state.ErrorText = cause.Error()
	if err = p.store.SaveSyncState(userID, state); err != nil {
		return
	}
	if notify {
		p.notifyAuthFailed(userID, state.ErrorCode)
	}
	p.publish(userID, wsMailUpdated, nil)
}

// authWorks resumes background checks after the server accepted the
// stored password again: the earlier rejection may have been a hiccup of
// the server, not a revoked password.
func (p *Plugin) authWorks(userID string) {
	state, err := p.store.GetSyncState(userID)
	if err != nil || !state.AuthFailed {
		return
	}
	notified := state.AuthFailedNotified
	state.AuthFailed, state.AuthFailedNotified = false, false
	state.ErrorCode, state.ErrorText = "", ""
	if err = p.store.SaveSyncState(userID, state); err != nil {
		return
	}
	if notified {
		p.sendDM(userID, ":white_check_mark: Почта снова пускает плагин — проверяю новые письма, как раньше.")
	}
	p.publish(userID, wsMailUpdated, nil)
}

func (p *Plugin) notifyAuthFailed(userID, code string) {
	p.sendDM(userID, "#### :warning: Почта перестала пускать плагин\n"+messageFor(code)+
		"\n\nЧтобы аккаунт не заблокировали за неверный пароль, я больше не проверяю почту. "+
		"Создайте новый пароль для внешнего приложения и подключите почту заново: `/mail connect`.")
}

func previewText(text string) string {
	lines := strings.Fields(strings.ReplaceAll(text, " ", " "))
	preview := strings.Join(lines, " ")
	if utf8.RuneCountInString(preview) > maxPreviewRunes {
		preview = string([]rune(preview)[:maxPreviewRunes]) + "…"
	}
	return preview
}

func senderLine(list []mailclient.Address) string {
	if len(list) == 0 {
		return "(без отправителя)"
	}
	a := list[0]
	if a.Name != "" {
		return a.Name + " <" + a.Email + ">"
	}
	return a.Email
}

func (p *Plugin) actionURL(action string) string {
	return "/plugins/" + manifest.Id + "/api/v1/actions/" + action
}

// notifyNewMail sends one direct message per new message (up to a limit),
// with buttons to open it in the panel or mark it as read.
func (p *Plugin) notifyNewMail(userID string, fresh []mailclient.Summary, previews map[uint32]string) {
	shown := fresh
	if len(shown) > maxNotifications {
		shown = shown[:maxNotifications]
	}
	// Oldest first, so that the newest message ends up at the bottom.
	for i := len(shown) - 1; i >= 0; i-- {
		s := shown[i]
		subject := s.Subject
		if strings.TrimSpace(subject) == "" {
			subject = "(без темы)"
		}
		actionContext := map[string]any{"folder": "INBOX", "uid": s.UID, "user_id": userID}
		attachment := &model.SlackAttachment{
			Fallback:   "Новое письмо: " + subject,
			Color:      notificationColor,
			AuthorName: senderLine(s.From),
			Title:      subject,
			Text:       escapeAttachmentText(previewText(previews[s.UID])),
			Actions: []*model.PostAction{
				{Id: "open", Name: "Открыть", Type: model.PostActionTypeButton, Style: "primary", Integration: &model.PostActionIntegration{URL: p.actionURL("open"), Context: actionContext}},
				{Id: "read", Name: "Прочитано", Type: model.PostActionTypeButton, Integration: &model.PostActionIntegration{URL: p.actionURL("read"), Context: actionContext}},
			},
		}
		if s.HasAttachments {
			attachment.Footer = ":paperclip: есть вложения"
		}
		post := &model.Post{Message: ""}
		model.ParseSlackAttachment(post, []*model.SlackAttachment{attachment})
		p.sendDMPost(userID, post)
	}
	if extra := len(fresh) - len(shown); extra > 0 {
		p.sendDM(userID, ":envelope_with_arrow: Пришли и другие письма — откройте почту на правой панели или `/mail inbox`.")
	}
}

// escapeAttachmentText keeps a preview from turning into mentions or
// Markdown links.
func escapeAttachmentText(s string) string {
	s = strings.ReplaceAll(s, "@", "@\u200b")
	return markdownEscaper.Replace(s)
}

// markNotificationRead replaces the buttons of a notification with a note.
func markNotificationRead(post *model.Post) {
	attachments := post.Attachments()
	for _, a := range attachments {
		a.Actions = nil
		a.Color = "#9ca3af"
		if a.Footer != "" {
			a.Footer += " · "
		}
		a.Footer += "✓ прочитано"
	}
	model.ParseSlackAttachment(post, attachments)
}
