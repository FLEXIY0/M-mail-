import React from 'react';

import {
    ArchiveIcon, CloseIcon, DraftIcon, ExternalIcon, FolderIcon, GearIcon, InboxIcon, MailIcon,
    MailOpenIcon, PaperclipIcon, PlusIcon, RefreshIcon, SearchIcon, SendIcon, SpamIcon, Spinner,
    StarIcon, TrashIcon, BellIcon, ReplyIcon,
} from './icons';
import MessageView from './MessageView';
import {ErrorCard} from './shared';
import {Button, Callout} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {addressLabel, avatarColor, formatListDate, initials, pluralMessages} from '../format';
import {loadAll, openCompose, openInBrowser, openWizard, refreshMe, setState, useStore} from '../state';
import type {Folder, FolderRole, Me, MessageRef, MessageSummary} from '../types';

const FOLDER_KEY = 'mml-panel-folder';

// Russian names of special folders: servers often call them "Sent" or
// "INBOX" in English.
const ROLE_NAMES: Record<string, string> = {
    inbox: 'Входящие',
    sent: 'Отправленные',
    drafts: 'Черновики',
    trash: 'Корзина',
    junk: 'Спам',
    archive: 'Архив',
};

export function folderTitle(f: Folder | undefined, fallback = ''): string {
    if (!f) {
        return fallback;
    }
    return (f.role && ROLE_NAMES[f.role]) || f.display;
}

export function FolderGlyph({role, size = 16}: {role?: FolderRole; size?: number}) {
    switch (role) {
    case 'inbox':
        return <InboxIcon size={size}/>;
    case 'sent':
        return <SendIcon size={size}/>;
    case 'drafts':
        return <DraftIcon size={size}/>;
    case 'trash':
        return <TrashIcon size={size}/>;
    case 'junk':
        return <SpamIcon size={size}/>;
    case 'archive':
        return <ArchiveIcon size={size}/>;
    }
    return <FolderIcon size={size}/>;
}

function readFolder(): string {
    try {
        return window.localStorage.getItem(FOLDER_KEY) || 'INBOX';
    } catch {
        return 'INBOX';
    }
}

function saveFolder(name: string) {
    try {
        window.localStorage.setItem(FOLDER_KEY, name);
    } catch {
        // Private mode; the choice is simply not remembered.
    }
}

// PanelTitle is shown in the header of the right-hand sidebar.
export function PanelTitle() {
    const unseen = useStore((s) => s.me?.sync?.unseen || 0);
    return (
        <span className='mml-rhs-title'>
            <MailIcon size={16}/>
            {'Почта'}
            {unseen > 0 && <span className='mml-badge'>{unseen > 999 ? '999+' : unseen}</span>}
        </span>
    );
}

// Panel is the right-hand sidebar opened from the app bar icon.
export default function Panel() {
    const me = useStore((s) => s.me);
    const loading = useStore((s) => s.loading);
    const loadError = useStore((s) => s.loadError);

    React.useEffect(() => {
        loadAll();
    }, []);

    if (!me) {
        return (
            <div className='mml-panel mml-panel--center'>
                {loadError ? (
                    <Callout
                        kind='error'
                        title='Не удалось загрузить почту'
                        action={(
                            <Button
                                size='sm'
                                onClick={() => loadAll(true)}
                            >
                                {'Повторить'}
                            </Button>
                        )}
                    >
                        {loadError}
                    </Callout>
                ) : (loading && <Spinner size={24}/>)}
            </div>
        );
    }
    if (!me.connected) {
        return <ConnectPrompt/>;
    }
    return <Mailbox me={me}/>;
}

