package mailclient

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/charset"
)

// wordDecoder decodes RFC 2047 headers in any charset go-message knows,
// including windows-1251 and koi8-r that are still common in Russian mail.
var wordDecoder = &mime.WordDecoder{CharsetReader: charset.Reader}

// IMAP is one authenticated IMAP connection. It is not safe for concurrent
// use: IMAP has a single "selected folder" per connection, so callers keep
// one connection per user and serialise access to it.
type IMAP struct {
	conn   net.Conn
	client *imapclient.Client
	policy Policy

	selected         string
	selectedReadOnly bool

	folders  []Folder
	previews *PreviewCache
}

// DialIMAP connects, logs in and returns a ready connection.
func DialIMAP(ctx context.Context, endpoint Endpoint, creds Credentials, policy Policy) (*IMAP, error) {
	ctx, cancel := context.WithTimeout(ctx, policy.timeout())
	defer cancel()

	conn, err := dial(ctx, endpoint, policy, "connect")
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	host := strings.TrimSpace(endpoint.Host)
	options := &imapclient.Options{WordDecoder: wordDecoder, TLSConfig: policy.tlsConfig(host)}

	var client *imapclient.Client
	raw := conn
	switch security, _ := ParseSecurity(string(endpoint.Security)); security {
	case SecurityTLS:
		tlsConn, hsErr := handshake(ctx, conn, host, policy, "connect")
		if hsErr != nil {
			return nil, hsErr
		}
		conn = tlsConn
		client = imapclient.New(conn, options)
	case SecurityStartTLS:
		client, err = imapclient.NewStartTLS(conn, options)
		if err != nil {
			_ = raw.Close()
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, newError(CodeTimeout, "starttls", err)
			}
			return nil, newError(CodeTLS, "starttls", err)
		}
	default:
		client = imapclient.New(conn, options)
	}

	m := &IMAP{conn: raw, client: client, policy: policy}
	if err = client.WaitGreeting(); err != nil {
		_ = client.Close()
		return nil, classify("greeting", err)
	}
	if err = client.Login(creds.Username, creds.Password).Wait(); err != nil {
		_ = client.Close()
		return nil, classify("login", err)
	}
	_ = raw.SetDeadline(time.Time{})
	return m, nil
}

// do runs one IMAP exchange with a deadline. A timeout breaks the
// connection; the caller must then dial again (see Alive).
func (m *IMAP) do(ctx context.Context, op string, fn func() error) error {
	deadline := time.Now().Add(m.policy.timeout())
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = m.conn.SetDeadline(deadline)
	defer m.conn.SetDeadline(time.Time{}) //nolint:errcheck
	if err := fn(); err != nil {
		return classify(op, err)
	}
	return nil
}

// Alive reports whether the connection is still usable.
func (m *IMAP) Alive() bool {
	select {
	case <-m.client.Closed():
		return false
	default:
		return true
	}
}

// Ping checks the connection with NOOP.
func (m *IMAP) Ping(ctx context.Context) error {
	return m.do(ctx, "noop", func() error { return m.client.Noop().Wait() })
}

// Close logs out politely and closes the connection.
func (m *IMAP) Close() {
	if m.Alive() {
		_ = m.conn.SetDeadline(time.Now().Add(3 * time.Second))
		_ = m.client.Logout().Wait()
	}
	_ = m.client.Close()
}

// Folder roles. The webapp shows a matching icon and the Russian name.
const (
	RoleInbox   = "inbox"
	RoleSent    = "sent"
	RoleDrafts  = "drafts"
	RoleTrash   = "trash"
	RoleJunk    = "junk"
	RoleArchive = "archive"
)

// Folder is an IMAP mailbox.
type Folder struct {
	Name     string `json:"name"`    // full IMAP name, used in requests
	Display  string `json:"display"` // last path segment
	Role     string `json:"role,omitempty"`
	Depth    int    `json:"depth"`
	Unseen   int    `json:"unseen"`
	Total    int    `json:"total"`
	NoSelect bool   `json:"no_select,omitempty"`
	// Delim separates levels of nested folders, e.g. "/" or ".".
	Delim string `json:"delim,omitempty"`
}

