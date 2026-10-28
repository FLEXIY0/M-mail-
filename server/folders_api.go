package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // signature pictures
	_ "image/jpeg" // signature pictures
	_ "image/png"  // signature pictures
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/FLEXIY0/M-mail-/server/mailclient"
	"github.com/FLEXIY0/M-mail-/server/store"
)

const (
	maxFolderName      = 100
	maxSignatureImage  = 300 << 10
	maxSignatureSide   = 2000
	signatureBodyLimit = maxSignatureImage*4/3 + 1024
	codeFolderReserved = "folder_reserved"
)

func init() {
	errorMessages[codeFolderReserved] = "Системные папки нельзя переименовать или удалить."
}

type folderRequest struct {
	Name    string `json:"name"`
	Parent  string `json:"parent"`
	NewName string `json:"new_name"`
	Folder  string `json:"folder"`
}

func cleanFolderName(name string) (string, error) {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name))
	if name == "" {
		return "", errors.New("введите название папки")
	}
	if utf8.RuneCountInString(name) > maxFolderName {
		return "", fmt.Errorf("название длиннее %d символов", maxFolderName)
	}
	if strings.EqualFold(name, "INBOX") {
		return "", errors.New("такое название зарезервировано")
	}
	return name, nil
}

// userFolder finds a folder the user may rename or delete: not Inbox and
// not a special folder.
func userFolder(ctx context.Context, conn *mailclient.IMAP, name string) error {
	folders, err := conn.Folders(ctx)
	if err != nil {
		return err
	}
	for _, f := range folders {
		if f.Name == name {
			if f.Role != "" {
				return errReservedFolder
			}
			return nil
		}
	}
	return &mailclient.Error{Code: mailclient.CodeNotFound, Op: "folder", Err: fmt.Errorf("folder %q not found", name)}
}

var errReservedFolder = errors.New("reserved folder")

func (p *Plugin) writeFolderError(w http.ResponseWriter, err error) {
	if errors.Is(err, errReservedFolder) {
		writeError(w, http.StatusBadRequest, codeFolderReserved, "")
		return
	}
	writeMailError(w, err)
}

// folderOp decodes the request and runs fn on the user's connection. It
// reports whether fn succeeded, after the connection is released.
func (p *Plugin) folderOp(w http.ResponseWriter, r *http.Request, fn func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error)) bool {
	userID := userIDFrom(r)
	var req folderRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return false
	}
	account := p.accountFor(w, userID)
	if account == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	var result map[string]any
	err := p.withIMAP(ctx, userID, account, true, func(conn *mailclient.IMAP) error {
		var err error
		result, err = fn(ctx, conn, &req)
		return err
	})
	if err != nil {
		p.writeFolderError(w, err)
		return false
	}
	if result == nil {
		result = map[string]any{}
	}
	result["ok"] = true
	p.publish(userID, wsMailUpdated, nil)
	writeJSON(w, http.StatusOK, result)
	return true
}

// POST /folders/create {name, parent}
func (p *Plugin) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	p.folderOp(w, r, func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error) {
		name, err := cleanFolderName(req.Name)
		if err != nil {
			return nil, &mailclient.Error{Code: mailclient.CodeInvalidServer, Op: "create", Err: err}
		}
		full, err := conn.CreateFolder(ctx, req.Parent, name)
		return map[string]any{"name": full}, err
	})
}

// POST /folders/rename {name, new_name}
func (p *Plugin) handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	var oldName, newName, delim string
	ok := p.folderOp(w, r, func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error) {
		name, err := cleanFolderName(req.NewName)
		if err != nil {
			return nil, &mailclient.Error{Code: mailclient.CodeInvalidServer, Op: "rename", Err: err}
		}
		if err = userFolder(ctx, conn, req.Name); err != nil {
			return nil, err
		}
		if delim, err = conn.Delimiter(ctx); err != nil {
			return nil, err
		}
		oldName = req.Name
		newName, err = conn.RenameFolder(ctx, req.Name, name)
		return map[string]any{"name": newName}, err
	})
	if ok {
		// Sorting rules follow the folder to its new name.
		p.folderRenamed(userIDFrom(r), oldName, newName, delim)
	}
}

// POST /folders/delete {name}
func (p *Plugin) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	var name, delim string
	ok := p.folderOp(w, r, func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error) {
		if err := userFolder(ctx, conn, req.Name); err != nil {
			return nil, err
		}
		var err error
		if delim, err = conn.Delimiter(ctx); err != nil {
			return nil, err
		}
		name = req.Name
		return nil, conn.DeleteFolder(ctx, req.Name)
	})
	if ok {
		p.folderDeleted(userIDFrom(r), name, delim)
	}
}

