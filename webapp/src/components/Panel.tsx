import React from 'react';

import Composer from './Composer';
import {
    ArchiveIcon, ArrowLeftIcon, BellIcon, BookmarkIcon, CheckAllIcon, CheckIcon, CloseIcon, DraftIcon, ExternalIcon,
    FolderIcon, FolderPlusIcon, GearIcon, InboxIcon, MailIcon, MailOpenIcon, MenuIcon, MoreVerticalIcon, MoveIcon,
    PaperclipIcon, PenIcon, PlusIcon, RefreshIcon, ReplyIcon, SearchIcon, SendIcon, SlidersIcon, SpamIcon, Spinner,
    ThumbDownIcon, TrashIcon,
} from './icons';
import IconSettingsDialog from './IconSettings';
import MessageView from './MessageView';
import {RuleEditor, RulesPage} from './Rules';
import SettingsDialog from './SettingsDialog';
import {ErrorCard} from './shared';
import ShareDialog from './ShareDialog';
import SignatureEditor from './SignatureEditor';
import {Button, Callout} from './ui';
import WizardRoot from './Wizard';

import type {ApiError} from '../api';
import {api} from '../api';
import {addressLabel, avatarColor, dateGroup, formatListDate, initials, pluralMessages} from '../format';
import {guides} from '../guides';
import {
    hideToast, loadAll, mailChanged, openCompose, openInBrowser, openRule, openRules, openWizard, pushRoute, refreshMe, setState,
    showToast, useStore,
} from '../state';
import type {Route} from '../state';
import type {Address, Folder, FolderRole, Me, MessageFilter, MessageSummary, ProviderID} from '../types';

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

const FILTERS: Array<{id: MessageFilter; label: string; drawer: string; empty: string}> = [
    {id: 'unseen', label: 'Непрочитанные', drawer: 'Все непрочитанные', empty: 'Непрочитанных писем нет'},
    {id: 'flagged', label: 'С флажками', drawer: 'Все с флажками', empty: 'Писем с флажками нет'},
    {id: 'attachments', label: 'С файлами', drawer: 'С файлами', empty: 'Писем с файлами нет'},
];

