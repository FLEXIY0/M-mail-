import React from 'react';

import {
    ArrowLeftIcon, BookmarkIcon, ChevronDown, CircleIcon, DownloadIcon, ForwardIcon,
    ImageIcon, MoreVerticalIcon, MoveIcon, PaperclipIcon, ReplyAllIcon, ReplyIcon, ShareIcon, Spinner,
    ThumbDownIcon, TrashIcon, InboxIcon,
} from './icons';
import {Avatar, folderTitle, webmailLabel} from './Panel';
import {ErrorCard} from './shared';
import {Linkify} from './ui';

import type {ApiError} from '../api';
import {api, attachmentUrl} from '../api';
import {addressFull, addressLabel, formatFullDate, formatSize} from '../format';
import {mailChanged, openCompose, openInBrowser, openShare, popRoute} from '../state';
import type {Folder, Me, Message, MessageRef} from '../types';

// Folders are listed once per panel and shared by all opened messages.
let foldersCache: Folder[] | null = null;

function useFolders() {
    const [folders, setFolders] = React.useState<Folder[]>(foldersCache || []);
    React.useEffect(() => {
        api.folders().then((res) => {
            foldersCache = res.folders;
            setFolders(res.folders);
        }).catch(() => {
            // Moving to a folder is simply not offered.
        });
    }, []);
    return folders;
}

