import React from 'react';

import {api} from './api';
import type {Attachment, AttachmentRef, Me, MessageRef, PluginConfig, Recipient, WizardMode} from './types';

// A tiny global store shared by the panel, the wizard and websocket
// handlers. Mattermost's own Redux store is left alone on purpose: plugin
// reducers are optional and awkward, and this state is private to the plugin.

// ComposeRequest opens the composer: a new message, a reply or a forward.
export interface ComposeRequest {
    id?: string;

    // 'draft' continues a draft saved in the Drafts folder (source).
    mode: 'new' | 'reply' | 'reply_all' | 'forward' | 'draft';
    source?: MessageRef;
    to?: Recipient[];
    subject?: string;
    text?: string;
    mattermostFiles?: Array<{id: string; name: string; size: number}>;
}

// Everything happens inside the right-hand panel, like in a mobile mail
// app: the message list is always there, and screens are stacked on top
// of it (a message, a reply, settings…). "Back" pops the top screen.
export type Route =
    | {name: 'message'; ref: MessageRef}
    | {name: 'compose'; request: ComposeRequest}
    | {name: 'settings'}
    | {name: 'icon'}
    | {name: 'wizard'; mode: WizardMode}
    | {name: 'share'; ref: MessageRef}
    | {name: 'rules'}
    | {name: 'signature'}
    | {name: 'attachment'; ref: AttachmentRef; list: Attachment[]}
    | {name: 'rule'; rule: SortRuleDraft};

// SortRuleDraft opens the rule editor: a new rule, prefilled e.g. with the
// sender of a message, or an existing one (id).
export interface SortRuleDraft {
    id?: string;
    from?: string;
    folder?: string;
    keepInInbox?: boolean;
}

export interface State {
    me: Me | null;
    config: PluginConfig | null;
    loading: boolean;
    loadError: string;
    routes: Route[];

    // Set when a notification opens a message from another folder.
    folderRequest: {folder: string; nonce: number} | null;

    // Incremented whenever the mailbox may have changed on the server.
    revision: number;

    toast: Toast | null;

    // Set when the icon opened the web mail: the panel shows for a few
    // seconds with a way back to the mail in Mattermost.
    launchpad: number | null;
}

// Toast is a short message at the bottom of the panel, e.g. "Письмо
// отправлено", optionally with one action ("Отменить").
export interface Toast {
    id: number;
    text: string;
    kind?: 'error';
    action?: {label: string; run: () => void};

    // A countdown bar, for "undo send".
    countdown?: number;
}

let state: State = {
    me: null,
    config: null,
    loading: false,
    loadError: '',
    routes: [],
    folderRequest: null,
    revision: 0,
    toast: null,
    launchpad: null,
};

const listeners = new Set<() => void>();

export function getState(): State {
    return state;
}

export function setState(patch: Partial<State>) {
    state = {...state, ...patch};
    listeners.forEach((l) => l());
}

// subscribe calls fn after every change of the state; returns the
// unsubscribe function.
export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function useStore<T>(selector: (s: State) => T): T {
    const [value, setValue] = React.useState(() => selector(state));
    const selectorRef = React.useRef(selector);
    selectorRef.current = selector;

    React.useEffect(() => {
        const listener = () => setValue(() => selectorRef.current(state));
        listeners.add(listener);
        listener();
        return () => {
            listeners.delete(listener);
        };
    }, []);
    return value;
}

let loadPromise: Promise<void> | null = null;

// loadAll fetches the configuration and the connection state.
export function loadAll(force = false): Promise<void> {
    if (loadPromise && !force) {
        return loadPromise;
    }
    setState({loading: true, loadError: ''});
    loadPromise = Promise.all([api.config(), api.me()]).
        then(([config, me]) => {
            setState({config, me, loading: false});
        }).
        catch((e: Error) => {
            setState({loading: false, loadError: e.message});
            loadPromise = null;
        });
    return loadPromise;
}

export async function refreshMe() {
    try {
        const me = await api.me();
        setState({me});
    } catch {
        // Keep the previous state; the panel shows its own errors.
    }
}

export function topRoute(): Route | undefined {
    return state.routes[state.routes.length - 1];
}