export function folderTitle(f: Folder | undefined, fallback = ''): string {
    if (!f) {
        return fallback === 'INBOX' ? 'Входящие' : fallback;
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

function avatarUrl(userId: string) {
    return `${window.basename || ''}/api/v4/users/${userId}/image`;
}

// Avatar shows the photo of a colleague from Mattermost, or the initials.
export function Avatar({address, avatars, size = 40}: {address?: Address; avatars: Record<string, string>; size?: number}) {
    const userId = address ? avatars[address.email.toLowerCase()] : '';
    const style = {width: size, height: size, fontSize: Math.round(size * 0.36)};
    if (userId) {
        return (
            <img
                className='mml-avatar-img'
                src={avatarUrl(userId)}
                alt=''
                style={style}
            />
        );
    }
    return (
        <span
            className='mml-message__avatar'
            style={{...style, background: avatarColor(address)}}
            aria-hidden='true'
        >
            {initials(address)}
        </span>
    );
}

// webmailLabel names the provider's own web mail for the link at the bottom.
export function webmailLabel(provider?: ProviderID): string {
    switch (provider) {
    case 'vkworkspace':
        return 'Открыть почту VK WorkSpace';
    case 'mailru':
        return 'Открыть Почту Mail.ru';
    case 'yandex':
        return 'Открыть Яндекс Почту';
    }
    return 'Открыть веб-почту';
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

function RouteScreen({route, me}: {route: Route; me: Me}) {
    switch (route.name) {
    case 'wizard':
        return <WizardRoot mode={route.mode}/>;
    case 'settings':
        return me.connected ? <SettingsDialog/> : <IconSettingsDialog/>;
    case 'icon':
        return <IconSettingsDialog/>;
    case 'compose':
        return <Composer request={route.request}/>;
    case 'share':
        return <ShareDialog msgRef={route.ref}/>;
    case 'rules':
        return <RulesPage/>;
    case 'signature':
        return <SignatureEditor/>;
    case 'rule':
        return <RuleEditor draft={route.rule}/>;
    case 'message':
        return (
            <MessageView
                key={`${route.ref.folder}:${route.ref.uid}`}
                me={me}
                msgRef={route.ref}
            />
        );
    }
    return null;
}

// Panel is the right-hand sidebar opened from the app bar icon. Everything
// happens here: the list stays underneath, screens are stacked on top.
export default function Panel() {
    const me = useStore((s) => s.me);
    const loading = useStore((s) => s.loading);
    const loadError = useStore((s) => s.loadError);
    const routes = useStore((s) => s.routes);

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

    // Screens that need a connected mailbox are skipped until it is there.
    const visible = routes.filter((r) => me.connected || r.name === 'wizard' || r.name === 'icon' || r.name === 'settings');
    return (
        <div className='mml-shell'>
            <div className={`mml-shell__base ${visible.length ? 'mml-hidden' : ''}`}>
                {me.connected ? <Mailbox me={me}/> : <ConnectPrompt/>}
            </div>
            {visible.map((route, i) => (
                <div
                    key={route.name === 'compose' ? route.request.id : `${route.name}-${i}`}
                    className={`mml-shell__screen ${i === visible.length - 1 ? '' : 'mml-hidden'}`}
                >
                    <RouteScreen
                        route={route}
                        me={me}
                    />
                </div>
            ))}
            <ToastView/>
        </div>
    );
}

function ToastView() {
    const toast = useStore((s) => s.toast);
    if (!toast) {
        return null;
    }
    return (
        <div
            className={`mml-toast ${toast.kind === 'error' ? 'mml-toast--error' : ''}`}
            role='status'
            aria-live='polite'
        >
            <span className='mml-toast__text'>{toast.text}</span>
            {toast.action && (
                <button
                    type='button'
                    className='mml-toast__action'
                    onClick={toast.action.run}
                >
                    {toast.action.label}
                </button>
            )}
            <button
                type='button'
                className='mml-icon-btn mml-toast__close'
                aria-label='Скрыть'
                onClick={() => hideToast(toast.id)}
            >
                <CloseIcon size={12}/>
            </button>
            {toast.countdown && (
                <span
                    key={toast.id}
                    className='mml-toast__progress'
                    style={{animationDuration: `${toast.countdown}ms`}}
                />
            )}
        </div>
    );
}

// Messages are dragged to a folder in the drawer with this data type.
export const DRAG_TYPE = 'application/x-mml-messages';

interface DragData {
    folder: string;
    uids: number[];
}

function isMailDrag(e: React.DragEvent) {
    return Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
}

function readDrag(e: React.DragEvent): DragData | null {
    try {
        const data = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragData;
        return data && Array.isArray(data.uids) ? data : null;
    } catch {
        return null;
    }
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
    const folderRequest = useStore((s) => s.folderRequest);
    const routes = useStore((s) => s.routes);
    const opened = routes.find((r) => r.name === 'message') as Extract<Route, {name: 'message'}> | undefined;

    const [folders, setFolders] = React.useState<Folder[] | null>(null);
    const [folder, setFolderState] = React.useState(readFolder);
    const [filter, setFilter] = React.useState<MessageFilter | ''>('');
    const [query, setQuery] = React.useState('');
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const [filterMenu, setFilterMenu] = React.useState(false);
    const [list, setList] = React.useState<ListState | null>(null);
    const [avatars, setAvatars] = React.useState<Record<string, string>>({});
    const [error, setError] = React.useState<ApiError | null>(null);
    const [fetching, setFetching] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [selected, setSelected] = React.useState<Set<number>>(() => new Set());
    const [moreMenu, setMoreMenu] = React.useState(false);
    const [moveMenu, setMoveMenu] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    const [drawerCreate, setDrawerCreate] = React.useState(false);
    const requestId = React.useRef(0);

    const setFolder = (name: string) => {
        setFolderState(name);
        saveFolder(name);
        setQuery('');
        setSearchOpen(false);
        setList(null);
        setSelected(new Set());
        setDrawerOpen(false);
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
                if (inbox && inbox.unseen !== (me.sync?.unseen || 0)) {
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
        api.messages(folder, offset, query, filter).
            then((page) => {
                if (id !== requestId.current) {
                    return;
                }
                setError(null);
                setAvatars((prev) => ({...prev, ...(page.avatars || {})}));
                if (!append) {
                    // Keep only the selected messages that are still there.
                    setSelected((prev) => (prev.size ? new Set(page.messages.filter((m) => prev.has(m.uid)).map((m) => m.uid)) : prev));
                }
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
    }, [folder, query, filter, list]);

    // Reload when the folder, the search or the filter changes, or the
    // mailbox changed on the server.
    React.useEffect(() => {
        loadList(false);
    }, [folder, query, filter, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect(() => {
        loadFolders();
    }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

    // "Open" in a notification may point to another folder.
    React.useEffect(() => {
        if (folderRequest && folderRequest.folder !== folder) {
            setFolder(folderRequest.folder);
        }
        if (folderRequest) {
            setState({folderRequest: null});
        }
    }, [folderRequest]); // eslint-disable-line react-hooks/exhaustive-deps

    const patchMessage = (uid: number, patch: Partial<MessageSummary>) => {
        setList((prev) => prev && {...prev, messages: prev.messages.map((m) => (m.uid === uid ? {...m, ...patch} : m))});
    };
    const dropMessages = (uids: number[]) => {
        const gone = new Set(uids);
        setList((prev) => prev && {...prev, messages: prev.messages.filter((m) => !gone.has(m.uid)), total: Math.max(prev.total - gone.size, 0)});
        setSelected((prev) => new Set(Array.from(prev).filter((u) => !gone.has(u))));
    };

    // The opened message is read now: update the row and the counters.
    React.useEffect(() => {
        if (opened && me.settings?.mark_read_on_open && list?.messages.some((m) => m.uid === opened.ref.uid && !m.seen)) {
            patchMessage(opened.ref.uid, {seen: true});
            window.setTimeout(loadFolders, 1500);
        }
    }, [opened?.ref.uid]); // eslint-disable-line react-hooks/exhaustive-deps

    const current = folders?.find((f) => f.name === folder);
    const trash = folders?.find((f) => f.role === 'trash');
    const activeFilter = FILTERS.find((f) => f.id === filter);

    const inJunk = current?.role === 'junk';

    const setFlags = async (uids: number[], flag: 'seen' | 'flagged', value: boolean) => {
        const patch = flag === 'seen' ? {seen: value} : {flagged: value};
        const before = new Map((list?.messages || []).filter((m) => uids.includes(m.uid)).map((m) => [m.uid, m]));
        uids.forEach((uid) => patchMessage(uid, patch));
        try {
            await api.setFlag(folder, uids, flag, value);
            if (flag === 'seen') {
                loadFolders();
            }
        } catch (e) {
            before.forEach((m, uid) => patchMessage(uid, {seen: m.seen, flagged: m.flagged}));
            setError(e as ApiError);
        }
    };
    const toggleFlag = (m: MessageSummary, flag: 'seen' | 'flagged') => setFlags([m.uid], flag, flag === 'seen' ? !m.seen : !m.flagged);

    const removeMany = async (uids: number[]) => {
        dropMessages(uids);
        try {
            const res = await api.remove(folder, uids);
            loadFolders();
            const n = uids.length > 1 ? pluralMessages(uids.length) : 'Письмо';
            showToast(res.permanent ? `${n} удалено навсегда` : `${n} в корзине`);
        } catch (e) {
            setError(e as ApiError);
            loadList(false);
        }
    };

    // moveMany moves messages to a folder, or to Spam/Inbox by role: the
    // server creates "Спам" if the mailbox has none.
    const moveMany = async (uids: number[], target: {to?: string; role?: string}, title: string) => {
        if (!uids.length || target.to === folder) {
            return;
        }

        // All from one sender: offer to send their mail there from now on.
        const senders = new Set((list?.messages || []).filter((m) => uids.includes(m.uid)).map((m) => (m.from[0]?.email || '').toLowerCase()));
        const sender = senders.size === 1 && !sentFolder ? Array.from(senders)[0] : '';
        dropMessages(uids);
        try {
            await api.move(folder, uids, target);
            loadFolders();
            const text = `${uids.length > 1 ? pluralMessages(uids.length) : 'Письмо'} → «${title}»`;
            showToast(text, sender && target.to ? {
                ms: 8000,
                action: {label: 'Всегда сюда', run: () => openRule({from: sender, folder: target.to})},
            } : {});
        } catch (e) {
            setError(e as ApiError);
            loadList(false);
        }
    };
    const toSpam = (uids: number[]) => (inJunk ? moveMany(uids, {role: 'inbox'}, 'Входящие') : moveMany(uids, {role: 'junk'}, 'Спам'));

    const toggleSelect = (uid: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(uid)) {
                next.delete(uid);
            } else {
                next.add(uid);
            }
            return next;
        });
    };

    const folderAction = async (action: 'read' | 'empty') => {
        setMoreMenu(false);
        // eslint-disable-next-line no-alert
        if (action === 'empty' && !window.confirm(`Удалить навсегда все письма в папке «${folderTitle(current, folder)}»?`)) {
            return;
        }
        try {
            if (action === 'read') {
                await api.readAll(folder);
                setList((prev) => prev && {...prev, messages: prev.messages.map((m) => ({...m, seen: true}))});
                showToast('Все письма прочитаны');
            } else {
                await api.emptyFolder(folder);
                setList((prev) => prev && {...prev, messages: [], total: 0, hasMore: false});
                showToast('Папка очищена');
            }
            loadFolders();
        } catch (e) {
            setError(e as ApiError);
        }
    };

    const refresh = () => {
        loadFolders();
        loadList(false);
    };

    const sentFolder = current?.role === 'sent' || current?.role === 'drafts';
    const webUrl = me.icon.custom_web_url || me.web_url || '';
    const unseenCount = current?.unseen || 0;

    // Rows with date headers: "Сегодня", "Вчера", "25 октября"…
    const rows: React.ReactNode[] = [];
    let lastGroup = '';
    for (const m of list?.messages || []) {
        const group = dateGroup(m.date);
        if (group !== lastGroup) {
            rows.push(
                <li
                    key={`g-${group}`}
                    className='mml-group'
                >
                    {group}
                </li>,
            );
            lastGroup = group;
        }
        rows.push(
            <MessageRow
                key={m.uid}
                m={m}
                avatars={avatars}
                sentFolder={sentFolder}
                inTrash={current?.role === 'trash' || !trash}
                inJunk={inJunk}
                spamAllowed={current?.role !== 'sent' && current?.role !== 'drafts'}
                active={opened?.ref.uid === m.uid && opened.ref.folder === folder}
                selected={selected.has(m.uid)}
                selecting={selected.size > 0}
                onOpen={() => {
                    if (selected.size > 0) {
                        toggleSelect(m.uid);
                    } else if (current?.role === 'drafts') {
                        // A draft opens for editing, like in mail apps.
                        openCompose({id: `draft-${folder}-${m.uid}`, mode: 'draft', source: {folder, uid: m.uid}});
                    } else {
                        pushRoute({name: 'message', ref: {folder, uid: m.uid}});
                    }
                }}
                onSelect={() => toggleSelect(m.uid)}
                onToggle={(flag) => toggleFlag(m, flag)}
                onDelete={() => removeMany([m.uid])}
                onSpam={() => toSpam([m.uid])}
                onDragStart={(e) => {
                    const uids = selected.has(m.uid) ? Array.from(selected) : [m.uid];
                    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({folder, uids} as DragData));
                    e.dataTransfer.setData('text/plain', m.subject || '');
                    e.dataTransfer.effectAllowed = 'move';
                    setDragImage(e, uids.length === 1 ? (m.subject || '(без темы)') : pluralMessages(uids.length));
                    setDragging(true);
                }}
                onDragEnd={() => setDragging(false)}
            />,
        );
    }

    return (
        <div
            className={`mml-panel mml-mailbox ${dragging ? 'mml-mailbox--dragging' : ''}`}
            onKeyDown={(e) => {
                if (e.key === 'Escape' && selected.size) {
                    setSelected(new Set());
                }
            }}
        >
            {selected.size > 0 && list && (
                <SelectionBar
                    count={selected.size}
                    allSelected={selected.size === list.messages.length}
                    anyUnseen={list.messages.some((m) => selected.has(m.uid) && !m.seen)}
                    anyUnflagged={list.messages.some((m) => selected.has(m.uid) && !m.flagged)}
                    inTrash={current?.role === 'trash' || !trash}
                    inJunk={inJunk}
                    spamAllowed={current?.role !== 'sent' && current?.role !== 'drafts'}
                    folders={(folders || []).filter((f) => !f.no_select && f.name !== folder)}
                    moveMenu={moveMenu}
                    onMoveMenu={setMoveMenu}
                    onClear={() => setSelected(new Set())}
                    onSelectAll={() => setSelected(selected.size === list.messages.length ? new Set() : new Set(list.messages.map((m) => m.uid)))}
                    onSeen={(v) => setFlags(Array.from(selected), 'seen', v)}
                    onFlag={(v) => setFlags(Array.from(selected), 'flagged', v)}
                    onMove={(f) => {
                        setMoveMenu(false);
                        moveMany(Array.from(selected), {to: f.name}, folderTitle(f));
                    }}
                    onSpam={() => toSpam(Array.from(selected))}
                    onDelete={() => {
                        // eslint-disable-next-line no-alert
                        if ((current?.role === 'trash' || !trash) && !window.confirm(`Удалить навсегда ${pluralMessages(selected.size)}?`)) {
                            return;
                        }
                        removeMany(Array.from(selected));
                    }}
                />
            )}
            <div className={`mml-mb-header ${selected.size > 0 && list ? 'mml-hidden' : ''}`}>
                <div className='mml-mb-header__row'>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title='Папки (перетащите сюда письмо, чтобы переложить его)'
                        aria-label='Папки'
                        onClick={() => setDrawerOpen(true)}
                        onDragEnter={(e) => {
                            if (isMailDrag(e)) {
                                setDrawerOpen(true);
                            }
                        }}
                        onDragOver={(e) => {
                            if (isMailDrag(e)) {
                                e.preventDefault();
                                setDrawerOpen(true);
                            }
                        }}
                    >
                        <MenuIcon size={22}/>
                    </button>
                    <span className='mml-mb-header__spacer'/>
                    <button
                        type='button'
                        className={`mml-icon-btn mml-icon-btn--lg ${fetching ? 'mml-spin' : ''}`}
                        title='Обновить'
                        aria-label='Обновить'
                        onClick={refresh}
                    >
                        <RefreshIcon size={18}/>
                    </button>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                        title='Написать письмо'
                        aria-label='Написать письмо'
                        onClick={() => openCompose({mode: 'new'})}
                    >
                        <PlusIcon size={24}/>
                    </button>
                </div>
                <div className='mml-mb-header__row'>
                    <button
                        type='button'
                        className='mml-mb-title'
                        onClick={() => setDrawerOpen(true)}
                        title='Выбрать папку'
                    >
                        <span className='mml-ellipsis'>{folderTitle(current, folder)}</span>
                        {unseenCount > 0 && <span className='mml-mb-title__count'>{unseenCount}</span>}
                    </button>
                    <div className='mml-menu-anchor'>
                        <button
                            type='button'
                            className={`mml-icon-btn mml-icon-btn--lg ${filter ? 'mml-icon-btn--on' : ''}`}
                            title='Фильтр'
                            aria-label='Фильтр'
                            aria-expanded={filterMenu}
                            onClick={() => setFilterMenu(!filterMenu)}
                        >
                            <SlidersIcon size={20}/>
                        </button>
                        {filterMenu && (
                            <ul
                                className='mml-menu mml-menu--left'
                                role='menu'
                                onMouseLeave={() => setFilterMenu(false)}
                            >
                                {[{id: '' as const, label: 'Все письма'}, ...FILTERS].map((f) => (
                                    <li key={f.id || 'all'}>
                                        <button
                                            type='button'
                                            role='menuitemradio'
                                            aria-checked={filter === f.id}
                                            className={filter === f.id ? 'mml-menu__item--on' : ''}
                                            onClick={() => {
                                                setFilter(f.id);
                                                setFilterMenu(false);
                                            }}
                                        >
                                            {f.label}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <span className='mml-mb-header__spacer'/>
                    <div className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-icon-btn mml-icon-btn--lg'
                            title='Действия с папкой'
                            aria-label='Действия с папкой'
                            aria-expanded={moreMenu}
                            onClick={() => setMoreMenu(!moreMenu)}
                        >
                            <MoreVerticalIcon size={20}/>
                        </button>
                        {moreMenu && (
                            <ul
                                className='mml-menu'
                                role='menu'
                                onMouseLeave={() => setMoreMenu(false)}
                            >
                                <li>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        disabled={!unseenCount}
                                        onClick={() => folderAction('read')}
                                    >
                                        <CheckAllIcon size={16}/>
                                        {'Прочитать все'}
                                    </button>
                                </li>
                                {list && list.messages.length > 0 && (
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => {
                                                setMoreMenu(false);
                                                setSelected(new Set(list.messages.map((m) => m.uid)));
                                            }}
                                        >
                                            <CheckIcon size={16}/>
                                            {'Выбрать письма'}
                                        </button>
                                    </li>
                                )}
                                {(current?.role === 'trash' || current?.role === 'junk') && (
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            className='mml-menu__item--danger'
                                            disabled={!current.total}
                                            onClick={() => folderAction('empty')}
                                        >
                                            <TrashIcon size={16}/>
                                            {current.role === 'trash' ? 'Очистить корзину' : 'Очистить спам'}
                                        </button>
                                    </li>
                                )}
                                <li>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        onClick={() => {
                                            setMoreMenu(false);
                                            setDrawerCreate(true);
                                            setDrawerOpen(true);
                                        }}
                                    >
                                        <FolderPlusIcon size={16}/>
                                        {'Новая папка'}
                                    </button>
                                </li>
                            </ul>
                        )}
                    </div>
                    <button
                        type='button'
                        className={`mml-icon-btn mml-icon-btn--lg ${searchOpen ? 'mml-icon-btn--on' : ''}`}
                        title='Поиск'
                        aria-label='Поиск'
                        onClick={() => {
                            if (searchOpen) {
                                setQuery('');
                            }
                            setSearchOpen(!searchOpen);
                        }}
                    >
                        <SearchIcon size={20}/>
                    </button>
                </div>
                {searchOpen && (
                    <SearchBox
                        onSearch={setQuery}
                        folderName={folderTitle(current, folder)}
                    />
                )}
                {activeFilter && (
                    <div className='mml-chips mml-mb-header__chips'>
                        <span className='mml-chip mml-chip--on mml-chip--removable'>
                            {activeFilter.label}
                            <button
                                type='button'
                                aria-label='Сбросить фильтр'
                                onClick={() => setFilter('')}
                            >
                                <CloseIcon size={12}/>
                            </button>
                        </span>
                    </div>
                )}
            </div>

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

            <div className='mml-mail-list'>
                {!list && !error && <ListSkeleton/>}
                {list && list.messages.length === 0 && (
                    <div className='mml-empty'>
                        <MailOpenIcon size={36}/>
                        <div className='mml-empty__title'>{(query && 'Ничего не нашлось') || activeFilter?.empty || 'В этой папке пока нет писем'}</div>
                        {query && <div className='mml-muted mml-small'>{'Поиск идёт по отправителю, получателю и теме в текущей папке.'}</div>}
                    </div>
                )}
                {list && list.messages.length > 0 && (
                    <>
                        {(query || filter) && <div className='mml-muted mml-small mml-mail-list__note'>{`Найдено: ${pluralMessages(list.total)}`}</div>}
                        <ul className='mml-messages'>{rows}</ul>
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

            {webUrl && (
                <div className='mml-webmail'>
                    <button
                        type='button'
                        className='mml-webmail__button'
                        onClick={() => openInBrowser(webUrl)}
                        title={webUrl}
                    >
                        {me.provider && guides[me.provider] && (
                            <span
                                className='mml-webmail__badge'
                                style={{background: guides[me.provider].badgeColor}}
                            >
                                {guides[me.provider].badge}
                            </span>
                        )}
                        <span className='mml-ellipsis'>{webmailLabel(me.provider)}</span>
                        <ExternalIcon size={14}/>
                    </button>
                </div>
            )}

            {drawerOpen && (
                <FolderDrawer
                    me={me}
                    folders={folders}
                    current={folder}
                    filter={filter}
                    webUrl={webUrl}
                    startCreate={drawerCreate}
                    dragging={dragging}
                    onChanged={() => {
                        loadFolders();
                        mailChanged();
                    }}
                    onDrop={(f, data) => {
                        setDragging(false);
                        setDrawerOpen(false);
                        if (data.folder === folder) {
                            moveMany(data.uids, {to: f.name}, folderTitle(f));
                        }
                    }}
                    onCreateSpam={async () => {
                        const res = await api.createFolder('Спам');
                        loadFolders();
                        setFilter('');
                        setFolder(res.name);
                    }}
                    onFolder={(name) => {
                        setFilter('');
                        setFolder(name);
                    }}
                    onFilter={(f) => {
                        const inbox = folders?.find((x) => x.role === 'inbox');
                        if (inbox && folder !== inbox.name) {
                            setFolder(inbox.name);
                        }
                        setFilter(f);
                        setDrawerOpen(false);
                    }}
                    onClose={() => {
                        setDrawerOpen(false);
                        setDrawerCreate(false);
                    }}
                />
            )}
        </div>
    );
}

type FolderEdit = {mode: 'create'; parent?: Folder} | {mode: 'rename'; folder: Folder};

function FolderDrawer({me, folders, current, filter, webUrl, startCreate, dragging, onChanged, onDrop, onCreateSpam, onFolder, onFilter, onClose}: {
    me: Me;
    folders: Folder[] | null;
    current: string;
    filter: MessageFilter | '';
    webUrl: string;
    startCreate: boolean;
    dragging: boolean;
    onChanged: () => void;
    onDrop: (f: Folder, data: DragData) => void;
    onCreateSpam: () => Promise<void>;
    onFolder: (name: string) => void;
    onFilter: (f: MessageFilter) => void;
    onClose: () => void;
}) {
    const ref = React.useRef<HTMLElement>(null);
    const [edit, setEdit] = React.useState<FolderEdit | null>(startCreate ? {mode: 'create'} : null);
    const [menuFor, setMenuFor] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [dropOn, setDropOn] = React.useState('');
    React.useEffect(() => {
        if (!startCreate) {
            ref.current?.focus();
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const inboxUnseen = folders?.find((f) => f.role === 'inbox')?.unseen || 0;
    const hasJunk = folders?.some((f) => f.role === 'junk');
    const account: Address = {email: me.email || '', name: me.display_name};

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setError('');
        try {
            await fn();
            setEdit(null);
            onChanged();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const submit = (name: string) => {
        if (!edit) {
            return;
        }
        if (edit.mode === 'rename') {
            if (name === edit.folder.display) {
                setEdit(null);
                return;
            }
            run(() => api.renameFolder(edit.folder.name, name));
        } else {
            run(() => api.createFolder(name, edit.parent?.name || ''));
        }
    };

    const remove = (f: Folder) => {
        setMenuFor('');
        const what = f.total ? ` Письма в ней (${f.total}) будут удалены.` : '';
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Удалить папку «${f.display}»?${what}`)) {
            return;
        }
        run(() => api.deleteFolder(f.name));
    };

    const nameInput = (key: string, depth: number, initial: string, placeholder: string) => (
        <li key={key}>
            <FolderNameInput
                initial={initial}
                placeholder={placeholder}
                depth={depth}
                busy={busy}
                onSubmit={submit}
                onCancel={() => {
                    setEdit(null);
                    setError('');
                }}
            />
        </li>
    );

    // Folders that take dropped messages: any real folder but the open one.
    const dropProps = (f: Folder) => (f.no_select || f.name === current ? {} : {
        onDragOver: (e: React.DragEvent) => {
            if (isMailDrag(e)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropOn(f.name);
            }
        },
        onDragLeave: () => setDropOn((prev) => (prev === f.name ? '' : prev)),
        onDrop: (e: React.DragEvent) => {
            const data = readDrag(e);
            setDropOn('');
            if (data) {
                e.preventDefault();
                onDrop(f, data);
            }
        },
    });

    const items: React.ReactNode[] = [];
    for (const f of folders || []) {
        const on = f.name === current && !filter;
        const custom = !f.role;
        if (edit?.mode === 'rename' && edit.folder.name === f.name) {
            items.push(nameInput(`edit-${f.name}`, f.depth, f.display, 'Название папки'));
        } else {
            items.push(
                <li
                    key={f.name}
                    className={`mml-drawer__row ${dropOn === f.name ? 'mml-drawer__row--drop' : ''}`}
                    {...dropProps(f)}
                >
                    <button
                        type='button'
                        className={`mml-drawer__item ${on ? 'mml-drawer__item--on' : ''}`}
                        style={{paddingLeft: 16 + (f.depth * 28)}}
                        disabled={f.no_select}
                        aria-current={on ? 'page' : undefined}
                        onClick={() => onFolder(f.name)}
                    >
                        <FolderGlyph
                            role={f.role}
                            size={20}
                        />
                        <span className='mml-ellipsis'>{folderTitle(f)}</span>
                        {f.unseen > 0 && <span className='mml-drawer__count'>{f.unseen}</span>}
                    </button>
                    {custom && !dragging && (
                        <div className='mml-menu-anchor mml-drawer__more'>
                            <button
                                type='button'
                                className='mml-icon-btn'
                                title='Действия с папкой'
                                aria-label={`Действия с папкой ${f.display}`}
                                aria-expanded={menuFor === f.name}
                                onClick={() => setMenuFor(menuFor === f.name ? '' : f.name)}
                            >
                                <MoreVerticalIcon size={16}/>
                            </button>
                            {menuFor === f.name && (
                                <ul
                                    className='mml-menu'
                                    role='menu'
                                    onMouseLeave={() => setMenuFor('')}
                                >
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => {
                                                setMenuFor('');
                                                setEdit({mode: 'rename', folder: f});
                                            }}
                                        >
                                            <PenIcon size={16}/>
                                            {'Переименовать'}
                                        </button>
                                    </li>
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onClick={() => {
                                                setMenuFor('');
                                                setEdit({mode: 'create', parent: f});
                                            }}
                                        >
                                            <FolderPlusIcon size={16}/>
                                            {'Вложенная папка'}
                                        </button>
                                    </li>
                                    <li>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            className='mml-menu__item--danger'
                                            onClick={() => remove(f)}
                                        >
                                            <TrashIcon size={16}/>
                                            {'Удалить'}
                                        </button>
                                    </li>
                                </ul>
                            )}
                        </div>
                    )}
                </li>,
            );
        }
        if (edit?.mode === 'create' && edit.parent?.name === f.name) {
            items.push(nameInput(`new-in-${f.name}`, f.depth + 1, '', `Папка в «${f.display}»`));
        }

        // Spam right after the special folders, even if the mailbox has
        // none yet: it is created on the first click.
        if (folders && !hasJunk && f.role && !folders[folders.indexOf(f) + 1]?.role) {
            items.push(
                <li key='virtual-junk'>
                    <button
                        type='button'
                        className='mml-drawer__item'
                        disabled={busy}
                        onClick={() => run(onCreateSpam)}
                    >
                        <SpamIcon size={20}/>
                        <span className='mml-ellipsis'>{'Спам'}</span>
                    </button>
                </li>,
            );
        }
    }

    return (
        <div
            className={`mml-drawer ${dragging ? 'mml-drawer--dragging' : ''}`}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div
                className='mml-drawer__backdrop'
                onClick={onClose}
                onDragOver={(e) => {
                    // Dragging back to the list closes the drawer.
                    if (isMailDrag(e)) {
                        onClose();
                    }
                }}
            />
            <nav
                className='mml-drawer__sheet'
                ref={ref}
                tabIndex={-1}
                aria-label='Папки'
            >
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg mml-drawer__back'
                    aria-label='Закрыть'
                    onClick={onClose}
                >
                    <ArrowLeftIcon size={22}/>
                </button>
                <div className='mml-drawer__account'>
                    <Avatar
                        address={account}
                        avatars={{}}
                        size={44}
                    />
                    <span className='mml-drawer__email mml-ellipsis'>{me.email}</span>
                    {inboxUnseen > 0 && <span className='mml-drawer__total'>{inboxUnseen}</span>}
                </div>
                {dragging && <div className='mml-drawer__hint'>{'Отпустите письмо над папкой'}</div>}
                {!folders && <div className='mml-center'><Spinner/></div>}
                <ul className='mml-drawer__list'>
                    {items}
                    {edit?.mode === 'create' && !edit.parent && nameInput('new-root', 0, '', 'Новая папка')}
                    {folders && !dragging && !(edit?.mode === 'create' && !edit.parent) && (
                        <li>
                            <button
                                type='button'
                                className='mml-drawer__item mml-drawer__item--add'
                                onClick={() => {
                                    setError('');
                                    setEdit({mode: 'create'});
                                }}
                            >
                                <PlusIcon size={20}/>
                                <span>{'Новая папка'}</span>
                            </button>
                        </li>
                    )}
                </ul>
                {error && <div className='mml-drawer__error'>{error}</div>}
                {!dragging && (
                    <>
                        <div className='mml-drawer__section'>{'Фильтр во «Входящих»'}</div>
                        <ul className='mml-drawer__list'>
                            {FILTERS.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type='button'
                                        className={`mml-drawer__item ${filter === f.id ? 'mml-drawer__item--on' : ''}`}
                                        onClick={() => onFilter(f.id)}
                                    >
                                        {f.id === 'unseen' && <span className='mml-drawer__dot'/>}
                                        {f.id === 'flagged' && (
                                            <span className='mml-drawer__flag'>
                                                <BookmarkIcon
                                                    size={20}
                                                    filled={true}
                                                />
                                            </span>
                                        )}
                                        {f.id === 'attachments' && <PaperclipIcon size={20}/>}
                                        <span>{f.drawer}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <div className='mml-drawer__footer'>
                            <button
                                type='button'
                                className='mml-drawer__item'
                                onClick={() => {
                                    onClose();
                                    openWizard('settings');
                                }}
                            >
                                <GearIcon size={20}/>
                                <span>{'Настройки почты'}</span>
                            </button>
                            <button
                                type='button'
                                className='mml-drawer__item'
                                onClick={() => {
                                    onClose();
                                    openRules();
                                }}
                            >
                                <MoveIcon size={20}/>
                                <span>{'Правила сортировки'}</span>
                            </button>
                            {webUrl && (
                                <button
                                    type='button'
                                    className='mml-drawer__item'
                                    onClick={() => openInBrowser(webUrl)}
                                >
                                    <ExternalIcon size={20}/>
                                    <span>{webmailLabel(me.provider)}</span>
                                </button>
                            )}
                        </div>
                    </>
                )}
            </nav>
        </div>
    );
}

function FolderNameInput({initial, placeholder, depth, busy, onSubmit, onCancel}: {
    initial: string;
    placeholder: string;
    depth: number;
    busy: boolean;
    onSubmit: (name: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = React.useState(initial);

    // autoFocus focuses the field in the same commit: the button that
    // opened it is gone, and Mattermost sends keys typed with no focus to
    // the message box.
    return (
        <form
            className='mml-drawer__edit'
            style={{paddingLeft: 16 + (depth * 28)}}
            onSubmit={(e) => {
                e.preventDefault();
                if (value.trim()) {
                    onSubmit(value.trim());
                }
            }}
        >
            <FolderIcon size={20}/>
            <input
                autoFocus={true}
                onFocus={(e) => e.target.select()}
                className='mml-input mml-drawer__input'
                value={value}
                maxLength={100}
                placeholder={placeholder}
                disabled={busy}
                aria-label={placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        onCancel();
                    }
                }}
            />
            <button
                type='submit'
                className='mml-icon-btn mml-icon-btn--accent-plain'
                aria-label='Сохранить'
                disabled={busy || !value.trim()}
            >
                {busy ? <Spinner size={14}/> : <CheckIcon size={18}/>}
            </button>
            <button
                type='button'
                className='mml-icon-btn'
                aria-label='Отмена'
                disabled={busy}
                onClick={onCancel}
            >
                <CloseIcon size={16}/>
            </button>
        </form>
    );
}

// setDragImage shows a compact "letter" under the cursor instead of a
// screenshot of the whole row.
function setDragImage(e: React.DragEvent, label: string) {
    const ghost = document.createElement('div');
    ghost.className = 'mml-drag-ghost';
    ghost.textContent = `✉  ${label}`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    window.setTimeout(() => ghost.remove(), 0);
}

function SelectionBar({count, allSelected, anyUnseen, anyUnflagged, inTrash, inJunk, spamAllowed, folders, moveMenu, onMoveMenu, onClear, onSelectAll, onSeen, onFlag, onMove, onSpam, onDelete}: {
    count: number;
    allSelected: boolean;
    anyUnseen: boolean;
    anyUnflagged: boolean;
    inTrash: boolean;
    inJunk: boolean;
    spamAllowed: boolean;
    folders: Folder[];
    moveMenu: boolean;
    onMoveMenu: (open: boolean) => void;
    onClear: () => void;
    onSelectAll: () => void;
    onSeen: (v: boolean) => void;
    onFlag: (v: boolean) => void;
    onMove: (f: Folder) => void;
    onSpam: () => void;
    onDelete: () => void;
}) {
    return (
        <div
            className='mml-selbar'
            role='toolbar'
            aria-label='Выбранные письма'
        >
            <div className='mml-selbar__row'>
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg'
                    title='Снять выделение (Esc)'
                    aria-label='Снять выделение'
                    onClick={onClear}
                >
                    <CloseIcon size={20}/>
                </button>
                <span className='mml-selbar__count'>{`Выбрано: ${count}`}</span>
                <span className='mml-mb-header__spacer'/>
                <button
                    type='button'
                    className='mml-link mml-small'
                    onClick={onSelectAll}
                >
                    {allSelected ? 'Снять все' : 'Выбрать все'}
                </button>
            </div>
            <div className='mml-selbar__row mml-selbar__actions'>
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg'
                    title={anyUnseen ? 'Прочитано' : 'Не прочитано'}
                    aria-label={anyUnseen ? 'Отметить прочитанными' : 'Отметить непрочитанными'}
                    onClick={() => onSeen(anyUnseen)}
                >
                    {anyUnseen ? <MailOpenIcon size={20}/> : <MailIcon size={20}/>}
                </button>
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg'
                    title={anyUnflagged ? 'Пометить флажком' : 'Снять флажок'}
                    aria-label={anyUnflagged ? 'Пометить флажком' : 'Снять флажок'}
                    onClick={() => onFlag(anyUnflagged)}
                >
                    <BookmarkIcon
                        size={20}
                        filled={!anyUnflagged}
                    />
                </button>
                <div className='mml-menu-anchor'>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title='Переместить в папку'
                        aria-label='Переместить в папку'
                        aria-expanded={moveMenu}
                        onClick={() => onMoveMenu(!moveMenu)}
                    >
                        <MoveIcon size={20}/>
                    </button>
                    {moveMenu && (
                        <ul
                            className='mml-menu mml-menu--left mml-menu--scroll'
                            role='menu'
                            onMouseLeave={() => onMoveMenu(false)}
                        >
                            {folders.map((f) => (
                                <li key={f.name}>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        style={{paddingLeft: 12 + (f.depth * 16)}}
                                        onClick={() => onMove(f)}
                                    >
                                        <FolderGlyph role={f.role}/>
                                        <span className='mml-ellipsis'>{folderTitle(f)}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {spamAllowed && (
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title={inJunk ? 'Не спам' : 'В спам'}
                        aria-label={inJunk ? 'Не спам' : 'В спам'}
                        onClick={onSpam}
                    >
                        {inJunk ? <InboxIcon size={20}/> : <ThumbDownIcon size={20}/>}
                    </button>
                )}
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--danger'
                    title={inTrash ? 'Удалить навсегда' : 'В корзину'}
                    aria-label={inTrash ? 'Удалить навсегда' : 'В корзину'}
                    onClick={onDelete}
                >
                    <TrashIcon size={20}/>
                </button>
            </div>
        </div>
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

function MessageRow({m, avatars, sentFolder, inTrash, inJunk, spamAllowed, active, selected, selecting, onOpen, onSelect, onToggle, onDelete, onSpam, onDragStart, onDragEnd}: {
    m: MessageSummary;
    avatars: Record<string, string>;
    sentFolder: boolean;
    inTrash: boolean;
    inJunk: boolean;
    spamAllowed: boolean;
    active: boolean;
    selected: boolean;
    selecting: boolean;
    onOpen: () => void;
    onSelect: () => void;
    onToggle: (flag: 'seen' | 'flagged') => void;
    onDelete: () => void;
    onSpam: () => void;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
}) {
    // In "Sent" the interesting person is the recipient.
    const person = sentFolder ? m.to[0] : m.from[0];
    const name = sentFolder ? `Кому: ${addressLabel(person) || '—'}` : addressLabel(person) || '(без отправителя)';
    return (
        <li
            className={`mml-message ${m.seen ? '' : 'mml-message--unseen'} ${active ? 'mml-message--active' : ''} ${selected ? 'mml-message--selected' : ''}`}
            draggable={true}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <button
                type='button'
                className={`mml-message__pick ${selecting ? 'mml-message__pick--on' : ''}`}
                title={selected ? 'Снять выделение' : 'Выбрать'}
                aria-label={selected ? 'Снять выделение' : 'Выбрать письмо'}
                aria-pressed={selected}
                onClick={onSelect}
            >
                {selected ? (
                    <span className='mml-message__check'>
                        <CheckIcon size={20}/>
                    </span>
                ) : (
                    <Avatar
                        address={person}
                        avatars={avatars}
                    />
                )}
            </button>
            <button
                type='button'
                className='mml-message__main'
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === ' ' && (e.shiftKey || selecting)) {
                        e.preventDefault();
                        onSelect();
                    }
                }}
            >
                <span className='mml-message__body'>
                    <span className='mml-message__top'>
                        {!m.seen && <span className='mml-message__dot'/>}
                        <span className='mml-message__from mml-ellipsis'>{name}</span>
                        {m.flagged && (
                            <span className='mml-message__flag'>
                                <BookmarkIcon
                                    size={14}
                                    filled={true}
                                />
                            </span>
                        )}
                        {m.has_attachments && (
                            <span
                                className='mml-message__clip'
                                title='Есть вложения'
                            >
                                <PaperclipIcon size={14}/>
                            </span>
                        )}
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
                    {m.preview && <span className='mml-message__preview'>{m.preview}</span>}
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
                    className={`mml-icon-btn ${m.flagged ? 'mml-message__flag' : ''}`}
                    title={m.flagged ? 'Снять флажок' : 'Пометить флажком'}
                    aria-label={m.flagged ? 'Снять флажок' : 'Пометить флажком'}
                    onClick={() => onToggle('flagged')}
                >
                    <BookmarkIcon
                        size={14}
                        filled={m.flagged}
                    />
                </button>
                {spamAllowed && (
                    <button
                        type='button'
                        className='mml-icon-btn'
                        title={inJunk ? 'Не спам — во «Входящие»' : 'В спам'}
                        aria-label={inJunk ? 'Не спам' : 'В спам'}
                        onClick={onSpam}
                    >
                        {inJunk ? <InboxIcon size={14}/> : <ThumbDownIcon size={14}/>}
                    </button>
                )}
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
                        <span
                            className='mml-skeleton'
                            style={{width: `${70 + ((i * 7) % 25)}%`}}
                        />
                    </span>
                </li>
            ))}
        </ul>
    );
}
