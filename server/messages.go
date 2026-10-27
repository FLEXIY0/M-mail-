package main

import (
	"errors"
	"net/url"
	"strings"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/secret"
)

// Additional error codes that do not come from the mail client.
const (
	codeRateLimited      = "rate_limited"
	codeProviderDisabled = "provider_disabled"
	codeNotConnected     = "not_connected"
	codeReconnect        = "reconnect"
	codeBadRequest       = "bad_request"
	codeInternal         = "internal"
	codeInvalidWebURL    = "invalid_web_url"
	codeInvalidMessage   = "invalid_message"
	codeAttachmentsLarge = "attachments_too_large"
)

// errorMessages are shown to users in bot messages and command responses.
// The webapp has richer, provider specific texts for the same codes.
var errorMessages = map[string]string{
	string(mailclient.CodeUnauthorized):   "Не подошёл логин или пароль. Проверьте, что вы ввели полный адрес почты и именно пароль для внешнего приложения, а не обычный пароль от почты.",
	string(mailclient.CodeDisabled):       "Сервер не разрешает вход из почтовых программ. Включите доступ по IMAP в настройках почты или попросите администратора.",
	string(mailclient.CodeNetwork):        "Не удалось связаться с почтовым сервером. Проверьте адрес или попробуйте позже.",
	string(mailclient.CodeTimeout):        "Почтовый сервер слишком долго не отвечает. Попробуйте ещё раз чуть позже.",
	string(mailclient.CodeTLS):            "Не удалось установить защищённое соединение с почтовым сервером. Проверьте порт и тип шифрования.",
	string(mailclient.CodeServer):         "Почтовый сервер вернул ошибку. Попробуйте позже.",
	string(mailclient.CodeInvalidServer):  "Адрес сервера указан неверно. Пример: imap.example.com, порт 993.",
	string(mailclient.CodeBlockedAddress): "Этот адрес находится во внутренней сети, а подключение к таким адресам запрещено администратором.",
	string(mailclient.CodeNotFound):       "Письмо или папка не найдены — возможно, их уже удалили или переместили.",
	string(mailclient.CodeRejected):       "Сервер отказался отправить письмо. Проверьте адреса получателей.",
	string(mailclient.CodeTooLarge):       "Письмо слишком большое для почтового сервера.",
	string(mailclient.CodeUnknown):        "Не удалось выполнить действие с почтой.",
	codeRateLimited:                       "Слишком много попыток подряд. Подождите немного и попробуйте снова.",
	codeProviderDisabled:                  "Этот сервис отключён администратором.",
	codeNotConnected:                      "Почта ещё не подключена.",
	codeReconnect:                         "Нужно заново подключить почту: сохранённый пароль больше не читается (администратор сменил ключ шифрования).",
	codeBadRequest:                        "Некорректный запрос.",
	codeInternal:                          "Внутренняя ошибка плагина. Подробности — в логах сервера Mattermost.",
	codeInvalidWebURL:                     "Адрес сайта почты должен начинаться с https:// или http://.",
	codeInvalidMessage:                    "Проверьте письмо.",
	codeAttachmentsLarge:                  "Вложения слишком большие.",
}

func messageFor(code string) string {
	if msg, ok := errorMessages[code]; ok {
		return msg
	}
	return errorMessages[string(mailclient.CodeUnknown)]
}

// errorCode maps any error from the plugin internals to a stable code.
func errorCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errProviderDisabled):
		return codeProviderDisabled
	case errors.Is(err, secret.ErrDecrypt):
		return codeReconnect
	}
	var merr *mailclient.Error
	if errors.As(err, &merr) {
		return string(merr.Code)
	}
	return string(mailclient.CodeUnknown)
}

var markdownEscaper = strings.NewReplacer(
	`\`, `\\`, "*", `\*`, "_", `\_`, "~", `\~`, "`", "\\`",
	"[", `\[`, "]", `\]`, "|", `\|`, "<", `\<`, ">", `\>`, "#", `\#`,
)

// escape makes user supplied text safe to embed into Markdown.
func escape(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	return markdownEscaper.Replace(s)
}

func safeLink(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return strings.NewReplacer("(", "%28", ")", "%29", " ", "%20").Replace(u.String())
}
