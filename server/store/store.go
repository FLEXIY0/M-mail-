// Package store keeps the plugin data in the Mattermost key-value store.
//
// Data is split into records per user so that the API and the background
// check never overwrite each other's fields:
//
//	u:<user id>  Account     – connection and settings, written by the API
//	s:<user id>  SyncState   – result of the last background check
//	p:<user id>  Preferences – choices that survive "disconnect"
//	r:<user id>  Rules       – sorting of new mail into folders
package store

import (
	"strings"
	"time"

	"github.com/mattermost/mattermost/server/public/pluginapi"
	"github.com/pkg/errors"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
)

const (
	accountPrefix = "u:"
	syncPrefix    = "s:"
	prefsPrefix   = "p:"
	imagePrefix   = "i:"
	logoPrefix    = "l:"
	rulesPrefix   = "r:"
	listPageSize  = 1000
)

// Settings are the user's preferences for a connected mailbox.
type Settings struct {
	// NotifyNew sends a direct message from the bot about new mail in Inbox.
	NotifyNew bool `json:"notify_new"`
	// NotifyPreview adds the first lines of the message to the notification.
	NotifyPreview bool `json:"notify_preview"`
	// MarkReadOnOpen marks a message as read when it is opened in the panel.
	MarkReadOnOpen bool `json:"mark_read_on_open"`
	// LoadImages shows remote images in HTML mail without asking. Off by
	// default: images from the internet tell the sender the mail was read.
	LoadImages bool `json:"load_images"`
	// Signature is appended to new messages and replies.
	Signature string `json:"signature"`
	// SignatureImage tells that a photo or logo is stored for the
	// signature (see GetSignatureImage); SignatureLayout places it "left"
	// of the text or "above" it.
	SignatureImage  bool   `json:"signature_image"`
	SignatureLayout string `json:"signature_layout,omitempty"`
	// SignatureHTML is the signature with formatting (colour, bold, links),
	// sanitized; Signature then holds its plain text version.
	SignatureHTML string `json:"signature_html,omitempty"`
	// SignatureLogo tells that a company logo is stored; it goes under the
	// text, SignatureLogoHeight pixels high.
	SignatureLogo       bool `json:"signature_logo"`
	SignatureLogoHeight int  `json:"signature_logo_height,omitempty"`
}

