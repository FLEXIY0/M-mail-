package main

import (
	"strings"
	"sync"
	"time"
)

const directoryTTL = 10 * time.Minute

// userDirectory maps e-mail addresses to Mattermost users, so that the
// panel shows the photos of colleagues next to their messages.
type userDirectory struct {
	mu      sync.Mutex
	entries map[string]directoryEntry
}

type directoryEntry struct {
	userID  string
	expires time.Time
}

func newUserDirectory() *userDirectory {
	return &userDirectory{entries: map[string]directoryEntry{}}
}

// lookup returns e-mail → user id for the addresses that belong to active
// Mattermost users. Unknown addresses are remembered too.
func (d *userDirectory) lookup(p *Plugin, emails []string) map[string]string {
	out := map[string]string{}
	now := time.Now()
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" {
			continue
		}
		if _, done := out[email]; done {
			continue
		}
		d.mu.Lock()
		entry, ok := d.entries[email]
		d.mu.Unlock()
		if !ok || now.After(entry.expires) {
			entry = directoryEntry{expires: now.Add(directoryTTL)}
			if user, err := p.API.GetUserByEmail(email); err == nil && user != nil && user.DeleteAt == 0 && !user.IsBot {
				entry.userID = user.Id
			}
			d.mu.Lock()
			if len(d.entries) > 50000 {
				d.entries = map[string]directoryEntry{}
			}
			d.entries[email] = entry
			d.mu.Unlock()
		}
		if entry.userID != "" {
			out[email] = entry.userID
		}
	}
	return out
}