// roleNames recognise special folders on servers without SPECIAL-USE.
var roleNames = map[string]string{
	"sent": RoleSent, "sent items": RoleSent, "sent messages": RoleSent, "sent mail": RoleSent, "отправленные": RoleSent,
	"drafts": RoleDrafts, "draft": RoleDrafts, "черновики": RoleDrafts,
	"trash": RoleTrash, "deleted": RoleTrash, "deleted items": RoleTrash, "deleted messages": RoleTrash, "корзина": RoleTrash, "удаленные": RoleTrash, "удалённые": RoleTrash,
	"junk": RoleJunk, "spam": RoleJunk, "junk e-mail": RoleJunk, "спам": RoleJunk,
	"archive": RoleArchive, "archives": RoleArchive, "архив": RoleArchive,
}

var attrRoles = map[imap.MailboxAttr]string{
	imap.MailboxAttrSent:    RoleSent,
	imap.MailboxAttrDrafts:  RoleDrafts,
	imap.MailboxAttrTrash:   RoleTrash,
	imap.MailboxAttrJunk:    RoleJunk,
	imap.MailboxAttrArchive: RoleArchive,
}

var roleOrder = map[string]int{RoleInbox: 0, RoleDrafts: 1, RoleSent: 2, RoleArchive: 3, RoleJunk: 4, RoleTrash: 5}

// Folders lists the mailboxes with message counts. Special folders come
// first in the usual order, the rest alphabetically as a tree.
func (m *IMAP) Folders(ctx context.Context) ([]Folder, error) {
	var list []*imap.ListData
	listStatus := m.client.Caps().Has(imap.CapListStatus) || m.client.Caps().Has(imap.CapIMAP4rev2)
	statusOpts := &imap.StatusOptions{NumMessages: true, NumUnseen: true}
	err := m.do(ctx, "list", func() error {
		opts := &imap.ListOptions{}
		if listStatus {
			opts.ReturnStatus = statusOpts
		}
		if m.client.Caps().Has(imap.CapSpecialUse) {
			opts.ReturnSpecialUse = true
		}
		var err error
		list, err = m.client.List("", "*", opts).Collect()
		return err
	})
	if err != nil {
		return nil, err
	}

	folders := make([]Folder, 0, len(list))
	usedRoles := map[string]bool{}
	for _, data := range list {
		f := Folder{Name: data.Mailbox, Display: data.Mailbox}
		if data.Delim != 0 {
			f.Delim = string(data.Delim)
			parts := strings.Split(data.Mailbox, string(data.Delim))
			f.Display = parts[len(parts)-1]
			f.Depth = len(parts) - 1
		}
		for _, attr := range data.Attrs {
			switch {
			case attr == imap.MailboxAttrNoSelect || attr == imap.MailboxAttrNonExistent:
				f.NoSelect = true
			case attrRoles[attr] != "":
				f.Role = attrRoles[attr]
			}
		}
		if strings.EqualFold(data.Mailbox, "INBOX") {
			f.Role = RoleInbox
			f.Display = "INBOX"
		}
		if data.Status != nil {
			f.Total = intOf(data.Status.NumMessages)
			f.Unseen = intOf(data.Status.NumUnseen)
		}
		if f.Role != "" {
			usedRoles[f.Role] = true
		}
		folders = append(folders, f)
	}
	// Fall back to well known names, but never give two folders one role.
	for i := range folders {
		if folders[i].Role != "" || folders[i].Depth > 0 {
			continue
		}
		if role := roleNames[strings.ToLower(folders[i].Display)]; role != "" && !usedRoles[role] {
			folders[i].Role = role
			usedRoles[role] = true
		}
	}
	if !listStatus {
		for i := range folders {
			if folders[i].NoSelect {
				continue
			}
			var data *imap.StatusData
			statusErr := m.do(ctx, "status", func() error {
				var err error
				data, err = m.client.Status(folders[i].Name, statusOpts).Wait()
				return err
			})
			if statusErr != nil {
				if IsTransient(statusErr) {
					return nil, statusErr
				}
				continue
			}
			folders[i].Total = intOf(data.NumMessages)
			folders[i].Unseen = intOf(data.NumUnseen)
		}
	}

	sort.SliceStable(folders, func(i, j int) bool {
		ri, iok := roleOrder[folders[i].Role]
		rj, jok := roleOrder[folders[j].Role]
		top := func(f Folder, ok bool) bool { return ok && f.Depth == 0 }
		if top(folders[i], iok) != top(folders[j], jok) {
			return top(folders[i], iok)
		}
		if top(folders[i], iok) {
			return ri < rj
		}
		return strings.ToLower(folders[i].Name) < strings.ToLower(folders[j].Name)
	})
	m.folders = folders
	return folders, nil
}