function ConnectPrompt() {
    const config = useStore((s) => s.config);
    const me = useStore((s) => s.me);
    const names = config?.providers.map((p) => p.name.replace('Почта ', '').replace(' Почта', '')).join(' · ');
    return (
        <div className='mml-panel mml-connect'>
            <div className='mml-connect__art'>
                <MailIcon size={44}/>
            </div>
            <h3>{'Почта в Mattermost'}</h3>
            <p className='mml-lead'>{'Подключите рабочую почту, чтобы читать письма и отвечать на них рядом с чатами.'}</p>
            <ul className='mml-benefits mml-benefits--compact'>
                <li>
                    <InboxIcon size={16}/>
                    <span>{'Входящие и все папки'}</span>
                </li>
                <li>
                    <ReplyIcon size={16}/>
                    <span>{'Ответ, пересылка, вложения'}</span>
                </li>
                <li>
                    <BellIcon size={16}/>
                    <span>{'Уведомления о новых письмах'}</span>
                </li>
                <li>
                    <SendIcon size={16}/>
                    <span>{'Сообщение из чата — письмом'}</span>
                </li>
            </ul>
            <Button
                variant='primary'
                size='lg'
                className='mml-connect__button'
                onClick={() => openWizard('connect')}
            >
                {'Подключить почту'}
            </Button>
            {names && <div className='mml-muted mml-small'>{names}</div>}

            {me?.icon.web_url && (
                <div className='mml-connect__alt'>
                    <div className='mml-muted mml-small'>{'Не хотите подключать? Можно пользоваться веб-почтой как обычно.'}</div>
                    <Button
                        variant='secondary'
                        className='mml-connect__button'
                        onClick={() => openInBrowser(me.icon.web_url)}
                    >
                        {'Открыть почту в браузере'}
                        <ExternalIcon size={14}/>
                    </Button>
                    <button
                        type='button'
                        className='mml-link mml-small'
                        onClick={() => openWizard('icon')}
                    >
                        {me.icon.action === 'browser' ? 'Иконка открывает веб-почту · изменить' : 'Открывать веб-почту сразу по иконке'}
                    </button>
                </div>
            )}
        </div>
    );
}

interface ListState {
    messages: MessageSummary[];
    total: number;
    hasMore: boolean;
}

