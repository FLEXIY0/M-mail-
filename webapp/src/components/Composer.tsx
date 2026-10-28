import React from 'react';

import {CloseIcon, PaperclipIcon, SendIcon, Spinner, TrashIcon} from './icons';
import {HtmlFrame} from './MessageView';
import RecipientPicker, {participantFromEmail} from './RecipientPicker';
import type {Participant} from './RecipientPicker';
import {ErrorCard} from './shared';
import {Callout, PanelPage} from './ui';

import {ApiError, api} from '../api';
import {addressFull, formatQuoteDate, formatSize, quoteText, subjectWith} from '../format';
import {SIGNATURE_CID, fitSize, isPortrait, signatureHTML, useSignatureImage} from '../signature';
import type {SignatureImageInfo} from '../signature';
import {closeCompose, hideToast, mailChanged, openCompose, showToast, useStore} from '../state';
import type {ComposeRequest} from '../state';
import type {Address, Attachment, Me, Message, OutgoingFile, Recipient, SendRequest} from '../types';

interface LocalFile {
    key: string;
    name: string;
    type: string;
    size: number;
    data?: string; // base64, filled when read
}

// Quote is the original message under a reply or a forward. It stays a
// separate block, like in mail apps: it can be removed or turned into
// editable text.
interface Quote {
    header: string;
    text: string;
    html?: string;
}

interface Draft {
    to: Participant[];
    cc: Participant[];
    bcc: Participant[];
    showCc: boolean;
    subject: string;
    text: string;
    files: LocalFile[];
    quote: Quote | null;
    forwardParts: string[];
    mmFiles: Array<{id: string; name: string; size: number}>;
    initialText: string;

    // The signature is a separate block under the text, so that it can
    // carry a picture and be removed with one click.
    signature: boolean;

    // Recipients or the subject were changed by the user.
    edited: boolean;
}

// Drafts survive closing the panel: the composer remounts with them.
const drafts = new Map<string, Draft>();

// Errors of a send that failed after the composer was closed.
const sendErrors = new Map<string, ApiError>();

// "Undo send": the message waits a few seconds before it goes out.
const UNDO_SECONDS = 5;

function scheduleSend(request: ComposeRequest, req: SendRequest) {
    const id = request.id || 'default';
    let cancelled = false;
    const timer = window.setTimeout(async () => {
        if (cancelled) {
            return;
        }
        hideToast(toastId);
        try {
            await api.send(req);
            drafts.delete(id);
            showToast('Письмо отправлено');
            mailChanged();
        } catch (e) {
            // The draft is still there: open it again with the error.
            sendErrors.set(id, e as ApiError);
            openCompose(request);
            showToast('Письмо не отправлено', {kind: 'error'});
        }
    }, UNDO_SECONDS * 1000);
    const toastId = showToast('Отправка письма…', {
        ms: (UNDO_SECONDS * 1000) + 500,
        countdown: UNDO_SECONDS * 1000,
        action: {
            label: 'Отменить',
            run: () => {
                cancelled = true;
                window.clearTimeout(timer);
                hideToast(toastId);
                openCompose(request);
            },
        },
    });
}

function toParticipants(list: Address[], exclude: Set<string>): Participant[] {
    const out: Participant[] = [];
    for (const a of list) {
        const key = a.email.toLowerCase();
        if (exclude.has(key) || out.some((p) => p.email === key)) {
            continue;
        }
        out.push(participantFromEmail(a.email, a.name));
    }
    return out;
}

function toRecipients(list: Participant[]): Recipient[] {
    return list.map((p) => (p.userId ? {user_id: p.userId} : {email: p.email, name: p.sublabel ? p.label : undefined}));
}

function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function escapeHTML(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHTML(text: string) {
    return escapeHTML(text).replace(/\r?\n/g, '<br>');
}

// quoteHTMLOf turns a whole HTML document into a fragment that can be put
// into a blockquote: the body with its own style, the styles of the head,
// no scripts or document-level tags that would restyle the reply itself.
export function quoteHTMLOf(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, form, meta, link, base, title').forEach((el) => el.remove());
    doc.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
            if (attr.name.toLowerCase().startsWith('on')) {
                el.removeAttribute(attr.name);
            }
        }
    });
    const styles = Array.from(doc.querySelectorAll('style')).map((el) => {
        el.remove();
        return el.outerHTML;
    }).join('');
    const bodyStyle = doc.body.getAttribute('style') || '';
    const wrapper = doc.createElement('div');
    if (bodyStyle) {
        wrapper.setAttribute('style', bodyStyle);
    }
    wrapper.innerHTML = doc.body.innerHTML;
    return styles + wrapper.outerHTML;
}

