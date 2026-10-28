# Local patches

Copy of github.com/emersion/go-imap/v2 v2.0.0-beta.8 (MIT, see LICENSE),
used through a `replace` in the root go.mod.

- `imapclient/fetch.go`: `readBodyFldParam` and `readBodyFldLang` accept NIL
  where RFC 3501 wants a string. Mail.ru and VK WorkSpace answer
  BODYSTRUCTURE with parameters like `("boundary" NIL)`; the original parser
  failed the whole FETCH with `imapwire: expected string, got "N"`.

Drop the copy once upstream accepts NIL there.