// FolderByRole finds a special folder, listing folders when needed.
func (m *IMAP) FolderByRole(ctx context.Context, role string) (string, error) {
	if m.folders == nil {
		if _, err := m.Folders(ctx); err != nil {
			return "", err
		}
	}
	for _, f := range m.folders {
		if f.Role == role {
			return f.Name, nil
		}
	}
	return "", nil
}

func intOf(p *uint32) int {
	if p == nil {
		return 0
	}
	return int(*p)
}

// InboxStatus is what the background check needs to notice new mail.
type InboxStatus struct {
	UIDValidity uint32
	UIDNext     uint32
	Unseen      int
	Total       int
}

// Status returns counters of a folder without selecting it.
func (m *IMAP) Status(ctx context.Context, folder string) (*InboxStatus, error) {
	var data *imap.StatusData
	err := m.do(ctx, "status", func() error {
		var err error
		data, err = m.client.Status(folder, &imap.StatusOptions{UIDNext: true, UIDValidity: true, NumUnseen: true, NumMessages: true}).Wait()
		return err
	})
	if err != nil {
		return nil, err
	}
	return &InboxStatus{UIDValidity: data.UIDValidity, UIDNext: uint32(data.UIDNext), Unseen: intOf(data.NumUnseen), Total: intOf(data.NumMessages)}, nil
}

func (m *IMAP) selectFolder(ctx context.Context, folder string, readOnly bool) (*imap.SelectData, error) {
	var data *imap.SelectData
	err := m.do(ctx, "select", func() error {
		var err error
		data, err = m.client.Select(folder, &imap.SelectOptions{ReadOnly: readOnly}).Wait()
		return err
	})
	if err != nil {
		m.selected = ""
		return nil, err
	}
	m.selected = folder
	m.selectedReadOnly = readOnly
	return data, nil
}

// ensureSelected selects the folder unless it is already selected in a
// suitable mode. Writes need a read-write selection.
func (m *IMAP) ensureSelected(ctx context.Context, folder string, write bool) error {
	if m.selected == folder && (!write || !m.selectedReadOnly) {
		return nil
	}
	_, err := m.selectFolder(ctx, folder, !write)
	return err
}

// Address is a mailbox in a header.
type Address struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

func convertAddresses(list []imap.Address) []Address {
	out := make([]Address, 0, len(list))
	for _, a := range list {
		if a.IsGroupStart() || a.IsGroupEnd() {
			continue
		}
		// Broken senders quote the whole address ("ivan@example.ru"),
		// which servers then split into a quoted mailbox and host.
		mailbox := strings.Trim(a.Mailbox, `"' `)
		host := strings.Trim(a.Host, `"' `)
		if mailbox == "" || host == "" {
			continue
		}
		email := mailbox + "@" + host
		out = append(out, Address{Name: strings.TrimSpace(a.Name), Email: email})
	}
	return out
}

// Summary is a message in the list.
type Summary struct {
	UID            uint32    `json:"uid"`
	Subject        string    `json:"subject"`
	From           []Address `json:"from"`
	To             []Address `json:"to"`
	Date           time.Time `json:"date"`
	Seen           bool      `json:"seen"`
	Flagged        bool      `json:"flagged"`
	Answered       bool      `json:"answered"`
	HasAttachments bool      `json:"has_attachments"`
	Size           int64     `json:"size"`
	MessageID      string    `json:"message_id,omitempty"`
	// Preview is the beginning of the text, for the second line in the list.
	Preview string `json:"preview,omitempty"`
}

