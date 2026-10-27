package main

import (
	"sync"
	"time"
)

// rateLimiter limits attempts per user. Checking passwords is expensive for
// us and suspicious for the provider, so it must not be possible to hammer
// it from the wizard.
type rateLimiter struct {
	limit  int
	window time.Duration
	mu     sync.Mutex
	hits   map[string][]time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, hits: map[string][]time.Time{}}
}

func (r *rateLimiter) allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	recent := r.hits[key][:0]
	for _, t := range r.hits[key] {
		if now.Sub(t) < r.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= r.limit {
		r.hits[key] = recent
		return false
	}
	r.hits[key] = append(recent, now)
	return true
}
