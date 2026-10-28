import React from 'react';
import type {Store} from 'redux';

import type {GlobalState} from '@mattermost/types/store';

import manifest from 'manifest';

import {MailIcon} from './components/icons';
import Panel, {PanelTitle} from './components/Panel';
import UpdatePanel from './components/UpdatePanel';
import {
    getState, loadAll, mailChanged, openCompose, openInBrowser, openMessage, openWizard,
    refreshMe, setHidePanel, setReduxStore, setShowPanel, setState, subscribe,
} from './state';
import './styles.scss';
import type {WizardMode} from './types';

type AnyRegistry = Record<string, any>;

interface RHSHandles {
    showRHSPlugin: unknown;
    hideRHSPlugin: unknown;
    toggleRHSPlugin: unknown;
}

const TOOLTIP = 'Почта';

function iconUrl() {
    return `${window.basename || ''}/plugins/${manifest.id}/public/app-bar-icon.svg`;
}

// registerPanel puts the mail icon into the App Bar (the right-hand icon
// strip), or into the channel header on servers without an App Bar.
//
// The click is handled by the plugin rather than wired to the panel by
// Mattermost, because every user decides what the icon opens: the mail
// panel or the web mail in the browser.
function registerPanel(registry: AnyRegistry, store: Store<GlobalState>): RHSHandles {
    const rhs = registry.registerRightHandSidebarComponent(Panel, <PanelTitle/>) as RHSHandles;
    const onClick = () => {
        const icon = getState().me?.icon;
        if (icon?.action === 'browser' && icon.web_url) {
            openInBrowser(icon.web_url);

            // A way back: for a few seconds the panel offers to read the
            // mail in Mattermost or to change what the icon opens.
            setState({launchpad: Date.now()});
            store.dispatch(rhs.showRHSPlugin as any);
            return;
        }
        store.dispatch(rhs.toggleRHSPlugin as any);
    };

    if (typeof registry.registerAppBarComponent === 'function') {
        registry.registerAppBarComponent(iconUrl(), onClick, TOOLTIP);
    } else {
        registry.registerChannelHeaderButtonAction(<MailIcon size={18}/>, onClick, TOOLTIP, TOOLTIP);
    }
    return rhs;
}

// composeFromPost prepares an e-mail from a Mattermost message: the first
// line becomes the subject, the files are attached.
function composeFromPost(store: Store<GlobalState>, postId: string) {
    const state = store.getState() as any;
    const post = state?.entities?.posts?.posts?.[postId];
    const message: string = post?.message || '';
    const siteUrl: string = state?.entities?.general?.config?.SiteURL || window.location.origin;
    const firstLine = message.split('\n').find((l: string) => l.trim()) || '';
    const subject = firstLine.replace(/[#*_`>~]/g, '').trim().slice(0, 80);
    const fileIds: string[] = post?.file_ids || state?.entities?.files?.fileIdsByPostId?.[postId] || [];
    const files = fileIds.
        map((id) => state?.entities?.files?.files?.[id]).
        filter(Boolean).
        map((f: any) => ({id: f.id, name: f.name, size: f.size || 0}));
    const link = `${siteUrl}/_redirect/pl/${postId}`;
    openCompose({
        mode: 'new',
        subject,
        text: message ? `${message}\n\nОбсуждение в Mattermost: ${link}` : `Обсуждение в Mattermost: ${link}`,
        mattermostFiles: files,
    });
}

// updateIconBadge puts the number of unread messages in Inbox on the
// mail icon. Mattermost has no badges for plugin icons, so styles.scss
// draws it next to the icon (found by its alt, the plugin id) from two
// values on the root element. Without them the icon stays neutral.
let shownUnread = -1;

function updateIconBadge() {
    const me = getState().me;
    const unread = me?.connected ? me.sync?.unseen || 0 : 0;
    if (unread === shownUnread) {
        return;
    }
    shownUnread = unread;
    const root = document.documentElement;
    if (unread > 0) {
        root.style.setProperty('--mml-unread', `"${unread > 99 ? '99+' : unread}"`);
        root.classList.add('mml-has-unread');
    } else {
        root.style.removeProperty('--mml-unread');
        root.classList.remove('mml-has-unread');
    }
}

export default class Plugin {
    public async initialize(registry: AnyRegistry, store: Store<GlobalState>) {
        setReduxStore(store);
        const rhs = registerPanel(registry, store);
        setShowPanel(() => store.dispatch(rhs.showRHSPlugin as any));
        setHidePanel(() => store.dispatch(rhs.hideRHSPlugin as any));

        if (typeof registry.registerAdminConsoleCustomSetting === 'function') {
            registry.registerAdminConsoleCustomSetting('UpdatePanel', UpdatePanel, {showTitle: true});
        }

        // "Send by e-mail" in the message menu. The item is shown to
        // everyone, because the connection state may not be loaded yet when
        // the menu opens; without a mailbox it opens the wizard.
        if (typeof registry.registerPostDropdownMenuAction === 'function') {
            registry.registerPostDropdownMenuAction(
                'Отправить по почте',
                (postId: string) => {
                    refreshMe();
                    if (getState().me?.connected === false) {
                        openWizard('connect');
                        return;
                    }
                    composeFromPost(store, postId);
                },
                (postId: string) => {
                    const post = (store.getState() as any)?.entities?.posts?.posts?.[postId];
                    return !post?.type?.startsWith('system_');
                },
            );
        }

        const prefix = `custom_${manifest.id}_`;
        registry.registerWebSocketEventHandler(`${prefix}config_changed`, () => {
            refreshMe();
        });
        registry.registerWebSocketEventHandler(`${prefix}mail_updated`, () => {
            refreshMe();
            mailChanged();
        });
        registry.registerWebSocketEventHandler(`${prefix}open_wizard`, (msg: {data?: {mode?: WizardMode}}) => {
            openWizard(msg.data?.mode === 'settings' ? 'settings' : 'connect');
        });
        registry.registerWebSocketEventHandler(`${prefix}open_compose`, (msg: {data?: {to?: string}}) => {
            const to = msg.data?.to;
            openCompose({mode: 'new', to: to ? [{email: to}] : undefined});
        });
        registry.registerWebSocketEventHandler(`${prefix}open_message`, (msg: {data?: {folder?: string; uid?: number}}) => {
            if (msg.data?.folder && msg.data.uid) {
                openMessage({folder: msg.data.folder, uid: msg.data.uid});
            }
        });
        registry.registerWebSocketEventHandler(`${prefix}open_panel`, () => {
            // "/mail" opens the mail itself, also for users whose icon opens
            // the web mail.
            setState({launchpad: null});
            store.dispatch(rhs.showRHSPlugin as any);
        });
        registry.registerReconnectHandler(() => {
            loadAll(true);
        });

        // Warm up so that the panel opens instantly, and the icon shows
        // the number of unread messages from the start.
        loadAll();
        subscribe(updateIconBadge);
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