func summaryOf(buf *imapclient.FetchMessageBuffer) Summary {
	s := Summary{UID: uint32(buf.UID), Size: buf.RFC822Size, Date: buf.InternalDate, From: []Address{}, To: []Address{}}
	if env := buf.Envelope; env != nil {
		s.Subject = env.Subject
		s.From = convertAddresses(env.From)
		s.To = convertAddresses(env.To)
		s.MessageID = env.MessageID
		if !env.Date.IsZero() {
			s.Date = env.Date
		}
	}
	applyFlags(buf.Flags, &s.Seen, &s.Flagged, &s.Answered)
	if buf.BodyStructure != nil {
		s.HasAttachments = len(collectAttachments(buf.BodyStructure)) > 0
	}
	return s
}

func applyFlags(flags []imap.Flag, seen, flagged, answered *bool) {
	for _, f := range flags {
		switch f {
		case imap.FlagSeen:
			*seen = true
		case imap.FlagFlagged:
			*flagged = true
		case imap.FlagAnswered:
			*answered = true
		}
	}
}

var summaryFetch = &imap.FetchOptions{
	UID:           true,
	Flags:         true,
	Envelope:      true,
	InternalDate:  true,
	RFC822Size:    true,
	BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
}

// Page is one page of the message list.
type Page struct {
	Messages []Summary `json:"messages"`
	Total    int       `json:"total"`
	Unseen   int       `json:"unseen"`
	HasMore  bool      `json:"has_more"`
}

// List returns messages of a folder, newest first. offset counts messages
// already shown, so "load more" asks for the next older ones.
func (m *IMAP) List(ctx context.Context, folder string, offset, limit int) (*Page, error) {
	data, err := m.selectFolder(ctx, folder, true)
	if err != nil {
		return nil, err
	}
	total := int(data.NumMessages)
	page := &Page{Messages: []Summary{}, Total: total}
	if status, statusErr := m.Status(ctx, folder); statusErr == nil {
		page.Unseen = status.Unseen
	}
	if offset >= total || limit <= 0 {
		return page, nil
	}
	hi := uint32(total - offset)
	lo := uint32(1)
	if int(hi) > limit {
		lo = hi - uint32(limit) + 1
	}
	var seqSet imap.SeqSet
	seqSet.AddRange(lo, hi)
	var bufs []*imapclient.FetchMessageBuffer
	err = m.do(ctx, "fetch", func() error {
		var err error
		bufs, err = m.client.Fetch(seqSet, summaryFetch).Collect()
		return err
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(bufs, func(i, j int) bool { return bufs[i].SeqNum > bufs[j].SeqNum })
	for _, buf := range bufs {
		page.Messages = append(page.Messages, summaryOf(buf))
	}
	m.fillPreviews(ctx, folder, data.UIDValidity, bufs, page.Messages)
	page.HasMore = lo > 1
	return page, nil
}

// Filters narrow the message list, like "unread" in mail apps.
const (
	FilterUnseen      = "unseen"
	FilterFlagged     = "flagged"
	FilterAttachments = "attachments"
)

// Search finds messages by sender, recipient or subject and/or a filter,
// newest first. offset skips messages already shown.
func (m *IMAP) Search(ctx context.Context, folder, query, filter string, offset, limit int) (*Page, error) {
	query = strings.TrimSpace(query)
	data, err := m.selectFolder(ctx, folder, true)
	if err != nil {
		return nil, err
	}
	criteria := &imap.SearchCriteria{}
	if query != "" {
		header := func(key string) imap.SearchCriteria {
			return imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: key, Value: query}}}
		}
		criteria.Or = [][2]imap.SearchCriteria{{
			{Or: [][2]imap.SearchCriteria{{header("From"), header("Subject")}}},
			header("To"),
		}}
	}
	switch filter {
	case FilterUnseen:
		criteria.NotFlag = []imap.Flag{imap.FlagSeen}
	case FilterFlagged:
		criteria.Flag = []imap.Flag{imap.FlagFlagged}
	case FilterAttachments:
		// IMAP can not search by attachments; messages with files are
		// almost always multipart/mixed.
		criteria.Header = append(criteria.Header, imap.SearchCriteriaHeaderField{Key: "Content-Type", Value: "multipart/mixed"})
	}
	var found *imap.SearchData
	err = m.do(ctx, "search", func() error {
		var err error
		found, err = m.client.UIDSearch(criteria, nil).Wait()
		return err
	})
	if err != nil {
		return nil, err
	}
	uids := found.AllUIDs()
	sort.Slice(uids, func(i, j int) bool { return uids[i] > uids[j] })
	page := &Page{Messages: []Summary{}, Total: len(uids)}
	if offset >= len(uids) {
		return page, nil
	}
	uids = uids[offset:]
	if len(uids) > limit {
		uids = uids[:limit]
		page.HasMore = true
	}
	bufs, err := m.fetchUIDs(ctx, uids, summaryFetch)
	if err != nil {
		return nil, err
	}
	sort.Slice(bufs, func(i, j int) bool { return bufs[i].UID > bufs[j].UID })
	for _, buf := range bufs {
		page.Messages = append(page.Messages, summaryOf(buf))
	}
	m.fillPreviews(ctx, folder, data.UIDValidity, bufs, page.Messages)
	return page, nil
}

