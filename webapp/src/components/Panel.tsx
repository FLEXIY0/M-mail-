import React from 'react';

import Composer from './Composer';
import {
    ArchiveIcon, ArrowLeftIcon, BellIcon, BookmarkIcon, CloseIcon, DraftIcon, ExternalIcon, FolderIcon,
    GearIcon, InboxIcon, MailIcon, MailOpenIcon, MenuIcon, PaperclipIcon, PlusIcon, RefreshIcon,
    ReplyIcon, SearchIcon, SendIcon, SlidersIcon, SpamIcon, Spinner, TrashIcon,
} from './icons';
import IconSettingsDialog from './IconSettings';
import MessageView from './MessageView';
import SettingsDialog from './SettingsDialog';
import {ErrorCard} from './shared';
import ShareDialog from './ShareDialog';
import {Button, Callout} from './ui';
import WizardRoot from './Wizard';

import type {ApiError} from '../api';
import {api} from '../api';
import {addressLabel, avatarColor, dateGroup, formatListDate, initials, pluralMessages} from '../format';
import {guides} from '../guides';
import {loadAll, openCompose, openInBrowser, openWizard, pushRoute, refreshMe, setState, useStore} from '../state';
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
        </div>
    );
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
    const requestId = React.useRef(0);

    const setFolder = (name: string) => {
        setFolderState(name);
        saveFolder(name);
        setQuery('');
        setSearchOpen(false);
        setList(null);
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
    const dropMessage = (uid: number) => {
        setList((prev) => prev && {...prev, messages: prev.messages.filter((m) => m.uid !== uid), total: Math.max(prev.total - 1, 0)});
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
                active={opened?.ref.uid === m.uid && opened.ref.folder === folder}
                onOpen={() => pushRoute({name: 'message', ref: {folder, uid: m.uid}})}
                onToggle={(flag) => toggleFlag(m, flag)}
                onDelete={() => remove(m)}
            />,
        );
    }

    return (
        <div className='mml-panel mml-mailbox'>
            <div className='mml-mb-header'>
                <div className='mml-mb-header__row'>
                    <button
                        type='button'
                        className='mml-icon-btn mml-icon-btn--lg'
                        title='Папки'
                        aria-label='Папки'
                        onClick={() => setDrawerOpen(true)}
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
                    onClose={() => setDrawerOpen(false)}
                />
            )}
        </div>
    );
}

function FolderDrawer({me, folders, current, filter, webUrl, onFolder, onFilter, onClose}: {
    me: Me;
    folders: Folder[] | null;
    current: string;
    filter: MessageFilter | '';
    webUrl: string;
    onFolder: (name: string) => void;
    onFilter: (f: MessageFilter) => void;
    onClose: () => void;
}) {
    const ref = React.useRef<HTMLElement>(null);
    React.useEffect(() => {
        ref.current?.focus();
    }, []);
    const inboxUnseen = folders?.find((f) => f.role === 'inbox')?.unseen || 0;
    const account: Address = {email: me.email || '', name: me.display_name};
    return (
        <div
            className='mml-drawer'
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
                {!folders && <div className='mml-center'><Spinner/></div>}
                <ul className='mml-drawer__list'>
                    {folders?.map((f) => {
                        const on = f.name === current && !filter;
                        return (
                            <li key={f.name}>
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
                            </li>
                        );
                    })}
                </ul>
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
            </nav>
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

function MessageRow({m, avatars, sentFolder, inTrash, active, onOpen, onToggle, onDelete}: {
    m: MessageSummary;
    avatars: Record<string, string>;
    sentFolder: boolean;
    inTrash: boolean;
    active: boolean;
    onOpen: () => void;
    onToggle: (flag: 'seen' | 'flagged') => void;
    onDelete: () => void;
}) {
    // In "Sent" the interesting person is the recipient.
    const person = sentFolder ? m.to[0] : m.from[0];
    const name = sentFolder ? `Кому: ${addressLabel(person) || '—'}` : addressLabel(person) || '(без отправителя)';
    return (
        <li className={`mml-message ${m.seen ? '' : 'mml-message--unseen'} ${active ? 'mml-message--active' : ''}`}>
            <button
                type='button'
                className='mml-message__main'
                onClick={onOpen}
            >
                <Avatar
                    address={person}
                    avatars={avatars}
                />
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
