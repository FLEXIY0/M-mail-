import React from 'react';

import {ChevronLeft, ChevronRight, DownloadIcon, ExternalIcon, FolderIcon, PaperclipIcon, Spinner} from './icons';
import {HtmlFrame} from './MessageView';
import PdfView from './PdfView';
import {ErrorCard} from './shared';
import {PanelPage} from './ui';

import type {ApiError} from '../api';
import {api, attachmentUrl, zipEntryUrl} from '../api';
import {addressFull, formatFullDate, formatSize} from '../format';
import {closeAttachment, openAttachment, openInBrowser, pageAttachment, useStore} from '../state';
import type {Attachment, AttachmentRef, AttachmentView, OfficeSession, ZipEntry} from '../types';

// Types the browser shows by itself, by extension when the message says
// only "application/octet-stream" (the server does the same).
const EXT_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
};

const OFFICE_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'vsd', 'vsdx']);

export type ViewKind = 'image' | 'pdf' | 'audio' | 'video' | 'other';

function extOf(name: string) {
    const at = name.lastIndexOf('.');
    return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

export function effectiveType(contentType: string, filename: string) {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();
    if (!ct || ct === 'application/octet-stream' || ct === 'application/x-unknown' || ct === 'binary/octet-stream') {
        return EXT_TYPES[extOf(filename)] || 'application/octet-stream';
    }
    return ct === 'image/jpg' ? 'image/jpeg' : ct;
}

export function viewKind(contentType: string, filename: string): ViewKind {
    const ct = effectiveType(contentType, filename);
    if (ct.startsWith('image/') && ct !== 'image/svg+xml' && ct !== 'image/tiff') {
        return 'image';
    }
    if (ct === 'application/pdf') {
        return 'pdf';
    }
    if (ct.startsWith('audio/')) {
        return 'audio';
    }
    if (ct.startsWith('video/')) {
        return 'video';
    }
    return 'other';
}

// refOf points to an attachment of the list: a part of the message, or a
// part of the attached message the list came from.
function refOf(base: AttachmentRef, a: Attachment): AttachmentRef {
    return base.sub ? {...base, sub: Number(a.part)} : {...base, part: a.part};
}

function fileUrl(ref: AttachmentRef, inline = false) {
    return attachmentUrl(ref.folder, ref.uid, ref.part, inline, ref.sub);
}

export default function AttachmentViewer({attRef, list}: {attRef: AttachmentRef; list: Attachment[]}) {
    const config = useStore((s) => s.config);
    const me = useStore((s) => s.me);
    const current = list.find((a) => refOf(attRef, a).part === attRef.part && refOf(attRef, a).sub === attRef.sub) || list[0];
    const index = current ? list.indexOf(current) : -1;
    const filename = current?.filename || 'Вложение';
    const kind = viewKind(current?.content_type || '', filename);
    const boxRef = React.useRef<HTMLDivElement>(null);

    const page = (step: number) => {
        const next = list[(index + step + list.length) % list.length];
        if (next) {
            pageAttachment(refOf(attRef, next), list);
        }
    };

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (/^(INPUT|TEXTAREA)$/).test(target.tagName)) {
                return;
            }
            if (e.key === 'ArrowLeft' && list.length > 1) {
                page(-1);
            } else if (e.key === 'ArrowRight' && list.length > 1) {
                page(1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const fullscreen = () => {
        boxRef.current?.requestFullscreen?.().catch(() => {
            // Not allowed here (e.g. some desktop builds): nothing to do.
        });
    };

    const actions = (
        <>
            {list.length > 1 && (
                <>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title='Предыдущее вложение (←)'
                        aria-label='Предыдущее вложение'
                        onClick={() => page(-1)}
                    >
                        <ChevronLeft size={20}/>
                    </button>
                    <span className='mml-muted mml-small'>{`${index + 1} из ${list.length}`}</span>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title='Следующее вложение (→)'
                        aria-label='Следующее вложение'
                        onClick={() => page(1)}
                    >
                        <ChevronRight size={20}/>
                    </button>
                </>
            )}
            <a
                className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                href={fileUrl(attRef)}
                download={filename}
                title='Скачать'
                aria-label='Скачать'
            >
                <DownloadIcon size={20}/>
            </a>
        </>
    );

    return (
        <PanelPage
            title={<span className='mml-ellipsis'>{filename}</span>}
            onClose={closeAttachment}
            actions={actions}
            className='mml-page--viewer'
        >
            <div
                ref={boxRef}
                className='mml-viewer'
            >
                {kind === 'image' && (
                    <ImageView
                        key={fileUrl(attRef)}
                        url={fileUrl(attRef, true)}
                        name={filename}
                    />
                )}
                {kind === 'pdf' && (
                    <>
                        <PdfView
                            key={fileUrl(attRef)}
                            url={fileUrl(attRef)}
                            onFallback={() => (
                                <iframe
                                    className='mml-viewer__frame'
                                    src={fileUrl(attRef, true)}
                                    title={filename}
                                />
                            )}
                        />
                        <div className='mml-viewer__links'>
                            <button
                                type='button'
                                className='mml-link mml-small'
                                onClick={fullscreen}
                            >
                                {'На весь экран'}
                            </button>
                            <button
                                type='button'
                                className='mml-link mml-small'
                                onClick={() => openInBrowser(fileUrl(attRef, true))}
                            >
                                {'Открыть в браузере'}
                                <ExternalIcon size={12}/>
                            </button>
                        </div>
                    </>
                )}
                {kind === 'audio' && (
                    <div className='mml-viewer__center'>
                        <PaperclipIcon size={36}/>
                        <div className='mml-viewer__name'>{filename}</div>
                        <audio
                            key={fileUrl(attRef)}
                            controls={true}
                            src={fileUrl(attRef, true)}
                        />
                    </div>
                )}
                {kind === 'video' && (
                    <video
                        key={fileUrl(attRef)}
                        className='mml-viewer__video'
                        controls={true}
                        src={fileUrl(attRef, true)}
                    />
                )}
                {kind === 'other' && (
                    <OtherView
                        key={fileUrl(attRef)}
                        attRef={attRef}
                        filename={filename}
                        size={current?.size || 0}
                        officeConfigured={Boolean(config?.office_viewer)}
                        loadImages={Boolean(me?.settings?.load_images)}
                        onFullscreen={fullscreen}
                    />
                )}
            </div>
        </PanelPage>
    );
}

function ImageView({url, name}: {url: string; name: string}) {
    const [actual, setActual] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    if (failed) {
        return <div className='mml-viewer__center mml-muted'>{'Картинку не удалось показать — её можно скачать.'}</div>;
    }
    return (
        <div className={`mml-viewer__image ${actual ? 'mml-viewer__image--actual' : ''}`}>
            <img
                src={url}
                alt={name}
                title={actual ? 'Вписать в панель' : 'Настоящий размер'}
                onClick={() => setActual(!actual)}
                onError={() => setFailed(true)}
            />
        </div>
    );
}

function OtherView({attRef, filename, size, officeConfigured, loadImages, onFullscreen}: {
    attRef: AttachmentRef;
    filename: string;
    size: number;
    officeConfigured: boolean;
    loadImages: boolean;
    onFullscreen: () => void;
}) {
    const [view, setView] = React.useState<AttachmentView | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    React.useEffect(() => {
        api.attachmentView(attRef).then(setView).catch((e: ApiError) => setError(e));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (error) {
        return (
            <ErrorCard
                error={error}
                compact={true}
            />
        );
    }
    if (!view) {
        return <div className='mml-viewer__center'><Spinner size={24}/></div>;
    }
    switch (view.kind) {
    case 'text':
        return (
            <TextView
                text={view.text || ''}
                truncated={Boolean(view.truncated)}
                csv={view.content_type === 'text/csv' || extOf(filename) === 'csv'}
            />
        );
    case 'zip':
        return (
            <ZipView
                attRef={attRef}
                entries={view.entries || []}
                more={Boolean(view.more)}
            />
        );
    case 'eml':
        return view.message ? (
            <EmlView
                attRef={attRef}
                view={view}
                loadImages={loadImages}
            />
        ) : null;
    }
    if (view.office) {
        return (
            <OfficeFrame
                attRef={attRef}
                onFullscreen={onFullscreen}
            />
        );
    }
    const office = OFFICE_EXT.has(extOf(filename));
    return (
        <div className='mml-viewer__center'>
            <span className='mml-attachment__ext mml-attachment__ext--big'>{extOf(filename).slice(0, 4).toUpperCase() || 'FILE'}</span>
            <div className='mml-viewer__name'>{filename}</div>
            <div className='mml-muted mml-small'>{formatSize(view.size || size)}</div>
            <a
                className='mml-btn mml-btn--primary mml-btn--md'
                href={fileUrl(attRef)}
                download={filename}
            >
                <DownloadIcon size={16}/>
                {'Скачать'}
            </a>
            <p className='mml-muted mml-small'>
                {office && !officeConfigured ? 'Документы Word, Excel и PowerPoint можно смотреть прямо здесь, если администратор подключит Collabora Online.' : 'Этот тип файла в панели не показывается.'}
            </p>
        </div>
    );
}

// parseCSV splits a CSV file into rows; the separator is guessed from the
// first line (Excel in Russia writes ";").
export function parseCSV(text: string, maxRows = 500): string[][] {
    const first = text.split('\n', 1)[0];
    const sep = [';', ',', '\t'].reduce((best, s) => (first.split(s).length > first.split(best).length ? s : best), ',');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length && rows.length < maxRows; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (c === '"') {
                quoted = false;
            } else {
                cell += c;
            }
        } else if (c === '"' && cell === '') {
            quoted = true;
        } else if (c === sep) {
            row.push(cell);
            cell = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') {
                i++;
            }
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += c;
        }
    }
    if ((cell || row.length) && rows.length < maxRows) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function TextView({text, truncated, csv}: {text: string; truncated: boolean; csv: boolean}) {
    const rows = React.useMemo(() => (csv ? parseCSV(text) : null), [text, csv]);
    return (
        <div className='mml-viewer__text'>
            {rows ? (
                <div className='mml-viewer__table'>
                    <table>
                        <tbody>
                            {rows.map((r, i) => (
                                // eslint-disable-next-line react/no-array-index-key
                                <tr key={i}>
                                    {r.map((c, j) => (
                                        // eslint-disable-next-line react/no-array-index-key
                                        <td key={j}>{c}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : <pre>{text}</pre>}
            {(truncated || (rows && rows.length >= 500)) && <div className='mml-hint'>{'Показано начало файла. Полностью — скачайте его.'}</div>}
        </div>
    );
}

function ZipView({attRef, entries, more}: {attRef: AttachmentRef; entries: ZipEntry[]; more: boolean}) {
    const files = entries.filter((e) => !e.dir);
    return (
        <div className='mml-viewer__zip'>
            <div className='mml-muted mml-small'>{`Файлов в архиве: ${files.length}${more ? '+' : ''}`}</div>
            <ul>
                {files.map((e) => (
                    <li key={e.index}>
                        <a
                            className='mml-attachment'
                            href={zipEntryUrl(attRef, e.index)}
                            download={e.name.split('/').pop()}
                            title={`Скачать ${e.name}`}
                        >
                            {e.name.includes('/') ? <FolderIcon size={16}/> : <PaperclipIcon size={16}/>}
                            <span className='mml-attachment__text'>
                                <span className='mml-attachment__name mml-ellipsis'>{e.name}</span>
                                <span className='mml-muted mml-small'>{formatSize(e.size)}</span>
                            </span>
                            <DownloadIcon size={16}/>
                        </a>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function EmlView({attRef, view, loadImages}: {attRef: AttachmentRef; view: AttachmentView; loadImages: boolean}) {
    const msg = view.message;
    if (!msg) {
        return null;
    }

    // Files of the attached message open as "sub" parts of this attachment.
    const files = msg.attachments.filter((a) => !a.inline);
    const base: AttachmentRef = {folder: attRef.folder, uid: attRef.uid, part: attRef.part, sub: 1};
    return (
        <div className='mml-viewer__eml'>
            <h3 className='mml-viewer__subject'>{msg.subject || '(без темы)'}</h3>
            <div className='mml-viewer__meta'>
                <div>
                    <span className='mml-muted'>{'От: '}</span>
                    {msg.from.map(addressFull).join(', ')}
                </div>
                {msg.to.length > 0 && (
                    <div>
                        <span className='mml-muted'>{'Кому: '}</span>
                        {msg.to.map(addressFull).join(', ')}
                    </div>
                )}
                {msg.date && !msg.date.startsWith('0001') && <div className='mml-muted'>{formatFullDate(msg.date)}</div>}
            </div>
            {msg.html ? (
                <HtmlFrame
                    html={msg.html}
                    allowRemote={loadImages}
                />
            ) : <div className='mml-reader__text'>{msg.text}</div>}
            {files.length > 0 && (
                <ul className='mml-viewer__zip'>
                    {files.map((a) => (
                        <li key={a.part}>
                            <button
                                type='button'
                                className='mml-attachment'
                                onClick={() => openAttachment(refOf(base, a), files)}
                            >
                                <span className='mml-attachment__ext'>{extOf(a.filename).slice(0, 4).toUpperCase() || 'FILE'}</span>
                                <span className='mml-attachment__text'>
                                    <span className='mml-attachment__name mml-ellipsis'>{a.filename}</span>
                                    <span className='mml-muted mml-small'>{formatSize(a.size)}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// OfficeFrame opens the document in Collabora Online: the token goes in a
// form POST, as WOPI clients do, so it does not end up in the address.
function OfficeFrame({attRef, onFullscreen}: {attRef: AttachmentRef; onFullscreen: () => void}) {
    const [session, setSession] = React.useState<OfficeSession | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    const formRef = React.useRef<HTMLFormElement>(null);
    const frameName = React.useMemo(() => `mml-office-${Math.random().toString(36).slice(2)}`, []);

    React.useEffect(() => {
        api.officeOpen(attRef).then(setSession).catch((e: ApiError) => setError(e));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (session) {
            formRef.current?.submit();
        }
    }, [session]);

    if (error) {
        return (
            <ErrorCard
                error={error}
                compact={true}
            />
        );
    }
    if (!session) {
        return (
            <div className='mml-viewer__center'>
                <Spinner size={24}/>
                <div className='mml-muted mml-small'>{'Открываю документ в Collabora…'}</div>
            </div>
        );
    }
    return (
        <>
            <form
                ref={formRef}
                action={session.action_url}
                method='post'
                target={frameName}
                style={{display: 'none'}}
            >
                <input
                    type='hidden'
                    name='access_token'
                    value={session.access_token}
                />
                <input
                    type='hidden'
                    name='access_token_ttl'
                    value={String(session.access_token_ttl)}
                />
            </form>
            <iframe
                name={frameName}
                className='mml-viewer__frame mml-viewer__frame--office'
                title={session.filename}
                allow='clipboard-read; clipboard-write; fullscreen'
                allowFullScreen={true}
            />
            <div className='mml-viewer__links'>
                <button
                    type='button'
                    className='mml-link mml-small'
                    onClick={onFullscreen}
                >
                    {'На весь экран'}
                </button>
            </div>
        </>
    );
}
