package mailclient

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-smtp"
)

// Code is a machine readable error category. The webapp maps every code to a
// human explanation with concrete next steps, so the set of codes is part of
// the plugin API and must stay stable.
type Code string

const (
	CodeUnauthorized   Code = "unauthorized"    // wrong login or app password
	CodeDisabled       Code = "imap_disabled"   // the provider says IMAP/SMTP access is turned off
	CodeNetwork        Code = "network"         // DNS / connection problems
	CodeTimeout        Code = "timeout"         // server did not answer in time
	CodeTLS            Code = "tls"             // certificate or handshake problems
	CodeServer         Code = "server"          // the server answered with an unexpected error
	CodeInvalidServer  Code = "invalid_server"  // the server address can not be parsed
	CodeBlockedAddress Code = "blocked_address" // the address points into a private network that is not allowed
	CodeNotFound       Code = "not_found"       // folder or message does not exist (any more)
	CodeRejected       Code = "rejected"        // SMTP refused a recipient or the message
	CodeTooLarge       Code = "too_large"       // the message is bigger than the server accepts
	CodeUnknown        Code = "unknown"
)

// Error is returned by every client function. It carries a stable Code for
// the UI and the technical details for logs and the "details" section.
type Error struct {
	Code Code
	Op   string
	Err  error
}

func (e *Error) Error() string {
	if e.Op != "" {
		return fmt.Sprintf("mail %s (%s): %v", e.Code, e.Op, e.Err)
	}
	return fmt.Sprintf("mail %s: %v", e.Code, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// CodeOf extracts the error category from any error returned by this package.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var merr *Error
	if errors.As(err, &merr) {
		return merr.Code
	}
	return CodeUnknown
}

// IsAuth reports whether the error means the stored credentials are no longer
// accepted. Such errors must stop background checks, otherwise we would keep
// hammering the provider with a bad password and get the account locked.
func IsAuth(err error) bool {
	code := CodeOf(err)
	return code == CodeUnauthorized || code == CodeDisabled
}

// IsTransient reports whether the operation may succeed if simply retried on
// a fresh connection.
func IsTransient(err error) bool {
	switch CodeOf(err) {
	case CodeNetwork, CodeTimeout:
		return true
	}
	return false
}

func newError(code Code, op string, err error) *Error {
	return &Error{Code: code, Op: op, Err: err}
}

// disabledHints are phrases providers use when the password is right but
// access from mail programs is switched off in the mailbox settings.
var disabledHints = []string{
	"imap is disabled",
	"imap access is disabled",
	"imap disabled",
	"access from mail clients",
	"почтовых программ",
	"not allowed to use imap",
	"web login required",
}

// classify turns any low level error into an *Error.
func classify(op string, err error) *Error {
	if err == nil {
		return nil
	}
	var merr *Error
	if errors.As(err, &merr) {
		return merr
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return newError(CodeTimeout, op, err)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return newError(CodeTimeout, op, err)
	}
	var blocked *blockedError
	if errors.As(err, &blocked) {
		return newError(CodeBlockedAddress, op, err)
	}
	var certErr *x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var invalidErr x509.CertificateInvalidError
	var recordErr tls.RecordHeaderError
	if errors.As(err, &certErr) || errors.As(err, &hostErr) || errors.As(err, &invalidErr) || errors.As(err, &recordErr) {
		return newError(CodeTLS, op, err)
	}
	var imapErr *imap.Error
	if errors.As(err, &imapErr) {
		return classifyIMAP(op, imapErr)
	}
	var smtpErr *smtp.SMTPError
	if errors.As(err, &smtpErr) {
		return classifySMTP(op, smtpErr)
	}
	var opErr *net.OpError
	var dnsErr *net.DNSError
	if errors.As(err, &opErr) || errors.As(err, &dnsErr) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return newError(CodeNetwork, op, err)
	}
	if strings.Contains(err.Error(), "tls:") {
		return newError(CodeTLS, op, err)
	}
	return newError(CodeUnknown, op, err)
}

func classifyIMAP(op string, err *imap.Error) *Error {
	text := strings.ToLower(err.Text)
	for _, hint := range disabledHints {
		if strings.Contains(text, hint) {
			return newError(CodeDisabled, op, err)
		}
	}
	switch err.Code {
	case imap.ResponseCodeAuthenticationFailed, imap.ResponseCodeAuthorizationFailed, imap.ResponseCodeExpired, imap.ResponseCodePrivacyRequired:
		return newError(CodeUnauthorized, op, err)
	case imap.ResponseCodeNonExistent, imap.ResponseCodeTryCreate:
		return newError(CodeNotFound, op, err)
	case imap.ResponseCodeTooBig, imap.ResponseCodeOverQuota, imap.ResponseCodeLimit:
		return newError(CodeTooLarge, op, err)
	case imap.ResponseCodeUnavailable, imap.ResponseCodeServerBug:
		return newError(CodeServer, op, err)
	}
	if op == "login" && err.Type == imap.StatusResponseTypeNo {
		return newError(CodeUnauthorized, op, err)
	}
	return newError(CodeServer, op, err)
}

func classifySMTP(op string, err *smtp.SMTPError) *Error {
	text := strings.ToLower(err.Message)
	for _, hint := range disabledHints {
		if strings.Contains(text, hint) {
			return newError(CodeDisabled, op, err)
		}
	}
	switch {
	case err.Code == 535 || err.Code == 534 || err.Code == 530 || err.Code == 454 && op == "smtp auth":
		return newError(CodeUnauthorized, op, err)
	case err.Code == 552 || err.Code == 523:
		return newError(CodeTooLarge, op, err)
	case err.Code >= 550 && err.Code <= 554:
		return newError(CodeRejected, op, err)
	case err.Code >= 400 && err.Code < 500:
		return newError(CodeServer, op, err)
	}
	return newError(CodeServer, op, err)
}

type blockedError struct {
	host string
}

func (e *blockedError) Error() string {
	return fmt.Sprintf("address %s points into a private network, which is not allowed by the plugin settings", e.host)
}
