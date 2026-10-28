package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/mattermost/mattermost/server/public/model"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	maxRules = 100
	// Messages a rule looks at in one go: new mail of one check, or what is
	// already in Inbox when a rule is created.
	maxRuleBatch    = 200
	maxRuleExisting = 2000
	codeInvalidRule = "invalid_rule"
)

func init() {
	errorMessages[codeInvalidRule] = "Проверьте правило."
}

// ruleFor picks the rule for a sender: an address rule wins over a rule
// for the whole domain.
func ruleFor(rules []store.Rule, from []mailclient.Address) int {
	if len(from) == 0 {
		return -1
	}
	found := -1
	for i := range rules {
		if !rules[i].Matches(from[0].Email) {
			continue
		}
		if !strings.HasPrefix(rules[i].From, "@") {
			return i
		}
		if found < 0 {
			found = i
		}
	}
	return found
}

// applyRules sorts messages of Inbox by the rules: moves them to the folder
// of the rule, or copies them when the rule keeps Inbox. It changes the
// counters of the rules and returns how many messages left Inbox. A rule
// whose folder is gone records the error and is skipped; the others work.
func applyRules(ctx context.Context, conn *mailclient.IMAP, rules []store.Rule, senders []mailclient.Sender) (moved, sorted int) {
	byRule := map[int][]uint32{}
	for _, s := range senders {
		if i := ruleFor(rules, s.From); i >= 0 {
			byRule[i] = append(byRule[i], s.UID)
		}
	}
	for i, uids := range byRule {
		rule := &rules[i]
		var err error
		if rule.KeepInInbox {
			err = conn.Copy(ctx, "INBOX", uids, rule.Folder)
		} else {
			err = conn.Move(ctx, "INBOX", uids, rule.Folder)
		}
		if err != nil {
			rule.LastError = err.Error()
			continue
		}
		rule.LastError = ""
		rule.Applied += len(uids)
		sorted += len(uids)
		if !rule.KeepInInbox {
			moved += len(uids)
		}
	}
	return moved, sorted
}

// cleanRuleFrom accepts "anna@example.ru", "Анна <anna@example.ru>" or a
// whole domain: "@example.ru" (or "example.ru").
func cleanRuleFrom(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("укажите адрес отправителя или домен")
	}
	if addr, err := mail.ParseAddress(raw); err == nil {
		return strings.ToLower(addr.Address), nil
	}
	domain := strings.ToLower(strings.TrimPrefix(raw, "@"))
	if strings.ContainsAny(domain, " @<>\"'") || !strings.Contains(domain, ".") || len(domain) > 253 {
		return "", errors.New("это не похоже на адрес почты или домен")
	}
	return "@" + domain, nil
}

type ruleRequest struct {
	ID            string `json:"id"`
	From          string `json:"from"`
	Folder        string `json:"folder"`
	KeepInInbox   bool   `json:"keep_in_inbox"`
	ApplyExisting bool   `json:"apply_existing"`
}