// POST /folders/read {folder} — "Прочитать все".
func (p *Plugin) handleReadAll(w http.ResponseWriter, r *http.Request) {
	p.folderOp(w, r, func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error) {
		return nil, conn.MarkAllSeen(ctx, req.Folder)
	})
}

// POST /folders/empty {folder} — empties Trash or Spam.
func (p *Plugin) handleEmptyFolder(w http.ResponseWriter, r *http.Request) {
	p.folderOp(w, r, func(ctx context.Context, conn *mailclient.IMAP, req *folderRequest) (map[string]any, error) {
		folders, err := conn.Folders(ctx)
		if err != nil {
			return nil, err
		}
		for _, f := range folders {
			if f.Name == req.Folder {
				// Emptying is offered only where messages are already
				// thrown away; anything else is a forged request.
				if f.Role != mailclient.RoleTrash && f.Role != mailclient.RoleJunk {
					return nil, errReservedFolder
				}
				return nil, conn.EmptyFolder(ctx, f.Name)
			}
		}
		return nil, &mailclient.Error{Code: mailclient.CodeNotFound, Op: "empty", Err: fmt.Errorf("folder %q not found", req.Folder)}
	})
}

// imageKind reads "photo" (the default) or "logo".
func imageKind(kind string) string {
	if kind == store.ImageLogo {
		return store.ImageLogo
	}
	return store.ImagePhoto
}

// GET /signature-image?kind=photo|logo
func (p *Plugin) handleGetSignatureImage(w http.ResponseWriter, r *http.Request) {
	img, err := p.store.GetSignatureImage(userIDFrom(r), imageKind(r.URL.Query().Get("kind")))
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if img == nil {
		writeError(w, http.StatusNotFound, codeBadRequest, "no signature image")
		return
	}
	w.Header().Set("Content-Type", img.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(img.Data)))
	_, _ = w.Write(img.Data)
}

// decodeImageDataURL accepts "data:image/png;base64,…" with a real PNG,
// JPEG or GIF picture of a sensible size.
func decodeImageDataURL(raw string) (*store.SignatureImage, error) {
	head, payload, ok := strings.Cut(raw, ",")
	if !ok || !strings.HasPrefix(head, "data:") || !strings.HasSuffix(head, ";base64") {
		return nil, errors.New("ожидается картинка в формате data URL")
	}
	contentType := strings.TrimSuffix(strings.TrimPrefix(head, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, errors.New("картинка повреждена")
	}
	if len(data) > maxSignatureImage {
		return nil, fmt.Errorf("картинка больше %d КБ", maxSignatureImage>>10)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("поддерживаются PNG, JPEG и GIF")
	}
	if cfg.Width > maxSignatureSide || cfg.Height > maxSignatureSide {
		return nil, errors.New("картинка слишком большая")
	}
	if want := "image/" + format; contentType != want {
		contentType = want
	}
	return &store.SignatureImage{ContentType: contentType, Data: data}, nil
}

// PUT /signature-image {data_url, kind}
func (p *Plugin) handlePutSignatureImage(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r)
	var req struct {
		DataURL string `json:"data_url"`
		Kind    string `json:"kind"`
	}
	if err := decodeLimited(r, &req, signatureBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidMessage, "картинка больше 300 КБ")
		return
	}
	img, err := decodeImageDataURL(req.DataURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidMessage, err.Error())
		return
	}
	p.setSignatureImage(w, userID, imageKind(req.Kind), img)
}

// POST /signature-image/delete {kind}
func (p *Plugin) handleDeleteSignatureImage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind string `json:"kind"`
	}
	// An empty body means the photo, as before logos existed.
	_ = decodeBody(r, &req)
	p.setSignatureImage(w, userIDFrom(r), imageKind(req.Kind), nil)
}

func (p *Plugin) setSignatureImage(w http.ResponseWriter, userID, kind string, img *store.SignatureImage) {
	account := p.accountFor(w, userID)
	if account == nil {
		return
	}
	if err := p.store.SaveSignatureImage(userID, kind, img); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	if kind == store.ImageLogo {
		account.Settings.SignatureLogo = img != nil
	} else {
		account.Settings.SignatureImage = img != nil
	}
	if err := p.store.SaveAccount(userID, account); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	me, err := p.buildMe(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "")
		return
	}
	writeJSON(w, http.StatusOK, me)
}
