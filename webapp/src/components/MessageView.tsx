import React from 'react';

import {
    ChevronDown, ChevronLeft, DownloadIcon, ForwardIcon, ImageIcon, MailIcon, MoveIcon,
    PaperclipIcon, ReplyAllIcon, ReplyIcon, ShareIcon, Spinner, StarIcon, TrashIcon,
} from './icons';
import {folderTitle} from './Panel';
import {ErrorCard} from './shared';
import {Button, Linkify} from './ui';

import type {ApiError} from '../api';
import {api, attachmentUrl} from '../api';
import {addressFull, addressLabel, avatarColor, formatFullDate, formatSize, initials} from '../format';
import {openCompose, openShare} from '../state';
import type {Folder, Me, Message, MessageRef, MessageSummary} from '../types';

export default function MessageView({me, msgRef, folders, onBack, onSeen, onChanged, onRemoved}: {
    me: Me;
    msgRef: MessageRef;
    folders: Folder[];
    onBack: () => void;
    onSeen: () => void;
    onChanged: (patch: Partial<MessageSummary>) => void;
    onRemoved: () => void;
}) {
    const [msg, setMsg] = React.useState<Message | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [showDetails, setShowDetails] = React.useState(false);
    const [moveOpen, setMoveOpen] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        api.message(msgRef.folder, msgRef.uid).
            then((m) => {
                if (cancelled) {
                    return;
                }
                setMsg(m);
                if (m.seen) {
                    onSeen();
                }
            }).
            catch((e: ApiError) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [msgRef.folder, msgRef.uid]); // eslint-disable-line react-hooks/exhaustive-deps

    // Escape goes back to the list, like in mail apps.
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (e.key === 'Escape' && !target?.closest('input, textarea, select, .mml-overlay')) {
                onBack();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onBack]);

    const folder = folders.find((f) => f.name === msgRef.folder);
    const trash = folders.find((f) => f.role === 'trash');
    const inTrash = folder?.role === 'trash' || !trash;

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(e as ApiError);
        } finally {
            setBusy(false);
        }
    };

    const toggleFlag = () => msg && run(async () => {
        await api.setFlag(msgRef.folder, [msgRef.uid], 'flagged', !msg.flagged);
        setMsg({...msg, flagged: !msg.flagged});
        onChanged({flagged: !msg.flagged});
    });

    const markUnread = () => run(async () => {
        await api.setFlag(msgRef.folder, [msgRef.uid], 'seen', false);
        onChanged({seen: false});
        onBack();
    });

    const remove = () => run(async () => {
        // eslint-disable-next-line no-alert
        if (inTrash && !window.confirm('Удалить письмо навсегда?')) {
            return;
        }
        await api.remove(msgRef.folder, [msgRef.uid]);
        onRemoved();
    });

    const move = (to: string) => run(async () => {
        setMoveOpen(false);
        await api.move(msgRef.folder, [msgRef.uid], {to});
        onRemoved();
    });

    const toolbar = (
        <div className='mml-toolbar mml-reader__toolbar'>
            <button
                type='button'
                className='mml-icon-btn'
                title='К списку писем (Esc)'
                aria-label='К списку писем'
                onClick={onBack}
            >
                <ChevronLeft size={18}/>
            </button>
            <span className='mml-reader__folder mml-ellipsis'>{folderTitle(folder, msgRef.folder)}</span>
            {msg && (
                <div className='mml-row'>
                    {busy && <Spinner size={14}/>}
                    <button
                        type='button'
                        className={`mml-icon-btn ${msg.flagged ? 'mml-message__star' : ''}`}
                        title={msg.flagged ? 'Снять флажок' : 'Пометить флажком'}
                        aria-label={msg.flagged ? 'Снять флажок' : 'Пометить флажком'}
                        onClick={toggleFlag}
                    >
                        <StarIcon
                            size={16}
                            filled={msg.flagged}
                        />
                    </button>
                    <button
                        type='button'
                        className='mml-icon-btn'
                        title='Отметить непрочитанным'
                        aria-label='Отметить непрочитанным'
                        onClick={markUnread}
                    >
                        <MailIcon size={16}/>
                    </button>
                    <div className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-icon-btn'
                            title='Переместить в папку'
                            aria-label='Переместить в папку'
                            aria-expanded={moveOpen}
                            onClick={() => setMoveOpen(!moveOpen)}
                        >
                            <MoveIcon size={16}/>
                        </button>
                        {moveOpen && (
                            <ul
                                className='mml-menu'
                                role='menu'
                                onMouseLeave={() => setMoveOpen(false)}
                            >
                                {folders.filter((f) => !f.no_select && f.name !== msgRef.folder).map((f) => (
                                    <li key={f.name}>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => move(f.name)}
                                        >
                                            {`${'  '.repeat(f.depth)}${folderTitle(f)}`}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--danger'
                        title={inTrash ? 'Удалить навсегда' : 'В корзину'}
                        aria-label={inTrash ? 'Удалить навсегда' : 'В корзину'}
                        onClick={remove}
                    >
                        <TrashIcon size={16}/>
                    </button>
                </div>
            )}
        </div>
    );

    if (!msg) {
        return (
            <div className='mml-reader'>
                {toolbar}
                {error ? (
                    <div className='mml-mail-notice'>
                        <ErrorCard
                            error={error}
                            compact={true}
                        />
                    </div>
                ) : <div className='mml-center'><Spinner size={24}/></div>}
            </div>
        );
    }

    const from = msg.from[0];
    const visibleAttachments = (msg.attachments || []).filter((a) => !a.inline);

    return (
        <div className='mml-reader'>
            {toolbar}
            <div className='mml-reader__scroll'>
                <h3 className='mml-reader__subject'>{msg.subject || '(без темы)'}</h3>
                <div className='mml-reader__head'>
                    <span
                        className='mml-message__avatar mml-message__avatar--lg'
                        style={{background: avatarColor(from)}}
                        aria-hidden='true'
                    >
                        {initials(from)}
                    </span>
                    <div className='mml-reader__people'>
                        <div className='mml-reader__from'>
                            <strong>{addressLabel(from) || '(без отправителя)'}</strong>
                            {from?.name && <span className='mml-muted'>{` <${from.email}>`}</span>}
                        </div>
                        <button
                            type='button'
                            className='mml-reader__to mml-muted'
                            onClick={() => setShowDetails(!showDetails)}
                            aria-expanded={showDetails}
                        >
                            <span className='mml-ellipsis'>{`Кому: ${msg.to.map(addressLabel).join(', ') || '—'}${msg.cc.length ? `, копия: ${msg.cc.map(addressLabel).join(', ')}` : ''}`}</span>
                            <ChevronDown size={12}/>
                        </button>
                        {showDetails && (
                            <dl className='mml-reader__details'>
                                <dt>{'От'}</dt>
                                <dd>{msg.from.map(addressFull).join(', ')}</dd>
                                <dt>{'Кому'}</dt>
                                <dd>{msg.to.map(addressFull).join(', ') || '—'}</dd>
                                {msg.cc.length > 0 && (
                                    <>
                                        <dt>{'Копия'}</dt>
                                        <dd>{msg.cc.map(addressFull).join(', ')}</dd>
                                    </>
                                )}
                                {msg.reply_to.length > 0 && msg.reply_to[0].email !== from?.email && (
                                    <>
                                        <dt>{'Ответ на'}</dt>
                                        <dd>{msg.reply_to.map(addressFull).join(', ')}</dd>
                                    </>
                                )}
                                <dt>{'Дата'}</dt>
                                <dd>{new Date(msg.date).toLocaleString('ru-RU')}</dd>
                            </dl>
                        )}
                    </div>
                    <span className='mml-reader__date mml-muted mml-small'>{formatFullDate(msg.date)}</span>
                </div>

                <div className='mml-reader__actions'>
                    <Button
                        size='sm'
                        onClick={() => openCompose({mode: 'reply', source: msgRef})}
                    >
                        <ReplyIcon size={14}/>
                        {'Ответить'}
                    </Button>
                    {((msg.to || []).length + (msg.cc || []).length > 1) && (
                        <Button
                            size='sm'
                            onClick={() => openCompose({mode: 'reply_all', source: msgRef})}
                        >
                            <ReplyAllIcon size={14}/>
                            {'Всем'}
                        </Button>
                    )}
                    <Button
                        size='sm'
                        onClick={() => openCompose({mode: 'forward', source: msgRef})}
                    >
                        <ForwardIcon size={14}/>
                        {'Переслать'}
                    </Button>
                    <Button
                        size='sm'
                        variant='tertiary'
                        title='Опубликовать письмо в текущем канале Mattermost'
                        onClick={() => openShare(msgRef)}
                    >
                        <ShareIcon size={14}/>
                        {'В канал'}
                    </Button>
                </div>

                {error && (
                    <ErrorCard
                        error={error}
                        compact={true}
                    />
                )}

                <MessageBody
                    msg={msg}
                    loadImages={Boolean(me.settings?.load_images)}
                />

                {msg.truncated && <div className='mml-hint'>{'Письмо очень длинное, показано начало. Полностью — в веб-почте.'}</div>}

                {visibleAttachments.length > 0 && (
                    <div className='mml-attachments'>
                        <div className='mml-attachments__title'>
                            <PaperclipIcon size={14}/>
                            {`Вложения: ${visibleAttachments.length}`}
                        </div>
                        <ul>
                            {visibleAttachments.map((a) => (
                                <li key={a.part}>
                                    <a
                                        className='mml-attachment'
                                        href={attachmentUrl(msgRef.folder, msgRef.uid, a.part)}
                                        download={a.filename}
                                        title={`Скачать ${a.filename}`}
                                    >
                                        <span className='mml-attachment__ext'>{(a.filename.split('.').pop() || '').slice(0, 4).toUpperCase() || 'FILE'}</span>
                                        <span className='mml-attachment__text'>
                                            <span className='mml-attachment__name mml-ellipsis'>{a.filename}</span>
                                            <span className='mml-muted mml-small'>{formatSize(a.size)}</span>
                                        </span>
                                        <DownloadIcon size={16}/>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
}

function MessageBody({msg, loadImages}: {msg: Message; loadImages: boolean}) {
    const [allowRemote, setAllowRemote] = React.useState(loadImages);
    const [asText, setAsText] = React.useState(false);
    const remote = React.useMemo(() => Boolean(msg.html && hasRemoteContent(msg.html)), [msg.html]);

    if (!msg.html || asText) {
        return (
            <>
                <div className='mml-reader__text'>
                    <Linkify text={msg.text || ''}/>
                </div>
                {msg.html && (
                    <button
                        type='button'
                        className='mml-link mml-small'
                        onClick={() => setAsText(false)}
                    >
                        {'Показать оформленное письмо'}
                    </button>
                )}
            </>
        );
    }
    return (
        <>
            {remote && !allowRemote && (
                <div className='mml-images-notice'>
                    <ImageIcon size={14}/>
                    <span>{'Картинки из интернета скрыты, чтобы отправитель не узнал, что письмо открыто.'}</span>
                    <button
                        type='button'
                        className='mml-link'
                        onClick={() => setAllowRemote(true)}
                    >
                        {'Показать'}
                    </button>
                </div>
            )}
            <HtmlFrame
                html={msg.html}
                allowRemote={allowRemote}
            />
            {msg.text && (
                <button
                    type='button'
                    className='mml-link mml-small'
                    onClick={() => setAsText(true)}
                >
                    {'Показать как текст'}
                </button>
            )}
        </>
    );
}

const REMOTE_RE = /(<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\/)|(url\(\s*["']?\s*(https?:)?\/\/)|(<link[^>]+href)/i;

export function hasRemoteContent(html: string) {
    return REMOTE_RE.test(html);
}

// buildDocument wraps a message body into a document for the sandboxed
// frame. Scripts can not run (no allow-scripts, CSP without script-src),
// remote content only loads when the user allows it, and links open in a
// new tab.
export function buildDocument(html: string, allowRemote: boolean) {
    const img = allowRemote ? "img-src data: https: http:; style-src 'unsafe-inline' https:; font-src data: https:;" : "img-src data:; style-src 'unsafe-inline'; font-src data:;";
    const csp = `default-src 'none'; ${img}`;
    const body = html.
        replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '').
        replace(/<base[^>]*>/gi, '');
    return '<!doctype html><html><head><meta charset="utf-8">' +
        `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
        '<base target="_blank">' +
        '<style>html,body{margin:0;padding:0;background:#fff;color:#1f2329;}' +
        'body{padding:12px 14px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere;}' +
        'img{max-width:100%;height:auto;}table{max-width:100%;}pre{white-space:pre-wrap;}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:3px solid #d0d4da;color:#4b5563;}</style>' +
        `</head><body>${body}</body></html>`;
}

function HtmlFrame({html, allowRemote}: {html: string; allowRemote: boolean}) {
    const ref = React.useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = React.useState(200);
    const doc = React.useMemo(() => buildDocument(html, allowRemote), [html, allowRemote]);

    React.useEffect(() => {
        const frame = ref.current;
        if (!frame) {
            return undefined;
        }
        let observer: ResizeObserver | null = null;
        const measure = () => {
            const d = frame.contentDocument;
            if (d?.documentElement) {
                setHeight(Math.min(Math.max(d.documentElement.scrollHeight, 60), 20000));
            }
        };
        const onLoad = () => {
            measure();
            const d = frame.contentDocument;
            if (d?.body && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(measure);
                observer.observe(d.body);
            }
        };
        frame.addEventListener('load', onLoad);
        return () => {
            frame.removeEventListener('load', onLoad);
            observer?.disconnect();
        };
    }, [doc]);

    return (
        <iframe
            ref={ref}
            className='mml-reader__frame'
            title='Текст письма'

            // allow-same-origin without allow-scripts only lets the panel
            // measure the height; the message itself can not run code.
            sandbox='allow-same-origin allow-popups allow-popups-to-escape-sandbox'
            referrerPolicy='no-referrer'
            srcDoc={doc}
            style={{height}}
        />
    );
}