function quotedText(q: Quote, forward: boolean) {
    return forward ? `${q.header}\n\n${q.text}` : `${q.header}\n${quoteText(q.text)}`;
}

// buildDraft prepares the fields of a new message, a reply or a forward.
function buildDraft(req: ComposeRequest, original: Message | null, me: Me): Draft {
    const own = new Set([(me.email || '').toLowerCase(), (me.username || '').toLowerCase()]);
    const hasSignature = Boolean((me.settings?.signature || '').trim() || me.settings?.signature_image);
    const draft: Draft = {to: [], cc: [], bcc: [], showCc: false, subject: req.subject || '', text: req.text || '', files: [], quote: null, forwardParts: [], mmFiles: req.mattermostFiles || [], initialText: '', signature: hasSignature, edited: false};

    if (req.to) {
        draft.to = req.to.filter((r) => r.email).map((r) => participantFromEmail(r.email || '', r.name));
    }
    if (original && (req.mode === 'reply' || req.mode === 'reply_all')) {
        const replyTo = original.reply_to.length ? original.reply_to : original.from;

        // Replying to one's own message (e.g. from "Sent") goes to its recipients.
        const fromSelf = replyTo.every((a) => own.has(a.email.toLowerCase()));
        draft.to = toParticipants(fromSelf ? original.to : replyTo, req.mode === 'reply_all' ? own : new Set());
        if (req.mode === 'reply_all') {
            const taken = new Set([...own, ...draft.to.map((p) => p.email || '')]);
            draft.cc = toParticipants([...(fromSelf ? [] : original.to), ...original.cc], taken);
            draft.showCc = draft.cc.length > 0;
        }
        draft.subject = subjectWith('Re', original.subject);
        const author = original.from[0] ? addressFull(original.from[0]) : '';
        draft.quote = {header: `${formatQuoteDate(original.date)} от ${author}:`, text: original.text || '', html: original.html};
    } else if (original && req.mode === 'forward') {
        draft.subject = subjectWith('Fwd', original.subject);
        const head = [
            '-------- Пересылаемое сообщение --------',
            `От: ${original.from.map(addressFull).join(', ')}`,
            `Дата: ${formatQuoteDate(original.date)}`,
            `Тема: ${original.subject}`,
            `Кому: ${original.to.map(addressFull).join(', ')}`,
        ];
        if (original.cc.length) {
            head.push(`Копия: ${original.cc.map(addressFull).join(', ')}`);
        }
        draft.quote = {header: head.join('\n'), text: original.text || '', html: original.html};
        draft.forwardParts = (original.attachments || []).filter((a) => !a.inline).map((a) => a.part);
    } else if (original && req.mode === 'draft') {
        // A saved draft already has its signature and quote in the text.
        draft.to = toParticipants(original.to, new Set());
        draft.cc = toParticipants(original.cc, new Set());
        draft.bcc = toParticipants(original.bcc || [], new Set());
        draft.showCc = draft.cc.length + draft.bcc.length > 0;
        draft.subject = original.subject;
        draft.forwardParts = (original.attachments || []).filter((a) => !a.inline && a.content_id !== SIGNATURE_CID).map((a) => a.part);

        // The signature at the end goes back into its own block, with the
        // picture; a quote below it stays in the text.
        const text = (original.text || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
        const sig = (me.settings?.signature || '').trim();
        const at = sig ? text.lastIndexOf(`\n\n${sig}`) : -1;
        if (at >= 0 && text.slice(at + sig.length + 2).trim() === '') {
            draft.text = text.slice(0, at);
        } else {
            draft.text = text;
            draft.signature = false;
        }
    }
    draft.initialText = draft.text;
    return draft;
}

export default function ComposerRoot({request}: {request: ComposeRequest}) {
    const me = useStore((s) => s.me);
    const config = useStore((s) => s.config);
    if (!me || !config) {
        return <div className='mml-center'><Spinner size={24}/></div>;
    }
    if (!me.connected) {
        return (
            <PanelPage
                title='Новое письмо'
                onClose={closeCompose}
                icon='close'
            >
                <Callout
                    kind='info'
                    title='Почта не подключена'
                >
                    {'Подключите почту, и можно будет отправлять письма прямо из Mattermost.'}
                </Callout>
            </PanelPage>
        );
    }
    return (
        <Composer
            request={request}
            me={me}
            maxBytes={config.max_attachment_bytes}
        />
    );
}

function Composer({request, me, maxBytes}: {request: ComposeRequest; me: Me; maxBytes: number}) {
    const id = request.id || 'default';
    const needsOriginal = Boolean(request.source && request.mode !== 'new');
    const [original, setOriginal] = React.useState<Message | null>(null);
    const [loadError, setLoadError] = React.useState<ApiError | null>(null);
    const [draft, setDraftState] = React.useState<Draft | null>(() => drafts.get(id) || (needsOriginal ? null : buildDraft(request, null, me)));
    const [sending, setSending] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<ApiError | null>(() => sendErrors.get(id) || null);
    const sigImage = useSignatureImage(me.settings);
    const [dragOver, setDragOver] = React.useState(false);
    const fileInput = React.useRef<HTMLInputElement>(null);
    const textRef = React.useRef<HTMLTextAreaElement>(null);

    const setDraft = (fn: (prev: Draft) => Draft) => {
        setDraftState((prev) => {
            if (!prev) {
                return prev;
            }
            const next = fn(prev);
            drafts.set(id, next);
            return next;
        });
    };
    const update = (patch: Partial<Draft>) => setDraft((prev) => ({...prev, ...patch}));

    React.useEffect(() => {
        if (!needsOriginal || !request.source) {
            return;
        }
        api.message(request.source.folder, request.source.uid, true).
            then((m) => {
                setOriginal(m);
                if (!drafts.has(id)) {
                    const d = buildDraft(request, m, me);
                    drafts.set(id, d);
                    setDraftState(d);
                }
            }).
            catch((e: ApiError) => setLoadError(e));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Replies start above the quote and the signature, like in mail apps.
    React.useEffect(() => {
        if (draft && request.mode !== 'new' && textRef.current) {
            textRef.current.focus();
            textRef.current.setSelectionRange(0, 0);
        }
    }, [Boolean(draft)]); // eslint-disable-line react-hooks/exhaustive-deps

    // The text area grows with the text; the panel scrolls.
    React.useLayoutEffect(() => {
        const el = textRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.max(el.scrollHeight, 160)}px`;
        }
    }, [draft?.text]);

    if (!draft) {
        return (
            <PanelPage
                title={{forward: 'Пересылка', draft: 'Черновик'}[request.mode as string] || 'Ответ'}
                onClose={closeCompose}
                icon='close'
            >
                {loadError ? (
                    <ErrorCard
                        error={loadError}
                        compact={true}
                    />
                ) : <div className='mml-center'><Spinner size={24}/></div>}
            </PanelPage>
        );
    }

    const forward = request.mode === 'forward';
    const forwarded: Attachment[] = original && (forward || request.mode === 'draft') ? (original.attachments || []).filter((a) => !a.inline) : [];
    const forwardSet = new Set(draft.forwardParts);
    const totalBytes = draft.files.reduce((n, f) => n + f.size, 0) +
        forwarded.filter((a) => forwardSet.has(a.part)).reduce((n, a) => n + a.size, 0) +
        draft.mmFiles.reduce((n, f) => n + f.size, 0);
    const tooLarge = totalBytes > maxBytes;
    const dirty = draft.text !== draft.initialText || draft.files.length > 0 || draft.edited;
    const reading = draft.files.some((f) => !f.data);
    const signatureText = (me.settings?.signature || '').trim();
    const layout = me.settings?.signature_layout || 'left';
    const withSignature = draft.signature && Boolean(signatureText || sigImage);

    const forget = () => {
        drafts.delete(id);
        sendErrors.delete(id);
        closeCompose();
    };

    // Closing keeps the message in "Черновики", like mail apps do.
    const close = async () => {
        if (!dirty || sending || saving) {
            if (!saving) {
                forget();
            }
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await api.saveDraft(buildRequest());
            forget();
            showToast('Черновик сохранён');
            mailChanged();
        } catch (e) {
            setError(e as ApiError);
            setSaving(false);
        }
    };

    const discard = async () => {
        // eslint-disable-next-line no-alert
        if (dirty && !window.confirm('Удалить черновик?')) {
            return;
        }
        if (request.mode === 'draft' && request.source) {
            try {
                await api.remove(request.source.folder, [request.source.uid]);
                mailChanged();
            } catch (e) {
                setError(e as ApiError);
                return;
            }
        }
        forget();
    };

    const addFiles = async (list: FileList | null) => {
        if (!list || !list.length) {
            return;
        }
        const files = Array.from(list);
        const added: LocalFile[] = files.map((f, i) => ({key: `${Date.now()}-${i}-${f.name}`, name: f.name, type: f.type, size: f.size}));
        setDraft((prev) => ({...prev, files: [...prev.files, ...added]}));
        await Promise.all(files.map(async (f, i) => {
            try {
                const data = await readAsBase64(f);
                setDraft((prev) => ({...prev, files: prev.files.map((p) => (p.key === added[i].key ? {...p, data} : p))}));
            } catch {
                setDraft((prev) => ({...prev, files: prev.files.filter((p) => p.key !== added[i].key)}));
            }
        }));
    };

    // The text goes as is, plus the quote: as "> " lines in the text
    // version and with its formatting in the HTML version.
    // The HTML version is needed for a quote with formatting or a picture
    // in the signature; otherwise the message stays plain text.
    const buildBody = () => {
        const q = draft.quote;
        const own = draft.text.replace(/\s+$/, '');
        const sigText = withSignature && signatureText ? `\n\n${signatureText}` : '';
        const sigImg = withSignature && sigImage ? sigImage : null;
        const text = own + sigText + (q ? `\n\n${quotedText(q, forward)}` : '');
        if (!q && !sigImg) {
            return {text, html: '', image: false};
        }
        let html = `<div>${textToHTML(own)}</div>`;
        if (withSignature) {
            html += signatureHTML(signatureText, layout, sigImg);
        }
        if (q) {
            const quoteHTML = q.html ? quoteHTMLOf(q.html) : textToHTML(q.text);
            html += '<br>' +
                `<div>${textToHTML(q.header)}</div>` +
                (forward ? `<div>${quoteHTML}</div>` : `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #0077ff;padding-left:1ex">${quoteHTML}</blockquote>`);
        }
        return {text, html, image: Boolean(sigImg)};
    };

    const buildRequest = (): SendRequest => {
        const attachments: OutgoingFile[] = draft.files.filter((f) => f.data).map((f) => ({filename: f.name, content_type: f.type || 'application/octet-stream', data: f.data || ''}));
        const body = buildBody();
        const req: SendRequest = {
            to: toRecipients(draft.to),
            cc: toRecipients(draft.cc),
            bcc: toRecipients(draft.bcc),
            subject: draft.subject.trim(),
            text: body.text,
            html: body.html || undefined,
            signature_image: body.image || undefined,
            attachments,
            mattermost_files: draft.mmFiles.map((f) => f.id),
        };
        if (request.source && (request.mode === 'reply' || request.mode === 'reply_all')) {
            req.reply_to = request.source;
        }
        if (request.source && (forward || request.mode === 'draft')) {
            req.forward = request.source;
            req.forward_parts = draft.forwardParts;
        }
        if (request.source && request.mode === 'draft') {
            req.draft_of = request.source;
        }
        return req;
    };

    const send = () => {
        if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
            setError(new ApiError('invalid_message', 'Укажите хотя бы одного получателя.', 'Укажите хотя бы одного получателя.', 400));
            return;
        }
        // eslint-disable-next-line no-alert
        if (!draft.subject.trim() && !window.confirm('Отправить письмо без темы?')) {
            return;
        }
        setSending(true);
        sendErrors.delete(id);
        scheduleSend(request, buildRequest());
        closeCompose();
    };

    const sendButton = (
        <button
            type='button'
            className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain mml-composer__send'
            title='Отправить (Ctrl+Enter)'
            aria-label='Отправить'
            disabled={sending || saving || reading || tooLarge}
            onClick={send}
        >
            {sending ? <Spinner size={18}/> : <SendIcon size={22}/>}
        </button>
    );
    const headerActions = (
        <>
            <button
                type='button'
                className='mml-icon-btn mml-icon-btn--lg'
                title='Удалить черновик'
                aria-label='Удалить черновик'
                disabled={sending || saving}
                onClick={discard}
            >
                <TrashIcon size={18}/>
            </button>
            {sendButton}
        </>
    );

    return (
        <PanelPage
            title={<span className='mml-ellipsis'>{me.email}</span>}
            onClose={close}
            closeLabel={dirty ? 'Сохранить черновик и закрыть' : 'Закрыть письмо'}
            icon={saving ? 'spinner' : 'close'}
            actions={headerActions}
            className='mml-page--composer'
        >
            <div
                className={`mml-composer ${dragOver ? 'mml-composer--drag' : ''}`}
                onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('Files')) {
                        e.preventDefault();
                        setDragOver(true);
                    }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                    if (e.dataTransfer.files.length) {
                        e.preventDefault();
                        setDragOver(false);
                        addFiles(e.dataTransfer.files);
                    }
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        send();
                    }
                }}
            >
                <div className='mml-composer__row'>
                    <span className='mml-composer__label'>{'Кому:'}</span>
                    <RecipientPicker
                        value={draft.to}
                        onChange={(to) => update({to, edited: true})}
                        disabled={sending}
                        autoFocus={request.mode === 'new' || forward}
                        placeholder=''
                    />
                </div>
                {draft.showCc ? (
                    <>
                        <div className='mml-composer__row'>
                            <span className='mml-composer__label'>{'Копия:'}</span>
                            <RecipientPicker
                                value={draft.cc}
                                onChange={(cc) => update({cc, edited: true})}
                                disabled={sending}
                                placeholder=''
                            />
                        </div>
                        <div className='mml-composer__row'>
                            <span
                                className='mml-composer__label'
                                title='Получатели скрытой копии не видны остальным'
                            >
                                {'Скр. копия:'}
                            </span>
                            <RecipientPicker
                                value={draft.bcc}
                                onChange={(bcc) => update({bcc, edited: true})}
                                disabled={sending}
                                placeholder=''
                            />
                        </div>
                    </>
                ) : (
                    <button
                        type='button'
                        className='mml-composer__row mml-composer__row--button'
                        onClick={() => update({showCc: true})}
                    >
                        <span className='mml-composer__label'>{'Копия/Скр. копия:'}</span>
                    </button>
                )}
                <div className='mml-composer__row'>
                    <span className='mml-composer__label'>{'Тема:'}</span>
                    <input
                        className='mml-composer__subject'
                        value={draft.subject}
                        maxLength={500}
                        disabled={sending}
                        aria-label='Тема'
                        onChange={(e) => update({subject: e.target.value, edited: true})}
                    />
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--accent-plain'
                        title='Прикрепить файл'
                        aria-label='Прикрепить файл'
                        disabled={sending}
                        onClick={() => fileInput.current?.click()}
                    >
                        <PaperclipIcon size={20}/>
                    </button>
                    <input
                        ref={fileInput}
                        type='file'
                        multiple={true}
                        style={{display: 'none'}}
                        onChange={(e) => {
                            addFiles(e.target.files);
                            e.target.value = '';
                        }}
                    />
                </div>

                {(forwarded.length > 0 || draft.mmFiles.length > 0 || draft.files.length > 0) && (
                    <div className='mml-composer__files'>
                        {forwarded.map((a) => (
                            <label
                                key={a.part}
                                className={`mml-file ${forwardSet.has(a.part) ? '' : 'mml-file--off'}`}
                            >
                                <input
                                    type='checkbox'
                                    checked={forwardSet.has(a.part)}
                                    onChange={() => {
                                        const next = new Set(forwardSet);
                                        if (next.has(a.part)) {
                                            next.delete(a.part);
                                        } else {
                                            next.add(a.part);
                                        }
                                        update({forwardParts: Array.from(next)});
                                    }}
                                />
                                <PaperclipIcon size={13}/>
                                <span className='mml-ellipsis'>{a.filename}</span>
                                <span className='mml-muted mml-small'>{formatSize(a.size)}</span>
                            </label>
                        ))}
                        {draft.mmFiles.map((f) => (
                            <span
                                key={f.id}
                                className='mml-file'
                            >
                                <PaperclipIcon size={13}/>
                                <span className='mml-ellipsis'>{f.name}</span>
                                <span className='mml-muted mml-small'>{formatSize(f.size)}</span>
                                <button
                                    type='button'
                                    className='mml-icon-btn'
                                    aria-label={`Убрать ${f.name}`}
                                    onClick={() => update({mmFiles: draft.mmFiles.filter((x) => x.id !== f.id)})}
                                >
                                    <CloseIcon size={12}/>
                                </button>
                            </span>
                        ))}
                        {draft.files.map((f) => (
                            <span
                                key={f.key}
                                className='mml-file'
                            >
                                {f.data ? <PaperclipIcon size={13}/> : <Spinner size={13}/>}
                                <span className='mml-ellipsis'>{f.name}</span>
                                <span className='mml-muted mml-small'>{formatSize(f.size)}</span>
                                <button
                                    type='button'
                                    className='mml-icon-btn'
                                    aria-label={`Убрать ${f.name}`}
                                    onClick={() => update({files: draft.files.filter((x) => x.key !== f.key)})}
                                >
                                    <CloseIcon size={12}/>
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                {tooLarge && <div className='mml-hint mml-hint--warn mml-composer__pad'>{`Вложения больше ${formatSize(maxBytes)} — почтовый сервер такое письмо не примет.`}</div>}

                <textarea
                    ref={textRef}
                    className='mml-composer__text'
                    value={draft.text}
                    disabled={sending}
                    placeholder='Текст письма'
                    aria-label='Текст письма'
                    onChange={(e) => update({text: e.target.value})}
                />

                {withSignature && (
                    <SignatureBlock
                        text={signatureText}
                        image={sigImage}
                        layout={layout}
                        onRemove={() => update({signature: false})}
                    />
                )}

                {draft.quote && (
                    <div className='mml-quote'>
                        <div className='mml-quote__actions'>
                            <button
                                type='button'
                                className='mml-link'
                                onClick={() => {
                                    const q = draft.quote;
                                    if (q) {
                                        update({text: `${draft.text.replace(/\s+$/, '')}\n\n${quotedText(q, forward)}`, quote: null});
                                    }
                                }}
                            >
                                {'Редактировать'}
                            </button>
                            <button
                                type='button'
                                className='mml-link'
                                onClick={() => update({quote: null})}
                            >
                                {'Удалить'}
                            </button>
                        </div>
                        <div className='mml-quote__header'>{draft.quote.header}</div>
                        <div className={forward ? 'mml-quote__body mml-quote__body--forward' : 'mml-quote__body'}>
                            {draft.quote.html ? (
                                <HtmlFrame
                                    html={draft.quote.html}
                                    allowRemote={Boolean(me.settings?.load_images)}
                                />
                            ) : <div className='mml-reader__text'>{draft.quote.text}</div>}
                        </div>
                    </div>
                )}

                {error && (
                    <div className='mml-composer__pad'>
                        <ErrorCard
                            error={error}
                            compact={true}
                        />
                    </div>
                )}
            </div>
        </PanelPage>
    );
}

function SignatureBlock({text, image, layout, onRemove}: {text: string; image: SignatureImageInfo | null; layout: 'left' | 'above'; onRemove: () => void}) {
    const size = image && fitSize(image, layout);
    return (
        <div className='mml-composer__signature'>
            <div className={`mml-sig-preview mml-sig-preview--${layout}`}>
                {image && size && (
                    <img
                        src={image.url}
                        alt=''
                        style={{width: size.width, height: size.height, borderRadius: isPortrait(image, layout) ? '50%' : 6}}
                    />
                )}
                {text && <span className='mml-sig-preview__text'>{text}</span>}
            </div>
            <button
                type='button'
                className='mml-icon-btn'
                title='Убрать подпись из этого письма'
                aria-label='Убрать подпись'
                onClick={onRemove}
            >
                <CloseIcon size={14}/>
            </button>
        </div>
    );
}
