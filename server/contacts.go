package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
)

// The composer suggests people the user corresponded with: senders of
// recent mail and recipients of sent mail, ranked by how often and how
// recently. Mailboxes have no address book over IMAP, so the history is
// the address book.

const (
	contactsTTL        = 30 * time.Minute
	contactsInbox      = 400
	contactsSent       = 400
	maxContacts        = 500
	avatarCacheSize    = 5000
	avatarTTL          = 24 * time.Hour
	avatarMissTTL      = 6 * time.Hour
	maxAvatarBytes     = 256 << 10
	avatarFetchTimeout = 5 * time.Second
	mailruAvatarURL    = "https://filin.mail.ru/pic"
)

// Robots and mailing lists are not people to write to.
var reRobot = regexp.MustCompile(`(?i)(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|robot)([._-]|@)`)

type contact struct {
	Email  string    `json:"email"`
	Name   string    `json:"name,omitempty"`
	UserID string    `json:"user_id,omitempty"`
	Sent   int       `json:"sent"`
	Got    int       `json:"received"`
	Last   time.Time `json:"last"`
}

type contactBook struct {
	mu    sync.Mutex
	books map[string]*userBook
}

type userBook struct {
	built    time.Time
	contacts []contact
}

func newContactBook() *contactBook {
	return &contactBook{books: map[string]*userBook{}}
}

// buildContacts reads the history of Inbox and Sent.
func buildContacts(ctx context.Context, conn *mailclient.IMAP, own string) ([]contact, error) {
	byEmail := map[string]*contact{}
	add := func(list []mailclient.Address, sent bool, date time.Time) {
		for _, a := range list {
			email := strings.ToLower(strings.TrimSpace(a.Email))
			if email == "" || email == own || !strings.Contains(email, "@") || reRobot.MatchString(email) {
				continue
			}
			c := byEmail[email]
			if c == nil {
				c = &contact{Email: email}
				byEmail[email] = c
			}
			if a.Name != "" && !strings.EqualFold(a.Name, email) {
				c.Name = a.Name
			}
			if sent {
				c.Sent++
			} else {
				c.Got++
			}
			if date.After(c.Last) {
				c.Last = date
			}
		}
	}
	inbox, err := conn.RecentEnvelopes(ctx, "INBOX", contactsInbox)
	if err != nil {
		return nil, err
	}
	for _, e := range inbox {
		add(e.From, false, e.Date)
	}
	if sentFolder, err := conn.FolderByRole(ctx, mailclient.RoleSent); err == nil && sentFolder != "" {
		if sent, err := conn.RecentEnvelopes(ctx, sentFolder, contactsSent); err == nil {
			for _, e := range sent {
				add(e.To, true, e.Date)
				add(e.Cc, true, e.Date)
			}
		}
	}
	out := make([]contact, 0, len(byEmail))
	for _, c := range byEmail {
		out = append(out, *c)
	}
	rankContacts(out)
	if len(out) > maxContacts {
		out = out[:maxContacts]
	}
	return out, nil
}

// rankContacts puts first the people the user writes to, then those who
// write often, the most recent first among equals.
func rankContacts(list []contact) {
	score := func(c contact) int { return c.Sent*3 + c.Got }
	sort.SliceStable(list, func(i, j int) bool {
		si, sj := score(list[i]), score(list[j])
		if si != sj {
			return si > sj
		}
		return list[i].Last.After(list[j].Last)
	})
}

// GET /contacts — the address book from the history, cached.
func (p *Plugin) handleContacts(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	account := p.accountFor(w, userID)
	if account == nil {
		return
	}
	p.contacts.mu.Lock()
	book := p.contacts.books[userID]
	p.contacts.mu.Unlock()
	if book == nil || time.Since(book.built) > contactsTTL || r.URL.Query().Get("refresh") == "1" {
		ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
		defer cancel()
		var list []contact
		err := p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
			var err error
			list, err = buildContacts(ctx, conn, strings.ToLower(account.Email))
			return err
		})
		if err != nil {
			writeMailError(w, err)
			return
		}
		emails := make([]string, 0, len(list))
		for _, c := range list {
			emails = append(emails, c.Email)
		}
		ids := p.directory.lookup(p, emails)
		for i := range list {
			list[i].UserID = ids[list[i].Email]
		}
		book = &userBook{built: time.Now(), contacts: list}
		p.contacts.mu.Lock()
		p.contacts.books[userID] = book
		p.contacts.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]any{"contacts": book.contacts})
}

// forgetContacts drops the cached book, e.g. after sending a message.
func (p *Plugin) forgetContacts(userID string) {
	p.contacts.mu.Lock()
	delete(p.contacts.books, userID)
	p.contacts.mu.Unlock()
}

type avatarEntry struct {
	data        []byte
	contentType string
	fetched     time.Time
}

type avatarCache struct {
	mu      sync.Mutex
	entries map[string]*avatarEntry
}

func newAvatarCache() *avatarCache {
	return &avatarCache{entries: map[string]*avatarEntry{}}
}

func (c *avatarCache) get(email string) (*avatarEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[email]
	if !ok {
		return nil, false
	}
	ttl := avatarTTL
	if e.data == nil {
		ttl = avatarMissTTL
	}
	if time.Since(e.fetched) > ttl {
		delete(c.entries, email)
		return nil, false
	}
	return e, true
}

func (c *avatarCache) put(email string, e *avatarEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= avatarCacheSize {
		c.entries = map[string]*avatarEntry{}
	}
	c.entries[email] = e
}

// fetchMailruAvatar asks the avatar service of Mail.ru, which also knows
// VK WorkSpace and many other addresses. A generated picture with letters
// (x-icon_source "@") means there is no photo: the panel draws its own
// initials instead.
func fetchMailruAvatar(ctx context.Context, email string) (*avatarEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, avatarFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mailruAvatarURL+"?"+url.Values{"email": {email}, "width": {"96"}, "height": {"96"}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	entry := &avatarEntry{fetched: time.Now()}
	ct := res.Header.Get("Content-Type")
	if res.StatusCode != http.StatusOK || res.Header.Get("X-Icon_source") == "@" || !strings.HasPrefix(ct, "image/") || ct == "image/svg+xml" {
		return entry, nil
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxAvatarBytes+1))
	if err != nil || len(data) > maxAvatarBytes {
		return entry, nil //nolint:nilerr
	}
	entry.data, entry.contentType = data, ct
	return entry, nil
}

// GET /avatar?email=… — the photo of a sender who is not in Mattermost.
// 404 means "no photo, draw the initials".
func (p *Plugin) handleAvatar(w http.ResponseWriter, r *http.Request) {
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	if !p.getConfiguration().senderPhotos() || !looksLikeEmail(email) {
		http.NotFound(w, r)
		return
	}
	entry, ok := p.avatars.get(email)
	if !ok {
		var err error
		entry, err = fetchMailruAvatar(r.Context(), email)
		if err != nil {
			// The service is unreachable (e.g. no internet): no photo, and
			// do not ask again for a while.
			entry = &avatarEntry{fetched: time.Now()}
		}
		p.avatars.put(email, entry)
	}
	if entry.data == nil {
		w.Header().Set("Cache-Control", "private, max-age=21600")
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", entry.contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write(entry.data)
}