// SignatureImage is the picture of the signature, kept apart from the
// account so that ordinary requests do not load it.
type SignatureImage struct {
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

// DefaultSettings are chosen so that a user who just clicks "Next" gets a
// useful, not noisy, setup.
func DefaultSettings() Settings {
	return Settings{
		NotifyNew:      true,
		NotifyPreview:  true,
		MarkReadOnOpen: true,
	}
}

// Account is a connected mailbox.
type Account struct {
	Provider          string              `json:"provider"`
	IMAP              mailclient.Endpoint `json:"imap"`
	SMTP              mailclient.Endpoint `json:"smtp"`
	Username          string              `json:"username"`
	PasswordEncrypted string              `json:"password"`
	// Email is the sender address, usually the same as Username.
	Email string `json:"email"`
	// DisplayName is the sender name shown to recipients.
	DisplayName string    `json:"display_name"`
	Settings    Settings  `json:"settings"`
	ConnectedAt time.Time `json:"connected_at"`
}

// SyncState is the result of the last background check of Inbox.
type SyncState struct {
	LastAttempt time.Time `json:"last_attempt"`
	LastSuccess time.Time `json:"last_success"`
	ErrorCode   string    `json:"error_code,omitempty"`
	ErrorText   string    `json:"error_text,omitempty"`
	// AuthFailed stops background checks until the user reconnects, so that
	// a revoked app password does not get the account locked by the provider.
	AuthFailed         bool `json:"auth_failed,omitempty"`
	AuthFailedNotified bool `json:"auth_failed_notified,omitempty"`

	// UIDValidity and UIDNext of Inbox: messages with UID >= UIDNext are new.
	UIDValidity uint32 `json:"uid_validity,omitempty"`
	UIDNext     uint32 `json:"uid_next,omitempty"`
	Unseen      int    `json:"unseen"`
	Total       int    `json:"total"`
}

// Preferences are per-user choices that do not need a connected account.
type Preferences struct {
	// IconAction is "panel", "browser" or "" (panel).
	IconAction string `json:"icon_action,omitempty"`
	// WebURL overrides the address opened in "browser" mode.
	WebURL string `json:"web_url,omitempty"`
}

// Store wraps the KV API.
type Store struct {
	kv *pluginapi.KVService
}

func New(kv *pluginapi.KVService) *Store {
	return &Store{kv: kv}
}

func (s *Store) GetAccount(userID string) (*Account, error) {
	var account Account
	if err := s.kv.Get(accountPrefix+userID, &account); err != nil {
		return nil, errors.Wrap(err, "failed to load account")
	}
	if account.Provider == "" {
		return nil, nil
	}
	return &account, nil
}

func (s *Store) SaveAccount(userID string, account *Account) error {
	_, err := s.kv.Set(accountPrefix+userID, account)
	return errors.Wrap(err, "failed to save account")
}

func (s *Store) GetSyncState(userID string) (*SyncState, error) {
	var state SyncState
	if err := s.kv.Get(syncPrefix+userID, &state); err != nil {
		// The state is disposable: a broken record is rebuilt by the next check.
		return &SyncState{}, nil //nolint:nilerr
	}
	return &state, nil
}

func (s *Store) SaveSyncState(userID string, state *SyncState) error {
	_, err := s.kv.Set(syncPrefix+userID, state)
	return errors.Wrap(err, "failed to save sync state")
}

func (s *Store) GetPreferences(userID string) (*Preferences, error) {
	var prefs Preferences
	if err := s.kv.Get(prefsPrefix+userID, &prefs); err != nil {
		return nil, errors.Wrap(err, "failed to load preferences")
	}
	return &prefs, nil
}

func (s *Store) SavePreferences(userID string, prefs *Preferences) error {
	_, err := s.kv.Set(prefsPrefix+userID, prefs)
	return errors.Wrap(err, "failed to save preferences")
}

// Kinds of signature pictures.
const (
	ImagePhoto = "photo"
	ImageLogo  = "logo"
)

func imageKey(userID, kind string) string {
	if kind == ImageLogo {
		return logoPrefix + userID
	}
	return imagePrefix + userID
}

func (s *Store) GetSignatureImage(userID, kind string) (*SignatureImage, error) {
	var img SignatureImage
	if err := s.kv.Get(imageKey(userID, kind), &img); err != nil {
		return nil, errors.Wrap(err, "failed to load signature image")
	}
	if len(img.Data) == 0 {
		return nil, nil
	}
	return &img, nil
}

func (s *Store) SaveSignatureImage(userID, kind string, img *SignatureImage) error {
	if img == nil {
		return errors.Wrap(s.kv.Delete(imageKey(userID, kind)), "failed to delete signature image")
	}
	_, err := s.kv.Set(imageKey(userID, kind), img)
	return errors.Wrap(err, "failed to save signature image")
}

// Rule puts new mail from a sender into a folder, like the filters of
// web mail. The plugin applies it when it checks Inbox.
type Rule struct {
	ID string `json:"id"`
	// From is an address ("anna@example.ru") or a domain ("@example.ru"),
	// in lower case.
	From   string `json:"from"`
	Folder string `json:"folder"`
	// KeepInInbox copies the message instead of moving it: it is both in
	// Inbox (with the usual notification) and in the folder.
	KeepInInbox bool      `json:"keep_in_inbox"`
	CreatedAt   time.Time `json:"created_at"`
	// Applied counts the messages the rule has sorted.
	Applied   int    `json:"applied"`
	LastError string `json:"last_error,omitempty"`
}

// Matches tells whether the address is covered by the rule.
func (r *Rule) Matches(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if strings.HasPrefix(r.From, "@") {
		return strings.HasSuffix(email, r.From)
	}
	return email == r.From
}

type ruleList struct {
	Rules []Rule `json:"rules"`
}

func (s *Store) GetRules(userID string) ([]Rule, error) {
	var list ruleList
	if err := s.kv.Get(rulesPrefix+userID, &list); err != nil {
		return nil, errors.Wrap(err, "failed to load rules")
	}
	return list.Rules, nil
}

func (s *Store) SaveRules(userID string, rules []Rule) error {
	if len(rules) == 0 {
		return errors.Wrap(s.kv.Delete(rulesPrefix+userID), "failed to delete rules")
	}
	_, err := s.kv.Set(rulesPrefix+userID, &ruleList{Rules: rules})
	return errors.Wrap(err, "failed to save rules")
}

// DeleteUser removes the account and its state. Preferences stay.
func (s *Store) DeleteUser(userID string) error {
	for _, prefix := range []string{accountPrefix, syncPrefix, imagePrefix, logoPrefix, rulesPrefix} {
		if err := s.kv.Delete(prefix + userID); err != nil {
			return errors.Wrap(err, "failed to delete user data")
		}
	}
	return nil
}

// ResetSync forgets the check state, e.g. after reconnecting.
func (s *Store) ResetSync(userID string) error {
	return errors.Wrap(s.kv.Delete(syncPrefix+userID), "failed to reset sync state")
}

// ListConnectedUsers returns the IDs of all users with a connected account.
func (s *Store) ListConnectedUsers() ([]string, error) {
	var users []string
	for page := 0; ; page++ {
		keys, err := s.kv.ListKeys(page, listPageSize)
		if err != nil {
			return nil, errors.Wrap(err, "failed to list keys")
		}
		for _, key := range keys {
			if userID, ok := strings.CutPrefix(key, accountPrefix); ok {
				users = append(users, userID)
			}
		}
		if len(keys) < listPageSize {
			return users, nil
		}
	}
}