// NewSince returns summaries of messages with UID >= since in the folder,
// at most limit of the newest ones. Used for new mail notifications.
func (m *IMAP) NewSince(ctx context.Context, folder string, since uint32, limit int) ([]Summary, error) {
	if _, err := m.selectFolder(ctx, folder, true); err != nil {
		return nil, err
	}
	var data *imap.SearchData
	err := m.do(ctx, "search", func() error {
		var err error
		data, err = m.client.UIDSearch(&imap.SearchCriteria{
			UID:     []imap.UIDSet{{imap.UIDRange{Start: imap.UID(since), Stop: 0}}},
			NotFlag: []imap.Flag{imap.FlagSeen},
		}, nil).Wait()
		return err
	})
	if err != nil {
		return nil, err
	}
	var uids []imap.UID
	for _, uid := range data.AllUIDs() {
		// "N:*" always matches the last message, even when it is older.
		if uint32(uid) >= since {
			uids = append(uids, uid)
		}
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] > uids[j] })
	if len(uids) > limit {
		uids = uids[:limit]
	}
	if len(uids) == 0 {
		return nil, nil
	}
	bufs, err := m.fetchUIDs(ctx, uids, summaryFetch)
	if err != nil {
		return nil, err
	}
	sort.Slice(bufs, func(i, j int) bool { return bufs[i].UID > bufs[j].UID })
	out := make([]Summary, 0, len(bufs))
	for _, buf := range bufs {
		out = append(out, summaryOf(buf))
	}
	return out, nil
}

// HasMessageID reports whether the folder contains a message with the
// given Message-ID (without angle brackets).
func (m *IMAP) HasMessageID(ctx context.Context, folder, messageID string) (bool, error) {
	if messageID == "" {
		return false, nil
	}
	if _, err := m.selectFolder(ctx, folder, true); err != nil {
		return false, err
	}
	var data *imap.SearchData
	err := m.do(ctx, "search", func() error {
		var err error
		data, err = m.client.UIDSearch(&imap.SearchCriteria{
			Header: []imap.SearchCriteriaHeaderField{{Key: "Message-ID", Value: messageID}},
		}, nil).Wait()
		return err
	})
	if err != nil {
		return false, err
	}
	return len(data.AllUIDs()) > 0, nil
}

func (m *IMAP) fetchUIDs(ctx context.Context, uids []imap.UID, opts *imap.FetchOptions) ([]*imapclient.FetchMessageBuffer, error) {
	var bufs []*imapclient.FetchMessageBuffer
	err := m.do(ctx, "fetch", func() error {
		var err error
		bufs, err = m.client.Fetch(imap.UIDSetNum(uids...), opts).Collect()
		return err
	})
	return bufs, err
}