function Mailbox({me}: {me: Me}) {
    const revision = useStore((s) => s.revision);
    const openRequest = useStore((s) => s.openRequest);

    const [folders, setFolders] = React.useState<Folder[] | null>(null);
    const [folder, setFolderState] = React.useState(readFolder);
    const [query, setQuery] = React.useState('');
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [list, setList] = React.useState<ListState | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    const [fetching, setFetching] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [selected, setSelected] = React.useState<MessageRef | null>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    const requestId = React.useRef(0);

    const setFolder = (name: string) => {
        setFolderState(name);
        saveFolder(name);
        setSelected(null);
        setQuery('');
        setSearchOpen(false);
        setList(null);
    };

    const loadFolders = React.useCallback(() => {
        api.folders().
            then((res) => {
                setFolders(res.folders);

                // The remembered folder may have been deleted or renamed.
                if (!res.folders.some((f) => f.name === folder && !f.no_select)) {
                    const inbox = res.folders.find((f) => f.role === 'inbox');
                    if (inbox) {
                        setFolderState(inbox.name);
                    }
                }
                const inbox = res.folders.find((f) => f.role === 'inbox');
                const current = me.sync?.unseen || 0;
                if (inbox && inbox.unseen !== current) {
                    refreshMe();
                }
            }).
            catch(() => {
                // The list request shows the error.
            });
    }, [folder, me.sync?.unseen]);

    const loadList = React.useCallback((append = false) => {
        const id = ++requestId.current;
        const offset = append && list ? list.messages.length : 0;
        if (append) {
            setLoadingMore(true);
        } else {
            setFetching(true);
        }
        api.messages(folder, offset, query).
            then((page) => {
                if (id !== requestId.current) {
                    return;
                }
                setError(null);
                setList((prev) => ({
                    messages: append && prev ? [...prev.messages, ...page.messages.filter((m) => !prev.messages.some((p) => p.uid === m.uid))] : page.messages,
                    total: page.total,
                    hasMore: page.has_more,
                }));
            }).
            catch((e: ApiError) => {
                if (id === requestId.current) {
                    setError(e);
                }
            }).
            finally(() => {
                if (id === requestId.current) {
                    setFetching(false);
                    setLoadingMore(false);
                }
            });
    }, [folder, query, list]);

    // Reload when the folder or the search changes, or the mailbox changed.
    React.useEffect(() => {
        loadList(false);
    }, [folder, query, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect(() => {
        loadFolders();
    }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

    // "Open" in a notification.
    React.useEffect(() => {
        if (!openRequest) {
            return;
        }
        if (openRequest.folder !== folder) {
            setFolderState(openRequest.folder);
            saveFolder(openRequest.folder);
            setQuery('');
        }
        setSelected({folder: openRequest.folder, uid: openRequest.uid});
        setState({openRequest: null});
    }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps

    const current = folders?.find((f) => f.name === folder);
    const trash = folders?.find((f) => f.role === 'trash');

    const patchMessage = (uid: number, patch: Partial<MessageSummary>) => {
        setList((prev) => prev && {...prev, messages: prev.messages.map((m) => (m.uid === uid ? {...m, ...patch} : m))});
    };
    const dropMessage = (uid: number) => {
        setList((prev) => prev && {...prev, messages: prev.messages.filter((m) => m.uid !== uid), total: Math.max(prev.total - 1, 0)});
    };

    const toggleFlag = async (m: MessageSummary, flag: 'seen' | 'flagged') => {
        const value = flag === 'seen' ? !m.seen : !m.flagged;
        patchMessage(m.uid, flag === 'seen' ? {seen: value} : {flagged: value});
        try {
            await api.setFlag(folder, [m.uid], flag, value);
            if (flag === 'seen') {
                loadFolders();
            }
        } catch (e) {
            patchMessage(m.uid, flag === 'seen' ? {seen: !value} : {flagged: !value});
            setError(e as ApiError);
        }
    };

    const remove = async (m: MessageSummary) => {
        dropMessage(m.uid);
        try {
            await api.remove(folder, [m.uid]);
            loadFolders();
        } catch (e) {
            setError(e as ApiError);
            loadList(false);
        }
    };

    const refresh = () => {
        loadFolders();
        loadList(false);
    };

    if (selected) {
        return (
            <div className='mml-panel mml-panel--reader'>
                <MessageView
                    key={`${selected.folder}:${selected.uid}`}
                    me={me}
                    msgRef={selected}
                    folders={folders || []}
                    onBack={() => setSelected(null)}
                    onSeen={() => {
                        patchMessage(selected.uid, {seen: true});
                        loadFolders();
                    }}
                    onChanged={(patch) => patchMessage(selected.uid, patch)}
                    onRemoved={() => {
                        dropMessage(selected.uid);
                        setSelected(null);
                        loadFolders();
                    }}
                />
            </div>
        );
    }

    return (
        <div className='mml-panel mml-mailbox'>
            <div className='mml-toolbar mml-mail-toolbar'>
                <FolderPicker
                    folders={folders}
                    value={folder}
                    onChange={setFolder}
                />
                <div className='mml-row mml-mail-toolbar__actions'>
                    <button
                        type='button'
                        className={`mml-icon-btn ${searchOpen ? 'mml-icon-btn--accent' : ''}`}
                        title='Поиск'
                        aria-label='Поиск'
                        onClick={() => {
                            if (searchOpen) {
                                setQuery('');
                            }
                            setSearchOpen(!searchOpen);
                        }}
                    >
                        <SearchIcon size={16}/>
                    </button>
                    <button
                        type='button'
                        className={`mml-icon-btn ${fetching ? 'mml-spin' : ''}`}
                        title='Обновить'
                        aria-label='Обновить'
                        onClick={refresh}
                    >
                        <RefreshIcon size={16}/>
                    </button>
                    <button
                        type='button'
                        className='mml-icon-btn'
                        title='Настройки почты'
                        aria-label='Настройки почты'
                        onClick={() => openWizard('settings')}
                    >
                        <GearIcon size={16}/>
                    </button>
                    <Button
                        variant='primary'
                        size='sm'
                        onClick={() => openCompose({mode: 'new'})}
                    >
                        <PlusIcon size={14}/>
                        {'Написать'}
                    </Button>
                </div>
            </div>

            {searchOpen && (
                <SearchBox
                    onSearch={setQuery}
                    folderName={folderTitle(current, folder)}
                />
            )}

            {me.sync?.auth_failed && (
                <div className='mml-mail-notice'>
                    <Callout
                        kind='warning'
                        title='Почта не принимает сохранённый пароль'
                        action={(
                            <Button
                                size='sm'
                                onClick={() => openWizard('reconnect')}
                            >
                                {'Переподключить'}
                            </Button>
                        )}
                    >
                        {'Уведомления о новых письмах приостановлены. Создайте новый пароль приложения.'}
                    </Callout>
                </div>
            )}

            {error && (
                <div className='mml-mail-notice'>
                    <ErrorCard
                        error={error}
                        compact={true}
                    />
                    {(error.code === 'unauthorized' || error.code === 'reconnect') && (
                        <Button
                            size='sm'
                            onClick={() => openWizard('reconnect')}
                        >
                            {'Переподключить почту'}
                        </Button>
                    )}
                </div>
            )}

            <div
                className='mml-mail-list'
                ref={listRef}
            >
                {!list && !error && <ListSkeleton/>}
                {list && list.messages.length === 0 && (
                    <div className='mml-empty'>
                        <MailOpenIcon size={32}/>
                        <div>{query ? 'Ничего не нашлось' : 'В этой папке пока нет писем'}</div>
                        {query && <div className='mml-muted mml-small'>{'Поиск идёт по отправителю, получателю и теме в текущей папке.'}</div>}
                    </div>
                )}
                {list && list.messages.length > 0 && (
                    <>
                        {query && <div className='mml-muted mml-small mml-mail-list__note'>{`Найдено: ${pluralMessages(list.total)}`}</div>}
                        <ul className='mml-messages'>
                            {list.messages.map((m) => (
                                <MessageRow
                                    key={m.uid}
                                    m={m}
                                    sentFolder={current?.role === 'sent' || current?.role === 'drafts'}
                                    inTrash={current?.role === 'trash' || !trash}
                                    onOpen={() => setSelected({folder, uid: m.uid})}
                                    onToggle={(flag) => toggleFlag(m, flag)}
                                    onDelete={() => remove(m)}
                                />
                            ))}
                        </ul>
                        {list.hasMore && (
                            <div className='mml-center'>
                                <Button
                                    size='sm'
                                    loading={loadingMore}
                                    onClick={() => loadList(true)}
                                >
                                    {'Показать ещё'}
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className='mml-mail-footer mml-muted mml-small'>
                <span className='mml-ellipsis'>{me.email}</span>
                {me.web_url && (
                    <button
                        type='button'
                        className='mml-link mml-small'
                        onClick={() => openInBrowser(me.web_url || '')}
                    >
                        {'Веб-почта'}
                        <ExternalIcon size={12}/>
                    </button>
                )}
            </div>
        </div>
    );
}

function FolderPicker({folders, value, onChange}: {folders: Folder[] | null; value: string; onChange: (name: string) => void}) {
    const current = folders?.find((f) => f.name === value);
    if (!folders) {
        return (
            <div className='mml-folder-picker mml-folder-picker--loading'>
                <InboxIcon size={16}/>
                <span>{'Входящие'}</span>
            </div>
        );
    }
    return (
        <label className='mml-folder-picker'>
            <FolderGlyph role={current?.role}/>
            <span className='mml-folder-picker__name'>{folderTitle(current, value)}</span>
            {current && current.unseen > 0 && <span className='mml-badge mml-badge--soft'>{current.unseen}</span>}
            <select
                value={value}
                aria-label='Папка'
                onChange={(e) => onChange(e.target.value)}
            >
                {folders.map((f) => (
                    <option
                        key={f.name}
                        value={f.name}
                        disabled={f.no_select}
                    >
                        {`${'  '.repeat(f.depth)}${folderTitle(f)}${f.unseen ? ` (${f.unseen})` : ''}`}
                    </option>
                ))}
            </select>
        </label>
    );
}

function SearchBox({onSearch, folderName}: {onSearch: (q: string) => void; folderName: string}) {
    const [text, setText] = React.useState('');
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        inputRef.current?.focus();
    }, []);
    return (
        <form
            className='mml-search'
            onSubmit={(e) => {
                e.preventDefault();
                onSearch(text.trim());
            }}
        >
            <SearchIcon size={14}/>
            <input
                ref={inputRef}
                className='mml-search__input'
                type='search'
                placeholder={`Поиск в папке «${folderName}»`}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    if (!e.target.value) {
                        onSearch('');
                    }
                }}
            />
            {text && (
                <button
                    type='button'
                    className='mml-icon-btn'
                    aria-label='Очистить'
                    onClick={() => {
                        setText('');
                        onSearch('');
                    }}
                >
                    <CloseIcon size={14}/>
                </button>
            )}
        </form>
    );
}

function MessageRow({m, sentFolder, inTrash, onOpen, onToggle, onDelete}: {
    m: MessageSummary;
    sentFolder: boolean;
    inTrash: boolean;
    onOpen: () => void;
    onToggle: (flag: 'seen' | 'flagged') => void;
    onDelete: () => void;
}) {
    // In "Sent" the interesting person is the recipient.
    const person = sentFolder ? m.to[0] : m.from[0];
    const name = sentFolder ? `Кому: ${addressLabel(person) || '—'}` : addressLabel(person) || '(без отправителя)';
    return (
        <li className={`mml-message ${m.seen ? '' : 'mml-message--unseen'}`}>
            <button
                type='button'
                className='mml-message__main'
                onClick={onOpen}
            >
                <span
                    className='mml-message__avatar'
                    style={{background: avatarColor(person)}}
                    aria-hidden='true'
                >
                    {initials(person)}
                </span>
                <span className='mml-message__body'>
                    <span className='mml-message__top'>
                        <span className='mml-message__from mml-ellipsis'>{name}</span>
                        <span className='mml-message__date'>{formatListDate(m.date)}</span>
                    </span>
                    <span className='mml-message__subject mml-ellipsis'>
                        {m.answered && (
                            <span
                                className='mml-message__answered'
                                title='Вы ответили'
                            >
                                <ReplyIcon size={12}/>
                            </span>
                        )}
                        {m.subject || '(без темы)'}
                    </span>
                </span>
                <span className='mml-message__marks'>
                    {m.has_attachments && (
                        <span title='Есть вложения'>
                            <PaperclipIcon size={13}/>
                        </span>
                    )}
                    {m.flagged && (
                        <span className='mml-message__star'>
                            <StarIcon
                                size={13}
                                filled={true}
                            />
                        </span>
                    )}
                </span>
            </button>
            <span className='mml-message__actions'>
                <button
                    type='button'
                    className='mml-icon-btn'
                    title={m.seen ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                    aria-label={m.seen ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                    onClick={() => onToggle('seen')}
                >
                    {m.seen ? <MailIcon size={14}/> : <MailOpenIcon size={14}/>}
                </button>
                <button
                    type='button'
                    className={`mml-icon-btn ${m.flagged ? 'mml-message__star' : ''}`}
                    title={m.flagged ? 'Снять флажок' : 'Пометить флажком'}
                    aria-label={m.flagged ? 'Снять флажок' : 'Пометить флажком'}
                    onClick={() => onToggle('flagged')}
                >
                    <StarIcon
                        size={14}
                        filled={m.flagged}
                    />
                </button>
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--danger'
                    title={inTrash ? 'Удалить навсегда' : 'В корзину'}
                    aria-label={inTrash ? 'Удалить навсегда' : 'В корзину'}
                    onClick={() => {
                        // eslint-disable-next-line no-alert
                        if (inTrash && !window.confirm('Удалить письмо навсегда?')) {
                            return;
                        }
                        onDelete();
                    }}
                >
                    <TrashIcon size={14}/>
                </button>
            </span>
        </li>
    );
}

function ListSkeleton() {
    return (
        <ul className='mml-messages'>
            {[0, 1, 2, 3, 4, 5].map((i) => (
                <li
                    key={i}
                    className='mml-message mml-message--skeleton'
                >
                    <span className='mml-skeleton mml-skeleton--circle'/>
                    <span className='mml-message__body'>
                        <span
                            className='mml-skeleton'
                            style={{width: `${40 + ((i * 17) % 35)}%`}}
                        />
                        <span
                            className='mml-skeleton'
                            style={{width: `${60 + ((i * 11) % 30)}%`}}
                        />
                    </span>
                </li>
            ))}
        </ul>
    );
}
