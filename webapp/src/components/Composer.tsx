import React from 'react';

import {CloseIcon, PaperclipIcon, SendIcon, Spinner} from './icons';
import RecipientPicker, {participantFromEmail} from './RecipientPicker';
import type {Participant} from './RecipientPicker';
import {ErrorCard} from './shared';
import {Button, Callout, Modal} from './ui';

import {ApiError, api} from '../api';
import {addressFull, formatSize, quoteText, subjectWith} from '../format';
import {closeCompose, mailChanged, useStore} from '../state';
import type {ComposeRequest} from '../state';
import type {Address, Attachment, Me, Message, OutgoingFile, Recipient, SendRequest} from '../types';

interface LocalFile {
    key: string;
    name: string;
    type: string;
    size: number;
    data?: string; // base64, filled when read
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

function withSignature(body: string, signature: string) {
    const sig = signature.trim();
    return sig ? `${body}\n\n-- \n${sig}` : body;
}

// buildDraft prepares the fields of a reply or a forward from the original.
function buildDraft(req: ComposeRequest, original: Message | null, me: Me) {
    const ownAddresses = new Set([(me.email || '').toLowerCase(), (me.username || '').toLowerCase()]);
    const signature = me.settings?.signature || '';
    let to: Participant[] = [];
    let cc: Participant[] = [];
    let subject = req.subject || '';
    let text = req.text || '';

    if (req.to) {
        to = req.to.filter((r) => r.email).map((r) => participantFromEmail(r.email || '', r.name));
    }
    if (original && (req.mode === 'reply' || req.mode === 'reply_all')) {
        const replyTo = original.reply_to.length ? original.reply_to : original.from;

        // Replying to one's own message (e.g. from "Sent") goes to its recipients.
        const own = replyTo.every((a) => ownAddresses.has(a.email.toLowerCase()));
        to = toParticipants(own ? original.to : replyTo, req.mode === 'reply_all' ? ownAddresses : new Set());
        if (req.mode === 'reply_all') {
            const taken = new Set([...ownAddresses, ...to.map((p) => p.email || '')]);
            cc = toParticipants([...(own ? [] : original.to), ...original.cc], taken);
        }
        subject = subjectWith('Re', original.subject);
        const author = original.from[0] ? addressFull(original.from[0]) : '';
        const when = new Date(original.date).toLocaleString('ru-RU', {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'});
        text = withSignature('', signature) + `\n\n${when}, ${author} пишет:\n${quoteText(original.text || '')}`;
    } else if (original && req.mode === 'forward') {
        subject = subjectWith('Fwd', original.subject);
        const head = [
            '---------- Пересылаемое сообщение ----------',
            `От: ${original.from.map(addressFull).join(', ')}`,
            `Дата: ${new Date(original.date).toLocaleString('ru-RU')}`,
            `Тема: ${original.subject}`,
            `Кому: ${original.to.map(addressFull).join(', ')}`,
        ];
        if (original.cc.length) {
            head.push(`Копия: ${original.cc.map(addressFull).join(', ')}`);
        }
        text = withSignature('', signature) + `\n\n${head.join('\n')}\n\n${original.text || ''}`;
    } else {
        text = withSignature(text, signature);
    }
    return {to, cc, subject, text};
}

export default function ComposerRoot() {
    const request = useStore((s) => s.compose);
    const me = useStore((s) => s.me);
    const config = useStore((s) => s.config);
    if (!request || !me || !config) {
        return null;
    }
    if (!me.connected) {
        return (
            <Modal
                title='Новое письмо'
                onClose={closeCompose}
                width={480}
            >
                <Callout
                    kind='info'
                    title='Почта не подключена'
                >
                    {'Подключите почту на правой панели (иконка почты), и можно будет отправлять письма прямо из Mattermost.'}
                </Callout>
            </Modal>
        );
    }
    return (
        <Composer
            key={`${request.mode}:${request.source?.folder}:${request.source?.uid}`}
            request={request}
            me={me}
            maxBytes={config.max_attachment_bytes}
        />
    );
}

function Composer({request, me, maxBytes}: {request: ComposeRequest; me: Me; maxBytes: number}) {
    const needsOriginal = Boolean(request.source && request.mode !== 'new');
    const [original, setOriginal] = React.useState<Message | null>(null);
    const [loadError, setLoadError] = React.useState<ApiError | null>(null);
    const [ready, setReady] = React.useState(!needsOriginal);

    const [to, setTo] = React.useState<Participant[]>([]);
    const [cc, setCc] = React.useState<Participant[]>([]);
    const [bcc, setBcc] = React.useState<Participant[]>([]);
    const [showCc, setShowCc] = React.useState(false);
    const [subject, setSubject] = React.useState('');
    const [text, setText] = React.useState('');
    const [files, setFiles] = React.useState<LocalFile[]>([]);
    const [forwardParts, setForwardParts] = React.useState<Set<string>>(new Set());
    const [mmFiles, setMmFiles] = React.useState(request.mattermostFiles || []);
    const [sending, setSending] = React.useState(false);
    const [error, setError] = React.useState<ApiError | null>(null);
    const [dragOver, setDragOver] = React.useState(false);
    const fileInput = React.useRef<HTMLInputElement>(null);
    const textRef = React.useRef<HTMLTextAreaElement>(null);
    const initial = React.useRef('');

    const apply = (m: Message | null) => {
        const draft = buildDraft(request, m, me);
        setTo(draft.to);
        setCc(draft.cc);
        setShowCc(draft.cc.length > 0);
        setSubject(draft.subject);
        setText(draft.text);
        initial.current = draft.text;
        if (m && request.mode === 'forward') {
            setForwardParts(new Set((m.attachments || []).filter((a) => !a.inline).map((a) => a.part)));
        }
        setReady(true);
    };

    React.useEffect(() => {
        if (!needsOriginal || !request.source) {
            apply(null);
            return;
        }
        api.message(request.source.folder, request.source.uid, true).
            then((m) => {
                setOriginal(m);
                apply(m);
            }).
            catch((e: ApiError) => setLoadError(e));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Replies start above the quote, like in mail apps.
    React.useEffect(() => {
        if (ready && request.mode !== 'new' && textRef.current) {
            textRef.current.focus();
            textRef.current.setSelectionRange(0, 0);
            textRef.current.scrollTop = 0;
        }
    }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

    const forwarded: Attachment[] = original && request.mode === 'forward' ? (original.attachments || []).filter((a) => !a.inline) : [];
    const totalBytes = files.reduce((n, f) => n + f.size, 0) +
        forwarded.filter((a) => forwardParts.has(a.part)).reduce((n, a) => n + a.size, 0) +
        mmFiles.reduce((n, f) => n + f.size, 0);
    const tooLarge = totalBytes > maxBytes;
    const dirty = text !== initial.current || files.length > 0 || (request.mode === 'new' && (to.length > 0 || subject !== ''));

    const close = () => {
        // eslint-disable-next-line no-alert
        if (dirty && !sending && !window.confirm('Закрыть письмо? Текст не сохранится.')) {
            return;
        }
        closeCompose();
    };

    const addFiles = async (list: FileList | null) => {
        if (!list) {
            return;
        }
        const added: LocalFile[] = Array.from(list).map((f, i) => ({key: `${Date.now()}-${i}-${f.name}`, name: f.name, type: f.type, size: f.size}));
        setFiles((prev) => [...prev, ...added]);
        await Promise.all(Array.from(list).map(async (f, i) => {
            try {
                const data = await readAsBase64(f);
                setFiles((prev) => prev.map((p) => (p.key === added[i].key ? {...p, data} : p)));
            } catch {
                setFiles((prev) => prev.filter((p) => p.key !== added[i].key));
            }
        }));
    };

    const send = async () => {
        if (to.length + cc.length + bcc.length === 0) {
            setError(new ApiError('invalid_message', 'Укажите хотя бы одного получателя.', 'Укажите хотя бы одного получателя.', 400));
            return;
        }
        if (!subject.trim()) {
            // eslint-disable-next-line no-alert
            if (!window.confirm('Отправить письмо без темы?')) {
                return;
            }
        }
        setSending(true);
        setError(null);
        const attachments: OutgoingFile[] = files.filter((f) => f.data).map((f) => ({filename: f.name, content_type: f.type || 'application/octet-stream', data: f.data || ''}));
        const req: SendRequest = {
            to: toRecipients(to),
            cc: toRecipients(cc),
            bcc: toRecipients(bcc),
            subject: subject.trim(),
            text,
            attachments,
            mattermost_files: mmFiles.map((f) => f.id),
        };
        if (request.source && (request.mode === 'reply' || request.mode === 'reply_all')) {
            req.reply_to = request.source;
        }
        if (request.source && request.mode === 'forward') {
            req.forward = request.source;
            req.forward_parts = Array.from(forwardParts);
        }
        try {
            await api.send(req);
            closeCompose();
            mailChanged();
        } catch (e) {
            setError(e as ApiError);
            setSending(false);
        }
    };

    const titles: Record<ComposeRequest['mode'], string> = {
        new: 'Новое письмо',
        reply: 'Ответ',
        reply_all: 'Ответ всем',
        forward: 'Пересылка',
    };

    const reading = files.some((f) => !f.data);
    return (
        <Modal
            title={titles[request.mode]}
            onClose={close}
            width={720}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'>
                        <span className='mml-muted mml-small'>{`От: ${me.display_name ? `${me.display_name} <${me.email}>` : me.email}`}</span>
                    </div>
                    <div className='mml-wizard__buttons'>
                        <Button
                            variant='tertiary'
                            onClick={close}
                        >
                            {'Отмена'}
                        </Button>
                        <Button
                            variant='primary'
                            loading={sending}
                            disabled={!ready || reading || tooLarge}
                            onClick={send}
                            title='Ctrl+Enter'
                        >
                            <SendIcon size={14}/>
                            {'Отправить'}
                        </Button>
                    </div>
                </div>
            )}
        >
            {!ready && !loadError && <div className='mml-center'><Spinner size={24}/></div>}
            {loadError && (
                <ErrorCard
                    error={loadError}
                    compact={true}
                />
            )}
            {ready && (
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
                        <span className='mml-composer__label'>{'Кому'}</span>
                        <RecipientPicker
                            value={to}
                            onChange={setTo}
                            disabled={sending}
                            autoFocus={request.mode === 'new' || request.mode === 'forward'}
                        />
                        {!showCc && (
                            <button
                                type='button'
                                className='mml-link mml-small'
                                onClick={() => setShowCc(true)}
                            >
                                {'Копия'}
                            </button>
                        )}
                    </div>
                    {showCc && (
                        <>
                            <div className='mml-composer__row'>
                                <span className='mml-composer__label'>{'Копия'}</span>
                                <RecipientPicker
                                    value={cc}
                                    onChange={setCc}
                                    disabled={sending}
                                    placeholder=''
                                />
                            </div>
                            <div className='mml-composer__row'>
                                <span
                                    className='mml-composer__label'
                                    title='Получатели скрытой копии не видны остальным'
                                >
                                    {'Скрытая'}
                                </span>
                                <RecipientPicker
                                    value={bcc}
                                    onChange={setBcc}
                                    disabled={sending}
                                    placeholder=''
                                />
                            </div>
                        </>
                    )}
                    <div className='mml-composer__row'>
                        <span className='mml-composer__label'>{'Тема'}</span>
                        <input
                            className='mml-input mml-composer__subject'
                            value={subject}
                            maxLength={500}
                            disabled={sending}
                            onChange={(e) => setSubject(e.target.value)}
                        />
                    </div>
                    <textarea
                        ref={textRef}
                        className='mml-input mml-textarea mml-composer__text'
                        value={text}
                        disabled={sending}
                        placeholder='Текст письма'
                        onChange={(e) => setText(e.target.value)}
                    />

                    <div className='mml-composer__files'>
                        {forwarded.map((a) => (
                            <label
                                key={a.part}
                                className={`mml-file ${forwardParts.has(a.part) ? '' : 'mml-file--off'}`}
                            >
                                <input
                                    type='checkbox'
                                    checked={forwardParts.has(a.part)}
                                    onChange={() => {
                                        const next = new Set(forwardParts);
                                        if (next.has(a.part)) {
                                            next.delete(a.part);
                                        } else {
                                            next.add(a.part);
                                        }
                                        setForwardParts(next);
                                    }}
                                />
                                <PaperclipIcon size={13}/>
                                <span className='mml-ellipsis'>{a.filename}</span>
                                <span className='mml-muted mml-small'>{formatSize(a.size)}</span>
                            </label>
                        ))}
                        {mmFiles.map((f) => (
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
                                    onClick={() => setMmFiles(mmFiles.filter((x) => x.id !== f.id))}
                                >
                                    <CloseIcon size={12}/>
                                </button>
                            </span>
                        ))}
                        {files.map((f) => (
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
                                    onClick={() => setFiles(files.filter((x) => x.key !== f.key))}
                                >
                                    <CloseIcon size={12}/>
                                </button>
                            </span>
                        ))}
                        <button
                            type='button'
                            className='mml-link mml-small'
                            onClick={() => fileInput.current?.click()}
                            disabled={sending}
                        >
                            <PaperclipIcon size={13}/>
                            {'Прикрепить файл'}
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
                    {tooLarge && <div className='mml-hint mml-hint--warn'>{`Вложения больше ${formatSize(maxBytes)} — почтовый сервер такое письмо не примет.`}</div>}
                    {error && (
                        <ErrorCard
                            error={error}
                            compact={true}
                        />
                    )}
                </div>
            )}
        </Modal>
    );
}
