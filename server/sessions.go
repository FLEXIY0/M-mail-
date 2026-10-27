package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	// sessionIdleTimeout closes IMAP connections nobody used for a while.
	// The panel makes several requests in a row (folders, list, message),
	// and a fresh TLS connection with login costs about half a second.
	sessionIdleTimeout = 3 * time.Minute
	requestTimeout     = 40 * time.Second
)

// sessionPool keeps at most one IMAP connection per user. IMAP connections
// have a "selected folder" state, so a connection is used by one request at
// a time; requests of the same user wait for each other.
type sessionPool struct {
	idle     time.Duration
	mu       sync.Mutex
	sessions map[string]*session
	stop     chan struct{}
	stopOnce sync.Once
}

type session struct {
	mu       sync.Mutex
	conn     *mailclient.IMAP
	key      string
	lastUsed time.Time
}

func newSessionPool(idle time.Duration) *sessionPool {
	pool := &sessionPool{idle: idle, sessions: map[string]*session{}, stop: make(chan struct{})}
	go pool.reap()
	return pool
}

func (sp *sessionPool) get(userID string) *session {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	s, ok := sp.sessions[userID]
	if !ok {
		s = &session{}
		sp.sessions[userID] = s
	}
	return s
}

// has reports whether the user has an open connection. A session that is
// busy right now is in use, so it counts as open.
func (sp *sessionPool) has(userID string) bool {
	sp.mu.Lock()
	s, ok := sp.sessions[userID]
	sp.mu.Unlock()
	if !ok {
		return false
	}
	if !s.mu.TryLock() {
		return true
	}
	defer s.mu.Unlock()
	return s.conn != nil
}

// drop closes the user's connection, e.g. after disconnect.
func (sp *sessionPool) drop(userID string) {
	sp.mu.Lock()
	s, ok := sp.sessions[userID]
	delete(sp.sessions, userID)
	sp.mu.Unlock()
	if ok {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
	}
}

func (sp *sessionPool) closeAll() {
	sp.mu.Lock()
	sessions := sp.sessions
	sp.sessions = map[string]*session{}
	sp.mu.Unlock()
	for _, s := range sessions {
		s.mu.Lock()
		s.closeLocked()
		s.mu.Unlock()
	}
}

func (sp *sessionPool) shutdown() {
	sp.stopOnce.Do(func() { close(sp.stop) })
	sp.closeAll()
}

func (sp *sessionPool) reap() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-sp.stop:
			return
		case <-ticker.C:
		}
		sp.mu.Lock()
		var idle []*session
		for userID, s := range sp.sessions {
			if s.mu.TryLock() {
				if time.Since(s.lastUsed) > sp.idle {
					idle = append(idle, s)
					delete(sp.sessions, userID)
				}
				s.mu.Unlock()
			}
		}
		sp.mu.Unlock()
		for _, s := range idle {
			s.mu.Lock()
			s.closeLocked()
			s.mu.Unlock()
		}
	}
}

func (s *session) closeLocked() {
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
}

// accountKey changes whenever the connection settings change, so that a
// reconnect with a new password never reuses the old connection.
func accountKey(account *store.Account) string {
	sum := sha256.Sum256([]byte(account.Provider + "|" + account.IMAP.Address() + "|" + string(account.IMAP.Security) + "|" + account.Username + "|" + account.PasswordEncrypted))
	return hex.EncodeToString(sum[:8])
}

func (p *Plugin) credentialsFor(account *store.Account) (mailclient.Credentials, error) {
	box, err := p.getBox()
	if err != nil {
		return mailclient.Credentials{}, err
	}
	password, err := box.Decrypt(account.PasswordEncrypted)
	if err != nil {
		return mailclient.Credentials{}, err
	}
	return mailclient.Credentials{Username: account.Username, Password: password}, nil
}

// withIMAP runs fn on the user's IMAP connection, connecting when needed.
// A broken connection is re-established once. With keep=false a new
// connection is closed afterwards instead of being kept in the pool (used
// by the background check, so that idle users do not hold connections).
func (p *Plugin) withIMAP(ctx context.Context, userID string, account *store.Account, keep bool, fn func(*mailclient.IMAP) error) error {
	s := p.sessions.get(userID)
	s.mu.Lock()
	defer s.mu.Unlock()

	key := accountKey(account)
	if s.conn != nil && (s.key != key || !s.conn.Alive()) {
		s.closeLocked()
	}
	fresh := false
	connect := func() error {
		creds, err := p.credentialsFor(account)
		if err != nil {
			return err
		}
		conn, err := mailclient.DialIMAP(ctx, account.IMAP, creds, p.policyFor(account))
		if err != nil {
			if mailclient.IsAuth(err) {
				p.markAuthFailed(userID, err)
			}
			return err
		}
		s.conn, s.key, fresh = conn, key, true
		return nil
	}
	if s.conn == nil {
		if err := connect(); err != nil {
			return err
		}
	}
	s.lastUsed = time.Now()
	err := fn(s.conn)
	if err != nil && !fresh && mailclient.IsTransient(err) {
		// The server may have dropped an idle connection: retry once.
		s.closeLocked()
		if err = connect(); err != nil {
			return err
		}
		err = fn(s.conn)
	}
	if err != nil && mailclient.IsTransient(err) {
		s.closeLocked()
	}
	if !keep && fresh {
		s.closeLocked()
	}
	s.lastUsed = time.Now()
	return err
}
