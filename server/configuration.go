package main

import (
	"reflect"
	"strings"

	"github.com/pkg/errors"

	"github.com/FLEXIY0/M-mail-/server/secret"
)

// configuration captures the plugin's external configuration as exposed in the Mattermost server
// configuration, as well as values computed from the configuration. Any public fields will be
// deserialized from the Mattermost server configuration in OnConfigurationChange.
//
// As plugins are inherently concurrent (hooks being called asynchronously), and the plugin
// configuration can change at any time, access to the configuration must be synchronized. The
// strategy used in this plugin is to guard a pointer to the configuration, and clone the entire
// struct whenever it changes.
type configuration struct {
	EnableVKWorkSpace     bool
	VKWorkSpaceIMAPServer string
	VKWorkSpaceSMTPServer string
	VKWorkSpaceWebURL     string

	EnableMailRu bool
	EnableYandex bool

	EnableCustom     bool
	CustomIMAPServer string
	CustomSMTPServer string
	CustomWebURL     string

	AllowPrivateNetworks bool
	DefaultProvider      string
	CheckIntervalMinutes int
	MaxAttachmentMB      int
	HelpText             string
	// RequireSignature is a pointer so that "never saved" means the
	// default (required), not false.
	RequireSignature *bool
	EncryptionKey    string

	// UpdateSource is "owner/repo" on GitHub (or a release API URL).
	UpdateSource string
	// NotifyAdminsAboutUpdates is a pointer so that "never saved" means
	// the default (on), not false.
	NotifyAdminsAboutUpdates *bool
}

func (c *configuration) requireSignature() bool {
	return c.RequireSignature == nil || *c.RequireSignature
}

func (c *configuration) notifyAdminsAboutUpdates() bool {
	return c.NotifyAdminsAboutUpdates == nil || *c.NotifyAdminsAboutUpdates
}

// Clone shallow copies the configuration.
func (c *configuration) Clone() *configuration {
	clone := *c
	return &clone
}

// checkIntervalMinutes never goes below one minute, to be polite to the providers.
func (c *configuration) checkIntervalMinutes() int {
	if c.CheckIntervalMinutes < 1 {
		return 1
	}
	return c.CheckIntervalMinutes
}

const (
	defaultMaxAttachmentMB = 25
	// hardMaxAttachmentMB: providers reject bigger messages anyway, and the
	// whole message is kept in memory while it is sent.
	hardMaxAttachmentMB = 50
)

// maxAttachmentBytes limits the total size of files attached to one message.
func (c *configuration) maxAttachmentBytes() int64 {
	mb := c.MaxAttachmentMB
	if mb <= 0 {
		mb = defaultMaxAttachmentMB
	}
	if mb > hardMaxAttachmentMB {
		mb = hardMaxAttachmentMB
	}
	return int64(mb) << 20
}

// defaultHelpText is shown at the bottom of the wizard when the
// administrator did not write their own.
const defaultHelpText = "Если что-то не получается — напишите в канал ~mm-support"

func (c *configuration) helpText() string {
	if text := strings.TrimSpace(c.HelpText); text != "" {
		return text
	}
	return defaultHelpText
}

// getConfiguration retrieves the active configuration under lock, making it safe to use
// concurrently. The active configuration may change underneath the client of this method, but
// the struct returned by this API call is considered immutable.
func (p *Plugin) getConfiguration() *configuration {
	p.configurationLock.RLock()
	defer p.configurationLock.RUnlock()

	if p.configuration == nil {
		return &configuration{}
	}

	return p.configuration
}

// setConfiguration replaces the active configuration under lock.
//
// Do not call setConfiguration while holding the configurationLock, as sync.Mutex is not
// reentrant. In particular, avoid using the plugin API entirely, as this may in turn trigger a
// hook back into the plugin. If that hook attempts to acquire this lock, a deadlock may occur.
//
// This method panics if setConfiguration is called with the existing configuration. This almost
// certainly means that the configuration was modified without being cloned and may result in
// an unsafe access.
func (p *Plugin) setConfiguration(configuration *configuration) {
	p.configurationLock.Lock()
	defer p.configurationLock.Unlock()

	if configuration != nil && p.configuration == configuration {
		// Ignore assignment if the configuration struct is empty. Go will optimize the
		// allocation for same to point at the same memory address, breaking the check
		// above.
		if reflect.ValueOf(*configuration).NumField() == 0 {
			return
		}

		panic("setConfiguration called with the existing configuration")
	}

	p.configuration = configuration
}

// OnConfigurationChange is invoked when configuration changes may have been made.
func (p *Plugin) OnConfigurationChange() error {
	configuration := new(configuration)

	// Load the public configuration fields from the Mattermost server configuration.
	if err := p.API.LoadPluginConfiguration(configuration); err != nil {
		return errors.Wrap(err, "failed to load plugin configuration")
	}

	p.setConfiguration(configuration)

	if configuration.EncryptionKey != "" {
		box, err := secret.New(configuration.EncryptionKey)
		if err != nil {
			return errors.Wrap(err, "invalid encryption key")
		}
		p.boxLock.Lock()
		p.box = box
		p.boxLock.Unlock()
	}

	// Server addresses may have changed: drop open connections, they are
	// re-established with the new settings on the next request.
	if p.sessions != nil {
		p.sessions.closeAll()
	}
	return nil
}

// ensureEncryptionKey generates the encryption key on first start, so that
// administrators do not have to do anything before users can connect.
func (p *Plugin) ensureEncryptionKey() error {
	if p.getConfiguration().EncryptionKey != "" {
		return nil
	}
	key, err := secret.NewKey()
	if err != nil {
		return errors.Wrap(err, "failed to generate encryption key")
	}
	cfg := p.API.GetPluginConfig()
	if cfg == nil {
		cfg = map[string]any{}
	}
	// The System Console reads and writes plugin settings by lower-cased
	// keys. Saving "EncryptionKey" would show an empty field there, and a
	// later "Save" could store an empty key next to the real one.
	for k := range cfg {
		if strings.EqualFold(k, "EncryptionKey") {
			delete(cfg, k)
		}
	}
	cfg["encryptionkey"] = key
	if appErr := p.API.SavePluginConfig(cfg); appErr != nil {
		return errors.Wrap(appErr, "failed to save encryption key")
	}
	// SavePluginConfig triggers OnConfigurationChange asynchronously on some
	// server versions; load the key right away so activation can continue.
	updated := p.getConfiguration().Clone()
	updated.EncryptionKey = key
	p.setConfiguration(updated)
	box, err := secret.New(key)
	if err != nil {
		return err
	}
	p.boxLock.Lock()
	p.box = box
	p.boxLock.Unlock()
	return nil
}

func (p *Plugin) getBox() (*secret.Box, error) {
	p.boxLock.RLock()
	defer p.boxLock.RUnlock()
	if p.box == nil {
		return nil, errors.New("encryption key is not configured")
	}
	return p.box, nil
}