// pushRoute opens a screen in the panel; the same screen (the same message,
// the same draft, settings…) is not stacked twice, it is brought to the top.
export function pushRoute(route: Route) {
    const same = (r: Route) => {
        if (r.name !== route.name) {
            return false;
        }
        switch (route.name) {
        case 'message':
            return (r as typeof route).ref.uid === route.ref.uid && (r as typeof route).ref.folder === route.ref.folder;
        case 'compose':
            // Several drafts can be open: each keeps its place in the stack.
            return (r as typeof route).request.id === route.request.id;
        case 'rule':
            return false;
        case 'attachment': {
            const a = (r as typeof route).ref;
            return a.folder === route.ref.folder && a.uid === route.ref.uid && a.part === route.ref.part && a.sub === route.ref.sub;
        }
        }
        return true;
    };
    setState({routes: [...state.routes.filter((r) => !same(r)), route]});
    showPanel();
}

export function popRoute() {
    setState({routes: state.routes.slice(0, -1)});
}

function popWhile(names: Array<Route['name']>) {
    let routes = state.routes;
    while (routes.length && names.includes(routes[routes.length - 1].name)) {
        routes = routes.slice(0, -1);
    }
    setState({routes});
}

export function openWizard(mode: WizardMode) {
    loadAll();
    if (mode === 'settings') {
        pushRoute({name: 'settings'});
    } else if (mode === 'icon') {
        pushRoute({name: 'icon'});
    } else {
        pushRoute({name: 'wizard', mode});
    }
}

export function closeWizard() {
    popWhile(['wizard', 'settings', 'icon']);
}

let composeCounter = 0;

export function openCompose(request: ComposeRequest) {
    loadAll();
    composeCounter++;
    pushRoute({name: 'compose', request: {...request, id: request.id || `c${Date.now()}-${composeCounter}`}});
}

export function closeCompose() {
    popWhile(['compose']);
}

export function openShare(ref: MessageRef) {
    pushRoute({name: 'share', ref});
}

export function closeShare() {
    popWhile(['share']);
}

// openMessage shows a message, e.g. from "Open" in a notification.
export function openMessage(ref: MessageRef) {
    setState({routes: [{name: 'message', ref}], folderRequest: {folder: ref.folder, nonce: Date.now()}});
    showPanel();
}

// mailChanged makes the panel reload the folders and the list.
export function mailChanged() {
    setState({revision: state.revision + 1});
}

// The Mattermost Redux store, for reading the current channel and posts.
let reduxStore: {getState: () => any} | null = null;

export function setReduxStore(store: {getState: () => any}) {
    reduxStore = store;
}

export function getReduxState(): any {
    return reduxStore?.getState() || {};
}

// Set by index.tsx once the right-hand sidebar component is registered.
let showPanel: () => void = () => {};

export function setShowPanel(fn: () => void) {
    showPanel = fn;
}

let hidePanel: () => void = () => {};

export function setHidePanel(fn: () => void) {
    hidePanel = fn;
}

export function closePanel() {
    hidePanel();
}

export function openPanel() {
    showPanel();
}

// openInBrowser opens a web page outside Mattermost. The desktop app hands
// such links to the default browser, the web app opens a new tab.
export function openInBrowser(url: string) {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (win) {
        win.opener = null;
    }
}

let toastId = 0;
let toastTimer: number | undefined;

// showToast shows a toast for `ms` milliseconds and returns its id.
export function showToast(text: string, opts: {kind?: 'error'; action?: Toast['action']; ms?: number; countdown?: number} = {}): number {
    toastId++;
    const id = toastId;
    window.clearTimeout(toastTimer);
    setState({toast: {id, text, kind: opts.kind, action: opts.action, countdown: opts.countdown}});
    toastTimer = window.setTimeout(() => hideToast(id), opts.ms || 4000);
    return id;
}

export function hideToast(id?: number) {
    if (id === undefined || state.toast?.id === id) {
        setState({toast: null});
    }
}

export function openRules() {
    pushRoute({name: 'rules'});
}

// openRule opens the editor of a sorting rule on top of the panel.
export function openRule(rule: SortRuleDraft = {}) {
    setState({routes: [...state.routes.filter((r) => r.name !== 'rule'), {name: 'rule', rule}]});
    showPanel();
}

export function closeRule() {
    popWhile(['rule']);
}

// openSignature opens the signature editor on top of the settings.
export function openSignature() {
    pushRoute({name: 'signature'});
}

export function closeSignature() {
    popWhile(['signature']);
}

// openAttachment shows an attachment in the panel; list holds the other
// attachments of the message for paging.
export function openAttachment(ref: AttachmentRef, list: Attachment[]) {
    pushRoute({name: 'attachment', ref, list});
}

// pageAttachment shows another attachment in place of the open one.
export function pageAttachment(ref: AttachmentRef, list: Attachment[]) {
    const routes = state.routes.slice(0, -1);
    setState({routes: [...routes, {name: 'attachment', ref, list}]});
}

export function closeAttachment() {
    popWhile(['attachment']);
}