// GET /rules
func (p *Plugin) handleRules(w http.ResponseWriter, r *http.Request) {
	rules, err := p.store.GetRules(userIDFrom(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if rules == nil {
		rules = []store.Rule{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

// POST /rules — creates a rule or changes one (by id, or the rule for the
// same sender), and optionally sorts what is already in Inbox.
func (p *Plugin) handleSaveRule(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req ruleRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	from, err := cleanRuleFrom(req.From)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRule, err.Error())
		return
	}
	account := p.accountFor(w, userID)
	if account == nil {
		return
	}

	// The background check changes the counters of the rules: both work
	// under the lock of the user.
	lock := userLock(userID)
	lock.Lock()
	defer lock.Unlock()

	rules, err := p.store.GetRules(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	index := -1
	for i := range rules {
		if (req.ID != "" && rules[i].ID == req.ID) || (req.ID == "" && rules[i].From == from) {
			index = i
			break
		}
	}
	if req.ID != "" && index < 0 {
		writeError(w, http.StatusNotFound, string(mailclient.CodeNotFound), "rule not found")
		return
	}
	for i := range rules {
		if i != index && rules[i].From == from {
			writeError(w, http.StatusBadRequest, codeInvalidRule, "для этого отправителя уже есть правило")
			return
		}
	}
	if index < 0 && len(rules) >= maxRules {
		writeError(w, http.StatusBadRequest, codeInvalidRule, fmt.Sprintf("правил может быть не больше %d", maxRules))
		return
	}

	rule := store.Rule{ID: model.NewId(), From: from, Folder: req.Folder, KeepInInbox: req.KeepInInbox, CreatedAt: time.Now()}
	if index >= 0 {
		rule.ID, rule.CreatedAt, rule.Applied = rules[index].ID, rules[index].CreatedAt, rules[index].Applied
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*requestTimeout)
	defer cancel()
	var moved, sorted int
	err = p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		folders, err := conn.Folders(ctx)
		if err != nil {
			return err
		}
		ok := false
		for _, f := range folders {
			if f.Name == rule.Folder && !f.NoSelect && f.Role != mailclient.RoleInbox {
				ok = true
			}
		}
		if !ok {
			return errNoRuleFolder
		}
		if !req.ApplyExisting {
			return nil
		}
		senders, err := conn.SendersFrom(ctx, "INBOX", strings.TrimPrefix(from, "@"), maxRuleExisting)
		if err != nil {
			return err
		}
		one := []store.Rule{rule}
		moved, sorted = applyRules(ctx, conn, one, senders)
		if one[0].LastError != "" {
			return errors.New(one[0].LastError)
		}
		rule = one[0]
		return nil
	})
	if errors.Is(err, errNoRuleFolder) {
		writeError(w, http.StatusBadRequest, codeInvalidRule, "выберите папку для писем (не «Входящие»)")
		return
	}
	if err != nil {
		writeMailError(w, err)
		return
	}

	if index >= 0 {
		rules[index] = rule
	} else {
		rules = append(rules, rule)
	}
	if err = p.store.SaveRules(userID, rules); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if sorted > 0 {
		p.publish(userID, wsMailUpdated, nil)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rule": rule, "rules": rules, "sorted": sorted, "moved": moved})
}

var errNoRuleFolder = errors.New("no folder for the rule")

// POST /rules/delete {id}
func (p *Plugin) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req ruleRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	lock := userLock(userID)
	lock.Lock()
	defer lock.Unlock()
	rules, err := p.store.GetRules(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	kept := rules[:0]
	for _, rule := range rules {
		if rule.ID != req.ID {
			kept = append(kept, rule)
		}
	}
	if err = p.store.SaveRules(userID, kept); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rules": append([]store.Rule{}, kept...)})
}

// folderRenamed points the rules to the new name of a folder (and of the
// folders inside it); folderDeleted drops the rules of a deleted folder.
func (p *Plugin) folderRenamed(userID, oldName, newName, delim string) {
	p.updateRules(userID, func(rule *store.Rule) bool {
		switch {
		case rule.Folder == oldName:
			rule.Folder = newName
		case delim != "" && strings.HasPrefix(rule.Folder, oldName+delim):
			rule.Folder = newName + strings.TrimPrefix(rule.Folder, oldName)
		}
		return true
	})
}

func (p *Plugin) folderDeleted(userID, name, delim string) {
	p.updateRules(userID, func(rule *store.Rule) bool {
		return rule.Folder != name && (delim == "" || !strings.HasPrefix(rule.Folder, name+delim))
	})
}

// updateRules changes or drops (fn returns false) the rules of a user.
func (p *Plugin) updateRules(userID string, fn func(rule *store.Rule) bool) {
	lock := userLock(userID)
	lock.Lock()
	defer lock.Unlock()
	rules, err := p.store.GetRules(userID)
	if err != nil || len(rules) == 0 {
		return
	}
	kept := rules[:0]
	for i := range rules {
		if fn(&rules[i]) {
			kept = append(kept, rules[i])
		}
	}
	if err = p.store.SaveRules(userID, kept); err != nil {
		p.API.LogWarn("Failed to update mail rules", "err", err.Error())
	}
}
