package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
)

const commandTrigger = "mail"

const helpText = `#### :email: Почта — справка
Почта открывается иконкой на **правой панели** Mattermost. Там же — настройки и переподключение.

| Команда | Что делает |
|---|---|
| ` + "`/mail`" + ` | открыть почту на правой панели |
| ` + "`/mail new [адрес]`" + ` | написать письмо |
| ` + "`/mail inbox`" + ` | непрочитанные письма во «Входящих» (работает и на телефоне) |
| ` + "`/mail web`" + ` | ссылка на почту в браузере |
| ` + "`/mail connect`" + ` | подключить почту (мастер по шагам) |
| ` + "`/mail sync`" + ` | проверить почту сейчас |
| ` + "`/mail settings`" + ` | уведомления, подпись, имя отправителя |
| ` + "`/mail disconnect`" + ` | отключить почту и удалить сохранённые данные |

Любое сообщение можно отправить по почте: **«Действия» (⋯) → «Отправить по почте»**.

Поддерживаются VK WorkSpace, Почта Mail.ru, Яндекс Почта и любые IMAP/SMTP-серверы.`

func (p *Plugin) command() *model.Command {
	autocomplete := model.NewAutocompleteData(commandTrigger, "[команда]", "Почта: входящие, новое письмо, настройки")
	for _, sub := range []struct{ name, hint, help string }{
		{"new", "[адрес]", "Написать письмо"},
		{"inbox", "", "Непрочитанные письма во «Входящих»"},
		{"web", "", "Ссылка на почту в браузере"},
		{"connect", "", "Подключить почту"},
		{"sync", "", "Проверить почту сейчас"},
		{"settings", "", "Настройки почты и уведомлений"},
		{"disconnect", "", "Отключить почту"},
		{"help", "", "Справка"},
	} {
		autocomplete.AddCommand(model.NewAutocompleteData(sub.name, sub.hint, sub.help))
	}
	return &model.Command{
		Trigger:          commandTrigger,
		DisplayName:      "Почта",
		Description:      "VK WorkSpace / Mail.ru / Яндекс / IMAP почта в Mattermost",
		AutoComplete:     true,
		AutoCompleteDesc: "new, inbox, web, connect, settings, sync, disconnect, help",
		AutoCompleteHint: "[команда]",
		AutocompleteData: autocomplete,
	}
}

func ephemeral(text string) *model.CommandResponse {
	return &model.CommandResponse{ResponseType: model.CommandResponseTypeEphemeral, Text: text}
}

// ExecuteCommand handles /mail.
func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *model.CommandArgs) (*model.CommandResponse, *model.AppError) {
	fields := strings.Fields(args.Command)
	action := ""
	if len(fields) > 1 {
		action = strings.ToLower(fields[1])
	}
	userID := args.UserId

	switch action {
	case "", "open", "panel":
		p.publish(userID, wsOpenPanel, nil)
		return ephemeral("Открываю почту на правой панели. В мобильном приложении панели нет — используйте `/mail inbox`."), nil
	case "help":
		return ephemeral(helpText), nil
	case "connect", "reconnect":
		p.publish(userID, wsOpenWizard, map[string]any{"mode": "connect"})
		return ephemeral("Открываю мастер подключения почты. Если окно не появилось (например, на телефоне), откройте Mattermost на компьютере или в браузере."), nil
	case "settings":
		p.publish(userID, wsOpenWizard, map[string]any{"mode": "settings"})
		return ephemeral("Открываю настройки почты."), nil
	case "web", "site", "browser":
		return p.webResponse(userID), nil
	}

	account, err := p.store.GetAccount(userID)
	if err != nil {
		return ephemeral(messageFor(codeInternal)), nil
	}
	if account == nil {
		p.publish(userID, wsOpenWizard, map[string]any{"mode": "connect"})
		return ephemeral("Почта ещё не подключена. Открываю мастер подключения — или нажмите иконку почты на правой панели."), nil
	}

	switch action {
	case "new", "write", "compose":
		to := ""
		if len(fields) > 2 && looksLikeEmail(fields[2]) {
			to = fields[2]
		}
		p.publish(userID, wsOpenCompose, map[string]any{"to": to})
		return ephemeral("Открываю новое письмо."), nil
	case "inbox", "unread":
		return p.inboxResponse(userID), nil
	case "sync", "check", "refresh":
		ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
		defer cancel()
		if err := p.checkUser(ctx, userID, true); err != nil {
			return ephemeral(":warning: " + messageFor(errorCode(err))), nil
		}
		state, _ := p.store.GetSyncState(userID)
		if state != nil && state.Unseen > 0 {
			return ephemeral(fmt.Sprintf(":white_check_mark: Почта проверена. Непрочитанных во «Входящих»: %d.", state.Unseen)), nil
		}
		return ephemeral(":white_check_mark: Почта проверена. Непрочитанных писем нет."), nil
	case "disconnect", "logout":
		if err := p.disconnect(userID); err != nil {
			return ephemeral(messageFor(codeInternal)), nil
		}
		return ephemeral("Почта отключена, пароль приложения удалён с сервера Mattermost. Сам пароль можно отозвать в настройках безопасности почты."), nil
	}
	return ephemeral("Неизвестная команда. " + "Справка: `/mail help`."), nil
}

func (p *Plugin) webResponse(userID string) *model.CommandResponse {
	account, _ := p.store.GetAccount(userID)
	prefs, _ := p.store.GetPreferences(userID)
	info := p.iconInfoFor(prefs, account, p.userEmail(userID))
	if link := safeLink(info.WebURL); link != "" {
		return ephemeral(fmt.Sprintf(":globe_with_meridians: [Открыть почту в браузере](%s)", link))
	}
	return ephemeral("Адрес веб-почты не настроен.")
}

// inboxResponse lists unread messages in Inbox; it is the mobile
// alternative to the panel.
func (p *Plugin) inboxResponse(userID string) *model.CommandResponse {
	account, err := p.store.GetAccount(userID)
	if err != nil || account == nil {
		return ephemeral(messageFor(codeNotConnected))
	}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	var page *mailclient.Page
	err = p.withIMAP(ctx, userID, account, false, func(conn *mailclient.IMAP) error {
		var err error
		page, err = conn.List(ctx, "INBOX", 0, 30)
		return err
	})
	if err != nil {
		return ephemeral(":warning: " + messageFor(errorCode(err)))
	}
	var lines []string
	for _, s := range page.Messages {
		if s.Seen {
			continue
		}
		subject := s.Subject
		if strings.TrimSpace(subject) == "" {
			subject = "(без темы)"
		}
		line := fmt.Sprintf("- **%s** — %s · %s", escape(subject), escape(senderLine(s.From)), s.Date.Format("02.01 15:04"))
		if s.HasAttachments {
			line += " :paperclip:"
		}
		lines = append(lines, line)
		if len(lines) == 10 {
			break
		}
	}
	if len(lines) == 0 {
		return ephemeral(":white_check_mark: Во «Входящих» нет непрочитанных писем.")
	}
	header := fmt.Sprintf("#### :inbox_tray: Непрочитанные во «Входящих»: %d\n", page.Unseen)
	return ephemeral(header + strings.Join(lines, "\n") + "\n\nЧитать и отвечать — на правой панели (иконка почты).")
}