export default function MessageView({me, msgRef}: {me: Me; msgRef: MessageRef}) {
    const folders = useFolders();
    const [msg, setMsg] = React.useState<Message | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [showDetails, setShowDetails] = React.useState(false);
    const [menu, setMenu] = React.useState<'' | 'move' | 'more'>('');

    React.useEffect(() => {
        let cancelled = false;
        api.message(msgRef.folder, msgRef.uid).
            then((m) => !cancelled && setMsg(m)).
            catch((e: ApiError) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [msgRef.folder, msgRef.uid]);

    const folder = folders.find((f) => f.name === msgRef.folder);
    const trash = folders.find((f) => f.role === 'trash');
    const junk = folders.find((f) => f.role === 'junk');
    const inbox = folders.find((f) => f.role === 'inbox');
    const inTrash = folder?.role === 'trash' || (folders.length > 0 && !trash);
    const inJunk = folder?.role === 'junk';
    const webUrl = me.icon.custom_web_url || me.web_url || '';

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        setMenu('');
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
        mailChanged();
    });

    const toggleSeen = () => msg && run(async () => {
        await api.setFlag(msgRef.folder, [msgRef.uid], 'seen', !msg.seen);
        setMsg({...msg, seen: !msg.seen});
        mailChanged();
    });

    const leave = () => {
        mailChanged();
        popRoute();
    };

    const remove = () => run(async () => {
        // eslint-disable-next-line no-alert
        if (inTrash && !window.confirm('Удалить письмо навсегда?')) {
            return;
        }
        await api.remove(msgRef.folder, [msgRef.uid]);
        leave();
    });

    const move = (target: {to?: string; role?: string}) => run(async () => {
        await api.move(msgRef.folder, [msgRef.uid], target);
        leave();
    });

    const toolbar = (
        <div className='mml-reader__toolbar'>
            <button
                type='button'
                className='mml-icon-btn mml-icon-btn--lg'
                title='К списку писем (Esc)'
                aria-label='К списку писем'
                onClick={popRoute}
            >
                <ArrowLeftIcon size={22}/>
            </button>
            <span className='mml-reader__folder mml-ellipsis'>{folderTitle(folder, msgRef.folder)}</span>
            {busy && <Spinner size={14}/>}
            {msg && (
                <>
                    <button
                        type='button'
                        className={`mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain ${msg.flagged ? 'mml-message__flag' : ''}`}
                        title={msg.flagged ? 'Снять флажок' : 'Пометить флажком'}
                        aria-label={msg.flagged ? 'Снять флажок' : 'Пометить флажком'}
                        onClick={toggleFlag}
                    >
                        <BookmarkIcon
                            size={20}
                            filled={msg.flagged}
                        />
                    </button>
                    <div className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                            title='Переместить в папку'
                            aria-label='Переместить в папку'
                            aria-expanded={menu === 'move'}
                            onClick={() => setMenu(menu === 'move' ? '' : 'move')}
                        >
                            <MoveIcon size={20}/>
                        </button>
                        {menu === 'move' && (
                            <ul
                                className='mml-menu'
                                role='menu'
                                onMouseLeave={() => setMenu('')}
                            >
                                {folders.filter((f) => !f.no_select && f.name !== msgRef.folder).map((f) => (
                                    <li key={f.name}>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => move({to: f.name})}
                                        >
                                            {`${'\u00a0\u00a0'.repeat(f.depth)}${folderTitle(f)}`}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    {(junk || inJunk) && (
                        <button
                            type='button'
                            className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                            title={inJunk ? 'Не спам — во «Входящие»' : 'Это спам'}
                            aria-label={inJunk ? 'Не спам' : 'Это спам'}
                            onClick={() => (inJunk ? move({to: inbox?.name || 'INBOX'}) : move({role: 'junk'}))}
                        >
                            {inJunk ? <InboxIcon size={20}/> : <ThumbDownIcon size={20}/>}
                        </button>
                    )}
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                        title={inTrash ? 'Удалить навсегда' : 'В корзину'}
                        aria-label={inTrash ? 'Удалить навсегда' : 'В корзину'}
                        onClick={remove}
                    >
                        <TrashIcon size={20}/>
                    </button>
                    <div className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                            title='Ещё'
                            aria-label='Ещё'
                            aria-expanded={menu === 'more'}
                            onClick={() => setMenu(menu === 'more' ? '' : 'more')}
                        >
                            <MoreVerticalIcon size={20}/>
                        </button>
                        {menu === 'more' && (
                            <ul
                                className='mml-menu'
                                role='menu'
                                onMouseLeave={() => setMenu('')}
                            >
                                <li>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        onClick={toggleSeen}
                                    >
                                        {msg.seen ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                                    </button>
                                </li>
                                <li>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        onClick={() => {
                                            setMenu('');
                                            openShare(msgRef);
                                        }}
                                    >
                                        {'Отправить в канал Mattermost'}
                                    </button>
                                </li>
                                {webUrl && (
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => {
                                                setMenu('');
                                                openInBrowser(webUrl);
                                            }}
                                        >
                                            {webmailLabel(me.provider)}
                                        </button>
                                    </li>
                                )}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </div>
    );

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (menu) {
                setMenu('');
            } else {
                popRoute();
            }
        }
    };

    if (!msg) {
        return (
            <div
                className='mml-reader'
                onKeyDown={onKeyDown}
            >
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

    const avatars = msg.avatars || {};
    const from = msg.from[0];
    const visibleAttachments = (msg.attachments || []).filter((a) => !a.inline);
    const many = (msg.to || []).length + (msg.cc || []).length > 1;

    return (
        <div
            className='mml-reader'
            onKeyDown={onKeyDown}
        >
            {toolbar}
            <div className='mml-reader__scroll'>
                <div className='mml-reader__title'>
                    <button
                        type='button'
                        className={`mml-reader__seen ${msg.seen ? '' : 'mml-reader__seen--unread'}`}
                        title={msg.seen ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                        aria-label={msg.seen ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                        onClick={toggleSeen}
                    >
                        <CircleIcon
                            size={16}
                            filled={!msg.seen}
                        />
                    </button>
                    <h3 className='mml-reader__subject'>{msg.subject || '(без темы)'}</h3>
                </div>
                <div className='mml-reader__date'>{formatFullDate(msg.date)}</div>

                <div className='mml-reader__from-row'>
                    <span className='mml-reader__label'>{'От:'}</span>
                    <span
                        className='mml-person-chip'
                        title={from ? addressFull(from) : ''}
                    >
                        <Avatar
                            address={from}
                            avatars={avatars}
                            size={28}
                        />
                        <span className='mml-ellipsis'>{addressLabel(from) || '(без отправителя)'}</span>
                    </span>
                    <button
                        type='button'
                        className='mml-link mml-reader__more'
                        onClick={() => setShowDetails(!showDetails)}
                        aria-expanded={showDetails}
                    >
                        {showDetails ? 'Скрыть' : 'Подробнее'}
                        <ChevronDown size={12}/>
                    </button>
                </div>
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
                    </dl>
                )}

                {error && (
                    <ErrorCard
                        error={error}
                        compact={true}
                    />
                )}

                <div className='mml-reader__body'>
                    <MessageBody
                        msg={msg}
                        loadImages={Boolean(me.settings?.load_images)}
                    />
                </div>

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

            <div className='mml-reader__bar'>
                <button
                    type='button'
                    className='mml-reader__action mml-reader__action--primary'
                    onClick={() => openCompose({mode: 'reply', source: msgRef})}
                >
                    <ReplyIcon size={18}/>
                    <span>{'Ответить'}</span>
                </button>
                {many && (
                    <button
                        type='button'
                        className='mml-reader__action'
                        onClick={() => openCompose({mode: 'reply_all', source: msgRef})}
                    >
                        <ReplyAllIcon size={18}/>
                        <span>{'Всем'}</span>
                    </button>
                )}
                <button
                    type='button'
                    className='mml-reader__action'
                    onClick={() => openCompose({mode: 'forward', source: msgRef})}
                >
                    <ForwardIcon size={18}/>
                    <span>{'Переслать'}</span>
                </button>
                <button
                    type='button'
                    className='mml-reader__action'
                    title='Опубликовать письмо в текущем канале Mattermost'
                    onClick={() => openShare(msgRef)}
                >
                    <ShareIcon size={18}/>
                    <span>{'В канал'}</span>
                </button>
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

export function HtmlFrame({html, allowRemote}: {html: string; allowRemote: boolean}) {
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
