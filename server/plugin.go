package main

import (
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/pluginapi"
	"github.com/mattermost/mattermost/server/public/pluginapi/cluster"
	"github.com/pkg/errors"

	"github.com/FLEXIY0/M-mail-/server/secret"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	botUsername    = "mail"
	botDisplayName = "Почта"
)

// Plugin implements the interface expected by the Mattermost server to communicate between the server and plugin processes.
type Plugin struct {
	plugin.MattermostPlugin

	client *pluginapi.Client
	store  *store.Store
	router *mux.Router
	botID  string

	checkJob  *cluster.Job
	updateJob *cluster.Job
	updater   *updater

	sessions  *sessionPool
	directory *userDirectory
	limiter   *rateLimiter
	// sendLimiter keeps a hijacked session from turning the plugin into a
	// spam relay.
	sendLimiter *rateLimiter

	// checking holds users whose background check is waiting or running.
	checking sync.Map

	// configurationLock synchronizes access to the configuration.
	configurationLock sync.RWMutex

	// configuration is the active plugin configuration. Consult getConfiguration and
	// setConfiguration for usage.
	configuration *configuration

	boxLock sync.RWMutex
	box     *secret.Box
}

// OnActivate is invoked when the plugin is activated. If an error is returned, the plugin will be deactivated.
func (p *Plugin) OnActivate() error {
	p.client = pluginapi.NewClient(p.API, p.Driver)
	p.store = store.New(&p.client.KV)
	p.limiter = newRateLimiter(10, 10*time.Minute)
	p.sendLimiter = newRateLimiter(60, time.Hour)
	p.sessions = newSessionPool(sessionIdleTimeout)
	p.directory = newUserDirectory()
	p.updater = newUpdater()

	if err := p.ensureEncryptionKey(); err != nil {
		return err
	}

	botID, err := p.ensureBot()
	if err != nil {
		return err
	}
	p.botID = botID

	if err = p.API.RegisterCommand(p.command()); err != nil {
		return errors.Wrap(err, "failed to register the /mail command")
	}

	p.router = p.initRouter()

	// The background check only asks the server for Inbox counters, so it
	// is cheap enough to run every minute for every user.
	p.checkJob, err = cluster.Schedule(p.API, "MailCheck", cluster.MakeWaitForInterval(time.Minute), p.runCheck)
	if err != nil {
		return errors.Wrap(err, "failed to schedule the mail check")
	}
	p.updateJob, err = cluster.Schedule(p.API, "MailUpdateCheck", cluster.MakeWaitForInterval(12*time.Hour), p.runUpdateCheck)
	if err != nil {
		return errors.Wrap(err, "failed to schedule the update check")
	}
	return nil
}

// OnDeactivate is invoked when the plugin is deactivated.
func (p *Plugin) OnDeactivate() error {
	for _, job := range []*cluster.Job{p.checkJob, p.updateJob} {
		if job == nil {
			continue
		}
		if err := job.Close(); err != nil {
			p.API.LogError("Failed to close background job", "err", err.Error())
		}
	}
	if p.sessions != nil {
		p.sessions.shutdown()
	}
	return nil
}

func (p *Plugin) ensureBot() (string, error) {
	options := []pluginapi.EnsureBotOption{}
	if bundlePath, err := p.API.GetBundlePath(); err == nil {
		iconPath := filepath.Join(bundlePath, "assets", "bot-icon.png")
		if _, statErr := os.Stat(iconPath); statErr == nil {
			options = append(options, pluginapi.ProfileImagePath("assets/bot-icon.png"))
		}
	}
	botID, err := p.client.Bot.EnsureBot(&model.Bot{
		Username:    botUsername,
		DisplayName: botDisplayName,
		Description: "Уведомления о новых письмах из вашей почты (Mail.ru, VK WorkSpace, Яндекс, IMAP).",
	}, options...)
	if err != nil {
		return "", errors.Wrap(err, "failed to ensure the mail bot")
	}
	return botID, nil
}

// ServeHTTP handles the plugin's REST API used by the webapp.
func (p *Plugin) ServeHTTP(c *plugin.Context, w http.ResponseWriter, r *http.Request) {
	p.router.ServeHTTP(w, r)
}

// sendDM posts a message from the bot to the user and returns the post id,
// or "" when the message could not be sent.
func (p *Plugin) sendDM(userID, message string) string {
	return p.sendDMPost(userID, &model.Post{Message: message})
}

func (p *Plugin) sendDMPost(userID string, post *model.Post) string {
	if err := p.client.Post.DM(p.botID, userID, post); err != nil {
		p.API.LogWarn("Failed to send a direct message", "user_id", userID, "err", err.Error())
		return ""
	}
	return post.Id
}

// publish notifies the user's open webapp sessions.
func (p *Plugin) publish(userID, event string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	p.API.PublishWebSocketEvent(event, payload, &model.WebsocketBroadcast{UserId: userID})
}