// SetFlags adds or removes \Seen or \Flagged on messages.
func (m *IMAP) SetFlags(ctx context.Context, folder string, uids []uint32, flag string, on bool) error {
	var f imap.Flag
	switch flag {
	case "seen":
		f = imap.FlagSeen
	case "flagged":
		f = imap.FlagFlagged
	case "answered":
		f = imap.FlagAnswered
	default:
		return newError(CodeUnknown, "store", errors.New("unknown flag "+flag))
	}
	if err := m.ensureSelected(ctx, folder, true); err != nil {
		return err
	}
	op := imap.StoreFlagsAdd
	if !on {
		op = imap.StoreFlagsDel
	}
	return m.do(ctx, "store", func() error {
		return m.client.Store(toUIDSet(uids), &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{f}}, nil).Close()
	})
}

// Move moves messages to another folder.
func (m *IMAP) Move(ctx context.Context, folder string, uids []uint32, to string) error {
	if folder == to {
		return nil
	}
	if err := m.ensureSelected(ctx, folder, true); err != nil {
		return err
	}
	return m.do(ctx, "move", func() error {
		_, err := m.client.Move(toUIDSet(uids), to).Wait()
		return err
	})
}

// Delete moves messages to the trash, or removes them for good when they
// already are in the trash (or there is no trash folder).
func (m *IMAP) Delete(ctx context.Context, folder string, uids []uint32) (permanent bool, err error) {
	trash, err := m.FolderByRole(ctx, RoleTrash)
	if err != nil {
		return false, err
	}
	if trash != "" && trash != folder {
		return false, m.Move(ctx, folder, uids, trash)
	}
	if err = m.ensureSelected(ctx, folder, true); err != nil {
		return false, err
	}
	set := toUIDSet(uids)
	err = m.do(ctx, "delete", func() error {
		if err := m.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return err
		}
		if m.client.Caps().Has(imap.CapUIDPlus) {
			return m.client.UIDExpunge(set).Close()
		}
		return m.client.Expunge().Close()
	})
	return true, err
}

// DeleteForever removes messages without moving them to the trash, e.g. a
// draft replaced by its newer version.
func (m *IMAP) DeleteForever(ctx context.Context, folder string, uids []uint32) error {
	if err := m.ensureSelected(ctx, folder, true); err != nil {
		return err
	}
	set := toUIDSet(uids)
	return m.do(ctx, "delete", func() error {
		if err := m.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return err
		}
		if m.client.Caps().Has(imap.CapUIDPlus) {
			return m.client.UIDExpunge(set).Close()
		}
		return m.client.Expunge().Close()
	})
}

// Append stores a raw message, e.g. a copy of a sent message in "Sent".
func (m *IMAP) Append(ctx context.Context, folder string, raw []byte, flags []string) error {
	var imapFlags []imap.Flag
	for _, f := range flags {
		imapFlags = append(imapFlags, imap.Flag(f))
	}
	return m.do(ctx, "append", func() error {
		cmd := m.client.Append(folder, int64(len(raw)), &imap.AppendOptions{Flags: imapFlags, Time: time.Now()})
		if _, err := cmd.Write(raw); err != nil {
			_ = cmd.Close()
			return err
		}
		if err := cmd.Close(); err != nil {
			return err
		}
		_, err := cmd.Wait()
		return err
	})
}

func toUIDSet(uids []uint32) imap.UIDSet {
	list := make([]imap.UID, 0, len(uids))
	for _, u := range uids {
		list = append(list, imap.UID(u))
	}
	return imap.UIDSetNum(list...)
}

// Delimiter returns the hierarchy separator of the server ("/" if unknown).
func (m *IMAP) Delimiter(ctx context.Context) (string, error) {
	if m.folders == nil {
		if _, err := m.Folders(ctx); err != nil {
			return "", err
		}
	}
	for _, f := range m.folders {
		if f.Delim != "" {
			return f.Delim, nil
		}
	}
	return "/", nil
}

// CreateFolder creates a folder; parent may be empty for a top-level one.
func (m *IMAP) CreateFolder(ctx context.Context, parent, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", newError(CodeUnknown, "create", errors.New("empty folder name"))
	}
	full := name
	if parent != "" {
		delim, err := m.Delimiter(ctx)
		if err != nil {
			return "", err
		}
		if strings.Contains(name, delim) {
			return "", newError(CodeUnknown, "create", fmt.Errorf("folder name must not contain %q", delim))
		}
		full = parent + delim + name
	}
	m.folders = nil
	err := m.do(ctx, "create", func() error {
		if err := m.client.Create(full, nil).Wait(); err != nil {
			return err
		}
		// Some servers only show subscribed folders in other clients.
		_ = m.client.Subscribe(full).Wait()
		return nil
	})
	return full, err
}

// RenameFolder renames a folder in place, keeping its parent.
func (m *IMAP) RenameFolder(ctx context.Context, name, newName string) (string, error) {
	newName = strings.TrimSpace(newName)
	if newName == "" {
		return "", newError(CodeUnknown, "rename", errors.New("empty folder name"))
	}
	delim, err := m.Delimiter(ctx)
	if err != nil {
		return "", err
	}
	if strings.Contains(newName, delim) {
		return "", newError(CodeUnknown, "rename", fmt.Errorf("folder name must not contain %q", delim))
	}
	full := newName
	if i := strings.LastIndex(name, delim); i >= 0 {
		full = name[:i+len(delim)] + newName
	}
	if m.selected == name {
		m.selected = ""
		_ = m.do(ctx, "unselect", func() error { return m.client.Unselect().Wait() })
	}
	m.folders = nil
	err = m.do(ctx, "rename", func() error {
		if err := m.client.Rename(name, full, nil).Wait(); err != nil {
			return err
		}
		_ = m.client.Unsubscribe(name).Wait()
		_ = m.client.Subscribe(full).Wait()
		return nil
	})
	return full, err
}

// DeleteFolder removes a folder with its messages.
func (m *IMAP) DeleteFolder(ctx context.Context, name string) error {
	if m.selected == name {
		m.selected = ""
		_ = m.do(ctx, "unselect", func() error { return m.client.Unselect().Wait() })
	}
	m.folders = nil
	return m.do(ctx, "delete folder", func() error {
		_ = m.client.Unsubscribe(name).Wait()
		return m.client.Delete(name).Wait()
	})
}

// EnsureFolder returns the folder with the role, creating it under the
// given name when the server has none (e.g. "Спам" on a bare server).
func (m *IMAP) EnsureFolder(ctx context.Context, role, name string) (string, error) {
	folder, err := m.FolderByRole(ctx, role)
	if err != nil || folder != "" {
		return folder, err
	}
	return m.CreateFolder(ctx, "", name)
}

func allMessages() imap.SeqSet {
	var set imap.SeqSet
	set.AddRange(1, 0) // 1:*
	return set
}

// MarkAllSeen marks every message of the folder as read.
func (m *IMAP) MarkAllSeen(ctx context.Context, folder string) error {
	data, err := m.selectFolder(ctx, folder, false)
	if err != nil || data.NumMessages == 0 {
		return err
	}
	return m.do(ctx, "store", func() error {
		return m.client.Store(allMessages(), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}, nil).Close()
	})
}

// EmptyFolder deletes every message of the folder for good (Trash, Spam).
func (m *IMAP) EmptyFolder(ctx context.Context, folder string) error {
	data, err := m.selectFolder(ctx, folder, false)
	if err != nil || data.NumMessages == 0 {
		return err
	}
	return m.do(ctx, "empty", func() error {
		if err := m.client.Store(allMessages(), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return err
		}
		return m.client.Expunge().Close()
	})
}

// AppendDraft saves a draft and returns its UID when the server reports it
// (UIDPLUS), 0 otherwise.
func (m *IMAP) AppendDraft(ctx context.Context, folder string, raw []byte) (uint32, error) {
	var uid uint32
	err := m.do(ctx, "append", func() error {
		cmd := m.client.Append(folder, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagDraft, imap.FlagSeen}, Time: time.Now()})
		if _, err := cmd.Write(raw); err != nil {
			_ = cmd.Close()
			return err
		}
		if err := cmd.Close(); err != nil {
			return err
		}
		data, err := cmd.Wait()
		if err == nil && data != nil {
			uid = uint32(data.UID)
		}
		return err
	})
	return uid, err
}
